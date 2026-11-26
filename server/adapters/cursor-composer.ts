import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankSession, digest, identity, project } from './common';
import { cursorMessage, cursorTime } from './cursor-message';
import { object, text } from './local-files';
import { hasTable, sqliteRevision, withSqliteSnapshot } from './sqlite-snapshot';
import type { Candidate, ImportedMessage } from './types';

const MAX_VALUE = 32_000_000, MAX_BUBBLE = 8_000_000, MAX_MESSAGES = 50_000, MAX_BYTES = 64_000_000;
function decode(value: unknown) {
  return object(JSON.parse(typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '{}'));
}
function directory(raw: any): string {
  const value = text(raw.workspaceIdentifier?.uri?.path) || text(raw.workspaceIdentifier?.uri) || text(raw.cwd);
  try { return value.startsWith('file:') ? fileURLToPath(value) : isAbsolute(value) ? value : ''; } catch { return ''; }
}

export function discoverComposers(path: string, workspace = '') {
  const snapshot = sqliteRevision(path);
  return withSqliteSnapshot(path, db => {
    const sessions: Candidate[] = [], warnings: string[] = [];
    for (const table of ['cursorDiskKV', 'ItemTable']) {
      if (!hasTable(db, table)) continue;
      let failed = 0, count = 0;
      // Cursor also keeps NULL-valued internal markers in this key range.
      const rows = db.prepare(`SELECT key, CASE WHEN length(value)<=? THEN value END AS value FROM ${table} WHERE key LIKE 'composerData:%' AND value IS NOT NULL ORDER BY key LIMIT 20001`).iterate(MAX_VALUE);
      for (const row of rows) {
        if (++count > 20_000) { warnings.push('Cursor Composer listing reached its 20,000-session limit.'); break; }
        try {
          if (row.value == null) throw new Error('Oversized Composer.');
          const data = decode(row.value), nativeID = text(data.composerId);
          if (!nativeID || row.key !== `composerData:${nativeID}`) throw new Error('Composer identity mismatch.');
          const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : Array.isArray(data.conversation) ? data.conversation : [];
          if (!headers.length) continue; // Empty drafts do not establish a conversation.
          const session = blankSession('cursor', nativeID, directory(data) || workspace);
          session.created = cursorTime(data.createdAt);
          if (!session.created) continue; // Never put an entire legacy database at its current file time.
          session.updated = cursorTime(data.lastUpdatedAt) || session.created;
          session.title = text(data.name).slice(0, 300) || 'Cursor Composer session';
          session.agent = 'Cursor Composer'; session.model = text(data.modelConfig?.modelName) || 'Unknown model';
          session.archived = data.isArchived === true;
          // Only explicit subagent membership establishes child relationships.
          const children = Array.isArray(data.subagentComposerIds) ? data.subagentComposerIds.filter((id: unknown) => typeof id === 'string') : [];
          sessions.push({ session, revision: digest([2, snapshot, table, nativeID]), locator: { path, kind: 'composer', table, snapshot, nativeID, children: JSON.stringify(children) } });
        } catch { failed++; }
      }
      if (failed) warnings.push(`${failed} legacy Cursor Composer records were unreadable or oversized; saved imports are retained.`);
    }
    const parents = new Map<string, Set<string>>();
    for (const c of sessions) for (const id of JSON.parse(c.locator.children)) {
      const found = parents.get(id) || new Set<string>(); found.add(c.session.nativeID!); parents.set(id, found);
    }
    for (const c of sessions) {
      const found = parents.get(c.session.nativeID!);
      if (found?.size === 1 && !found.has(c.session.nativeID!)) c.session.parentID = identity('cursor', [...found][0]);
      c.session.projectID = project('cursor', c.session.directory).id;
      c.revision = digest([c.revision, c.session.directory, c.session.parentID]);
    }
    return { sessions, warnings };
  }, snapshot);
}

export function readComposer(candidate: Candidate) {
  const { path, table, nativeID, snapshot } = candidate.locator;
  if (!['cursorDiskKV', 'ItemTable'].includes(table)) throw new Error('Unsupported Composer table.');
  return withSqliteSnapshot(path, db => {
    const get = db.prepare(`SELECT value FROM ${table} WHERE key=? AND length(value)<=?`);
    const row = get.get(`composerData:${nativeID}`, MAX_VALUE);
    if (!row) throw new Error('Composer history is unavailable.');
    const data = decode(row.value), messages: ImportedMessage[] = [];
    const records = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : data.conversation;
    if (!Array.isArray(records)) throw new Error('Unsupported Composer history.');
    let bytes = 0, partial = false;
    for (const [index, header] of records.entries()) {
      if (index >= MAX_MESSAGES || bytes >= MAX_BYTES) { partial = true; break; }
      try {
        const id = text(header.bubbleId);
        const stored = id ? get.get(`bubbleId:${nativeID}:${id}`, MAX_BUBBLE) : undefined;
        if (stored) bytes += typeof stored.value === 'string' ? Buffer.byteLength(stored.value) : (stored.value as Uint8Array).byteLength;
        const raw = stored ? { ...header, ...decode(stored.value) } : { ...header, ...object(data.conversationMap?.[id]) };
        if (![1, 2].includes(raw.type)) { partial = true; continue; }
        if (typeof raw.text !== 'string') { partial = true; continue; }
        const content: unknown[] = [{ type: 'text', text: raw.text }];
        if (typeof raw.thinking?.text === 'string') content.push({ type: 'thinking', thinking: raw.thinking.text });
        const message = cursorMessage({ id: id || `bubble:${index}`, role: raw.type === 1 ? 'user' : 'assistant', timestamp: cursorTime(raw.createdAt) || cursorTime(raw.timingInfo?.clientStartTime), content }, `bubble:${index}`);
        if (message) messages.push(message);
      } catch { partial = true; }
    }
    if (!messages.length) throw new Error('Composer has no readable message bodies; saved imports are retained.');
    return { messages, partial: true, note: `Legacy Cursor Composer conversation order and native bubble IDs. Original creation dates are preserved; absent message timestamps remain unknown. Tool internals, attachments, encrypted bodies, and file snapshots are unavailable.${partial ? ' Some missing, unsupported, or bounded bubbles were omitted.' : ''}` };
  }, snapshot);
}
