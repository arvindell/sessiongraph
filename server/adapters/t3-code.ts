import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sourcePath } from '../source-paths';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addText, blankMessage, blankSession, digest, identity, project } from './common';
import type { Candidate, ImportedMessage, SessionAdapter } from './types';
import { hasTable, sqliteRevision, withSqliteSnapshot, SqliteSnapshotChangedError } from './sqlite-snapshot';
import { eventFor, eventText, messageEvent } from '../events';
import type { TimelineEvent } from '@sessiongraph/core/timeline';

type Row = Record<string, unknown>;
const SOURCE = 't3-code';
const PAGE = 100;
const MAX_THREADS = 20_000;
// A page is at most 25.6 MB before normalized text/event limits apply.
const MAX_ITEM_JSON = 256_000;
const providerSource: Record<string, string> = { codex: 'codex', claudeAgent: 'claude-code', opencode: 'opencode' };

const string = (value: unknown) => typeof value === 'string' ? value : '';
function parsedObject(value: unknown): Row | undefined {
  if (typeof value !== 'string') return;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : undefined; }
  catch { return; }
}
function time(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8_640_000_000_000_000 ? parsed : 0;
}
function status(value: unknown): TimelineEvent['status'] {
  return ['pending', 'running', 'completed', 'failed'].includes(string(value)) ? value as TimelineEvent['status'] : 'unknown';
}

async function databasePath(): Promise<string | undefined> {
  const root = sourcePath('t3-code') || process.env.SESSIONGRAPH_T3_CODE_HISTORY_DIR || process.env.T3CODE_HOME || join(homedir(), '.t3');
  const paths = /\.sqlite$/.test(root) ? [root] : [
    join(root, 'userdata', 'statev2.sqlite'), join(root, 'statev2.sqlite'),
    join(root, 'userdata', 'state.sqlite'), join(root, 'state.sqlite'),
  ];
  for (const path of paths) {
    try { if ((await lstat(path)).isFile()) return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function batches<T>(values: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function projectRoots(db: DatabaseSync, ids: string[]): Map<string, string> {
  const roots = new Map<string, string>();
  if (!hasTable(db, 'projection_projects')) return roots;
  for (const batch of batches([...new Set(ids.filter(Boolean))])) {
    const placeholders = batch.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT project_id, substr(workspace_root,1,4096) AS workspace_root FROM projection_projects WHERE deleted_at IS NULL AND project_id IN (${placeholders})`).all(...batch))
      roots.set(string(row.project_id), string(row.workspace_root));
  }
  return roots;
}

function aggregates(db: DatabaseSync, table: string, ids: string[]): Map<string, [number, string]> {
  const result = new Map<string, [number, string]>();
  if (!hasTable(db, table)) return new Map();
  for (const batch of batches(ids)) {
    const placeholders = batch.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT thread_id, COUNT(*) AS n, MAX(updated_at) AS latest FROM ${table} WHERE thread_id IN (${placeholders}) GROUP BY thread_id`).all(...batch))
      result.set(string(row.thread_id), [Number(row.n), string(row.latest)]);
  }
  return result;
}

function linkedSessions(db: DatabaseSync, ids: string[]): Map<string, string[]> {
  const links = new Map<string, string[]>();
  if (!hasTable(db, 'orchestration_v2_projection_provider_threads')) return links;
  for (const batch of batches(ids)) {
    const placeholders = batch.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT thread_id, provider,
      CASE WHEN json_valid(payload_json) THEN substr(json_extract(payload_json,'$.nativeThreadRef.nativeId'),1,513) END AS native_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.nativeThreadRef.strength') END AS strength,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.nativeThreadRef.driver') END AS driver
      FROM orchestration_v2_projection_provider_threads WHERE thread_id IN (${placeholders})`).all(...batch)) {
      const source = providerSource[string(row.provider)];
      const nativeID = string(row.native_id);
      if (!source || row.strength !== 'strong' || (row.driver && row.driver !== row.provider) || !nativeID || nativeID.length > 512) continue;
      const id = string(row.thread_id);
      links.set(id, [...new Set([...(links.get(id) || []), identity(source, nativeID)])]);
    }
  }
  return links;
}

function discoverV2(db: DatabaseSync, path: string, databaseRevision: string) {
  if (!hasTable(db, 'orchestration_v2_projection_threads') || !hasTable(db, 'orchestration_v2_projection_turn_items')) throw new Error('Unsupported T3 Code database schema.');
  const rows = db.prepare(`SELECT thread_id, project_id, substr(title,1,300) AS title, default_provider, created_at, updated_at, archived_at,
    CASE WHEN json_valid(payload_json) THEN substr(json_extract(payload_json,'$.worktreePath'),1,4096) END AS worktree_path,
    CASE WHEN json_valid(payload_json) THEN substr(json_extract(payload_json,'$.modelSelection.model'),1,200) END AS model,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.lineage.parentThreadId') END AS parent_thread_id,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.lineage.relationshipToParent') END AS relationship,
    json_valid(payload_json) AS valid_payload
    FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY created_at, thread_id LIMIT ?`).all(MAX_THREADS + 1);
  const selected = rows.slice(0, MAX_THREADS), ids = selected.map((row) => string(row.thread_id));
  const roots = projectRoots(db, selected.map((row) => string(row.project_id)));
  const counts = aggregates(db, 'orchestration_v2_projection_messages', ids);
  const items = aggregates(db, 'orchestration_v2_projection_turn_items', ids);
  const links = linkedSessions(db, ids);
  const sessions: Candidate[] = [], projects = new Map<string, ReturnType<typeof project>>(), warnings: string[] = [];
  if (rows.length > MAX_THREADS) warnings.push(`T3 Code discovery is limited to ${MAX_THREADS.toLocaleString()} threads.`);
  let unreadableMetadata = 0;
  for (const row of selected) {
    const nativeID = string(row.thread_id), created = time(row.created_at);
    if (!nativeID || nativeID.length > 512 || !created) continue;
    if (!row.valid_payload) unreadableMetadata++;
    const directory = string(row.worktree_path) || roots.get(string(row.project_id)) || '';
    const p = project(SOURCE, directory); projects.set(p.id, p);
    const session = blankSession(SOURCE, nativeID, directory);
    const parent = string(row.parent_thread_id);
    session.parentID = row.relationship === 'subagent' && parent ? identity(SOURCE, parent) : undefined;
    session.forkID = row.relationship === 'fork' && parent ? identity(SOURCE, parent) : undefined;
    Object.assign(session, { title: string(row.title) || 'T3 Code thread', projectID: p.id, created,
      updated: time(row.updated_at) || created, archived: Boolean(row.archived_at),
      model: string(row.model) || 'Unknown model', provider: string(row.default_provider), agent: 'T3 Code',
      linkedSessionIDs: links.get(nativeID) || [] });
    const revision = digest([row.updated_at, counts.get(nativeID), items.get(nativeID), links.get(nativeID)]);
    sessions.push({ session, revision, locator: { path, databaseRevision, threadID: nativeID, format: 'v2', metadataPartial: row.valid_payload ? '' : '1' } });
  }
  if (unreadableMetadata) warnings.push(`${unreadableMetadata} T3 Code threads had unreadable metadata; model or lineage may be unavailable.`);
  return { sessions, projects: [...projects.values()], warnings };
}

function discoverV1(db: DatabaseSync, path: string, databaseRevision: string) {
  if (!hasTable(db, 'projection_threads') || !hasTable(db, 'projection_thread_messages')) throw new Error('Unsupported T3 Code database schema.');
  const rows = db.prepare(`SELECT thread_id, project_id, substr(title,1,300) AS title, substr(worktree_path,1,4096) AS worktree_path,
    created_at, updated_at, archived_at,
    CASE WHEN json_valid(model_selection_json) THEN substr(json_extract(model_selection_json,'$.model'),1,200) END AS model
    FROM projection_threads WHERE deleted_at IS NULL ORDER BY created_at, thread_id LIMIT ?`).all(MAX_THREADS + 1);
  const selected = rows.slice(0, MAX_THREADS);
  const roots = projectRoots(db, selected.map((row) => string(row.project_id)));
  const counts = aggregates(db, 'projection_thread_messages', selected.map((row) => string(row.thread_id)));
  const sessions: Candidate[] = [], projects = new Map<string, ReturnType<typeof project>>();
  for (const row of selected) {
    const nativeID = string(row.thread_id), created = time(row.created_at);
    if (!nativeID || nativeID.length > 512 || !created) continue;
    const directory = string(row.worktree_path) || roots.get(string(row.project_id)) || '';
    const p = project(SOURCE, directory); projects.set(p.id, p);
    const session = blankSession(SOURCE, nativeID, directory);
    Object.assign(session, { title: string(row.title) || 'T3 Code thread', projectID: p.id, created,
      updated: time(row.updated_at) || created, archived: Boolean(row.archived_at),
      model: string(row.model) || 'Unknown model', agent: 'T3 Code' });
    sessions.push({ session, revision: digest([row.updated_at, counts.get(nativeID)]), locator: { path, databaseRevision, threadID: nativeID, format: 'v1' } });
  }
  const warnings = ['Legacy T3 Code V1 stores text conversations but has limited event and provider-link coverage.'];
  if (rows.length > MAX_THREADS) warnings.push(`T3 Code discovery is limited to ${MAX_THREADS.toLocaleString()} threads.`);
  return { sessions, projects: [...projects.values()], warnings };
}

function v2Message(row: Row, directory: string): ImportedMessage {
  const parsed = parsedObject(row.payload_json), item = parsed || {}, type = string(row.type), id = string(row.turn_item_id);
  const role = type === 'user_message' ? 'user' : type === 'assistant_message' ? 'assistant' : type === 'reasoning' ? 'assistant' : 'tool';
  const message = blankMessage(`item:${id}`, time(item.startedAt || item.createdAt), role);
  const recorded = Boolean(message.time), name = string(item.title || item.toolName) || type.replaceAll('_', ' ');
  const fields: Partial<TimelineEvent> = { nativeID: id, nativeType: type, parentID: string(item.parentItemId) || undefined,
    status: status(row.status), endTime: time(item.completedAt) || null, timeSource: recorded ? 'recorded' : 'unknown' };
  if (!parsed) {
    message.partial = true;
    message.events = [eventFor(message, id, 'event', name, 'Oversized or unreadable T3 item omitted.', { ...fields, partial: true })];
    return message;
  }
  if (type === 'user_message' || type === 'assistant_message') {
    const body = string(item.text);
    if (body) addText(message, body, role === 'user' ? 'You' : 'Assistant');
    message.events = [{ ...messageEvent(message, body, id), ...fields }];
    if (Array.isArray(item.attachments) && item.attachments.length) message.partial = true;
    return message;
  }
  if (type === 'reasoning') {
    message.events = [eventFor(message, id, 'reasoning', 'Recorded reasoning', string(item.text), fields)];
    return message;
  }
  if (type === 'file_change') {
    const file = string(item.fileName), completed = status(row.status) === 'completed';
    if (file && completed) message.files.push({ path: isAbsolute(file) ? file : join(directory, file), source: 'file change', steps: 1 });
    message.events = [eventFor(message, id, 'file_change', file || name, '', fields)];
    return message;
  }
  if (['command_execution', 'dynamic_tool', 'file_search', 'web_search'].includes(type)) {
    const input = eventText(item.input ?? item.pattern ?? item.patterns, 32_000);
    const output = eventText(item.output ?? item.results, 64_000);
    const kind = fields.status === 'completed' || fields.status === 'failed' ? 'tool_result' : 'tool_call';
    message.tools.push(name);
    if (input) addText(message, input, 'Tool');
    if (output) addText(message, output, 'Tool');
    message.events = [eventFor(message, id, kind, name, '', { ...fields, input, output })];
    return message;
  }
  const kind = type === 'compaction' ? 'compaction' : type === 'error' ? 'error' : 'event';
  message.events = [eventFor(message, id, kind, name, string(item.text), fields)];
  return message;
}

function readV2(db: DatabaseSync, candidate: Candidate, cursor?: string) {
  let ordinal = -1, id = '';
  if (cursor) {
    const separator = cursor.indexOf(':');
    ordinal = Number(cursor.slice(0, separator)); id = cursor.slice(separator + 1);
    if (separator < 1 || !Number.isSafeInteger(ordinal) || !id) throw new Error('Invalid T3 Code history cursor.');
  }
  const rows = db.prepare(`SELECT turn_item_id, ordinal, type, status,
    CASE WHEN length(payload_json)<=? THEN payload_json END AS payload_json
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id=? AND (ordinal>? OR (ordinal=? AND turn_item_id>?))
    ORDER BY ordinal, turn_item_id LIMIT ?`).all(MAX_ITEM_JSON, candidate.locator.threadID, ordinal, ordinal, id, PAGE + 1);
  const page = rows.slice(0, PAGE), last = page.at(-1);
  return { messages: page.map((row) => v2Message(row, candidate.session.directory)),
    cursor: rows.length > PAGE && last ? `${last.ordinal}:${last.turn_item_id}` : undefined,
    partial: candidate.locator.metadataPartial === '1' || page.some((row) => !parsedObject(row.payload_json)),
    note: 'T3 Code app-owned messages and activity. Attachments and checkpoint file snapshots are not imported; provider-native histories may contain additional detail.' };
}

function readV1(db: DatabaseSync, candidate: Candidate, cursor?: string) {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid T3 Code history cursor.');
  const rows = db.prepare(`SELECT message_id, role, created_at,
    CASE WHEN length(text)<=? THEN text END AS text FROM projection_thread_messages
    WHERE thread_id=? ORDER BY created_at, message_id LIMIT ? OFFSET ?`).all(MAX_ITEM_JSON, candidate.locator.threadID, PAGE + 1, offset);
  const messages = rows.slice(0, PAGE).map((row) => {
    const role = row.role === 'user' ? 'user' : row.role === 'assistant' ? 'assistant' : 'system';
    const message = blankMessage(`message:${row.message_id}`, time(row.created_at), role);
    const body = string(row.text);
    if (body) addText(message, body, role === 'user' ? 'You' : 'Assistant');
    message.events = [{ ...messageEvent(message, body), nativeID: string(row.message_id), nativeType: 'legacy-message' }];
    message.partial = row.text == null;
    return message;
  });
  return { messages, cursor: rows.length > PAGE ? String(offset + PAGE) : undefined, partial: true,
    note: 'Legacy T3 Code text messages only. Tool activity, attachments, and provider links are unavailable.' };
}

export const t3CodeAdapter: SessionAdapter = {
  id: SOURCE, name: 'T3 Code', description: 'Local T3 server threads and saved activity · no running agent required',
  capabilities: { history: true, forks: true, children: true, files: true },
  async detect() { return Boolean(await databasePath()); },
  async discover() {
    const path = await databasePath();
    if (!path) return { sessions: [], projects: [], warnings: ['T3 Code database is unavailable. Saved history is retained.'] };
    for (let attempt = 0; ; attempt++) {
      const databaseRevision = sqliteRevision(path);
      try {
        return withSqliteSnapshot(path, (db) => hasTable(db, 'orchestration_v2_projection_threads')
          ? discoverV2(db, path, databaseRevision) : discoverV1(db, path, databaseRevision), databaseRevision);
      } catch (error) {
        if (!(error instanceof SqliteSnapshotChangedError) || attempt >= 2) throw error;
      }
    }
  },
  async read(candidate, cursor) {
    return withSqliteSnapshot(candidate.locator.path, (db) => candidate.locator.format === 'v2'
      ? readV2(db, candidate, cursor) : readV1(db, candidate, cursor), candidate.locator.databaseRevision, true);
  },
};
