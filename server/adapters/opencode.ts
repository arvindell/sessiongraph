import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '@sessiongraph/core/types';
import { summarizeMessages, type RawMessage } from '../opencode';
import { extractContent } from '../search';
import { blankSession, digest, identity, project } from './common';
import type { Candidate, ImportedMessage, SessionAdapter } from './types';
import { opencodeEvents } from './opencode-events';
import { messageMetadata, openCodeUsage, sessionUsage } from '../usage';
import { dataPath } from './harness-paths';
import { sourcePath } from '../source-paths';
import { columns, optionalJSON, rows, sqliteJSON } from './sqlite-histories';
import { hasTable, sqliteRevision, withSqliteSnapshot } from './sqlite-snapshot';
import { object, text, time, type Raw } from './local-files';
import { openCodeV1Message } from './opencode-v1';

export function openCodeMessage(raw: RawMessage, sessionID: string): ImportedMessage {
  const content = extractContent([raw]), detail = summarizeMessages(sessionID, [raw], null);
  const message: ImportedMessage = { id: raw.id, time: raw.time?.created || 0, role: raw.type === 'user' ? 'user' : raw.type === 'assistant' ? 'assistant' : 'system',
    fragments: content.fragments, files: detail.files, tools: detail.tools.map(tool => tool.name), snapshots: detail.snapshotSteps, partial: content.truncated };
  message.metadata = messageMetadata({ ...raw, stopReason: raw.finish });
  if (raw.type === 'assistant') message.usage = openCodeUsage(raw.tokens, raw.cost, raw.id);
  if (detail.locations.length) message.locations = detail.locations;
  message.events = opencodeEvents(raw, message);
  return message;
}

const PAGE = 60;
const MAX_JSON = 4_000_000;
type Schema = { version: '1' | '2'; session: string; message: string; part?: string };
const sessionFields = ['id', 'project_id', 'parent_id', 'fork_session_id', 'directory', 'title', 'time_created', 'time_updated', 'time_archived',
  'model', 'agent', 'cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write', 'idle_outcome'];

/** OpenCode uses XDG data paths on every OS, including macOS and Windows. */
export async function openCodeDatabases(): Promise<string[]> {
  const override = sourcePath('opencode') || process.env.SESSIONGRAPH_OPENCODE_HISTORY_DIR || process.env.OPENCODE_DB;
  const root = override || dataPath('opencode');
  try {
    const info = await lstat(root);
    if (info.isFile()) return [root];
    if (!info.isDirectory()) return [];
    const files = (await readdir(root)).filter(name => /^opencode(?:[-.][\w.-]+)?\.db$/.test(name)).sort((a, b) => a === 'opencode.db' ? -1 : b === 'opencode.db' ? 1 : a.localeCompare(b));
    if (files.length > 20) throw new Error('Too many OpenCode databases. Choose a database file with a source path override.');
    const paths: string[] = [];
    for (const file of files) { const path = join(root, file); if ((await lstat(path)).isFile()) paths.push(path); }
    return paths;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

function schemas(db: DatabaseSync): Schema[] {
  const result: Schema[] = [];
  for (const version of ['2', '1'] as const) {
    const session = version === '2' ? 'session_v2' : 'session', message = version === '2' ? 'session_message' : 'message', part = version === '2' ? 'session_part' : 'part';
    if (!hasTable(db, session)) continue;
    for (const [table, required] of [[session, ['id', 'time_created', 'time_updated']], [message, ['id', 'session_id', 'data', 'time_created', ...(version === '2' ? ['type', 'seq'] : [])]]] as const) {
      const names = columns(db, table);
      if (required.some(name => !names.has(name))) throw new Error('Unsupported OpenCode database schema.');
    }
    if (hasTable(db, part)) {
      const names = columns(db, part);
      if (['message_id', 'data', version === '2' ? 'ordinal' : 'id'].some(name => !names.has(name))) throw new Error('Unsupported OpenCode part schema.');
    } else if (version === '1') throw new Error('OpenCode V1 parts are unavailable.');
    result.push({ version, session, message, part: hasTable(db, part) ? part : undefined });
  }
  if (!result.length) throw new Error('Unsupported OpenCode database schema.');
  return result;
}

function historyRevisions(db: DatabaseSync, schema: Schema) {
  const result = new Map<string, unknown[]>();
  for (const table of [schema.message, schema.part].filter((value): value is string => Boolean(value))) {
    const names = columns(db, table);
    if (!names.has('session_id')) continue;
    const updated = names.has('time_updated') ? 'MAX(time_updated)' : 'NULL';
    for (const row of db.prepare(`SELECT session_id, COUNT(*) AS count, ${updated} AS updated FROM "${table}" GROUP BY session_id`).iterate()) {
      const id = text(row.session_id);
      result.set(id, [...(result.get(id) || []), row.count, row.updated]);
    }
  }
  return result;
}

function discoverDatabase(db: DatabaseSync, path: string, snapshot: string) {
  const sessions = new Map<string, Candidate>(), projects = new Map<string, Project>(), errors: string[] = [];
  const seen = new Set<string>();
  if (hasTable(db, 'project')) {
    for (const row of rows(db, 'project', ['id', 'name', 'worktree', 'sandboxes'], undefined, 'id', 20_000)) {
      try {
        const p = project('opencode', text(row.worktree)), sandboxes = optionalJSON(row.sandboxes);
        p.id = identity('opencode', text(row.id)); p.name = text(row.name) || p.name;
        p.worktrees = Array.isArray(sandboxes) ? sandboxes.filter(value => typeof value === 'string') : [];
        projects.set(p.id, p);
      } catch { errors.push('OpenCode: Skipped unreadable project metadata.'); }
    }
  }
  // A migrated V2 row wins over the retained V1 row with the same native identity.
  for (const schema of schemas(db)) {
    const revisions = historyRevisions(db, schema);
    for (const row of rows(db, schema.session, sessionFields, undefined, 'id', 20_000)) {
      const nativeID = text(row.id), id = identity('opencode', nativeID);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!nativeID || nativeID.length > 512 || !time(row.time_created)) { errors.push('OpenCode: Skipped invalid session metadata.'); continue; }
      const session = { ...blankSession('opencode', nativeID, text(row.directory)), title: text(row.title) || 'Untitled session',
        created: time(row.time_created), updated: time(row.time_updated) || time(row.time_created), archived: Boolean(row.time_archived),
        parentID: text(row.parent_id) ? identity('opencode', text(row.parent_id)) : undefined,
        forkID: text(row.fork_session_id) ? identity('opencode', text(row.fork_session_id)) : undefined };
      try {
        const model = object(optionalJSON(row.model));
        session.model = text(model.id) || 'Unknown model'; session.provider = text(model.providerID);
        session.agent = text(row.agent) || 'build'; session.outcome = text(row.idle_outcome) || undefined;
        if (schema.version === '1') {
          // V1 has no session model column. Inspect only the latest message's
          // structured metadata, without loading its parts during discovery.
          const valid = `length(CAST(data AS BLOB))<=${MAX_JSON} AND json_valid(data)`;
          const latest = db.prepare(`SELECT
            CASE WHEN ${valid} THEN substr(json_extract(data,'$.modelID'),1,256) END AS model,
            CASE WHEN ${valid} THEN substr(json_extract(data,'$.providerID'),1,256) END AS provider,
            CASE WHEN ${valid} THEN substr(json_extract(data,'$.model.modelID'),1,256) END AS user_model,
            CASE WHEN ${valid} THEN substr(json_extract(data,'$.model.providerID'),1,256) END AS user_provider,
            CASE WHEN ${valid} THEN substr(json_extract(data,'$.agent'),1,256) END AS agent
            FROM message WHERE session_id=? ORDER BY time_created DESC, id DESC LIMIT 1`).get(nativeID);
          session.model = text(latest?.model || latest?.user_model) || session.model;
          session.provider = text(latest?.provider || latest?.user_provider);
          session.agent = text(latest?.agent) || session.agent;
        }
        if (schema.version === '2') {
          session.usage = sessionUsage(openCodeUsage({ input: row.tokens_input, output: row.tokens_output, reasoning: row.tokens_reasoning,
            cache: { read: row.tokens_cache_read, write: row.tokens_cache_write } }, row.cost));
          session.tokens = session.usage?.total ?? null; session.cost = session.usage?.cost ?? null;
        }
        const nativeProject = identity('opencode', text(row.project_id));
        const p = projects.get(nativeProject) || project('opencode', session.directory);
        session.projectID = p.id; projects.set(p.id, p);
        sessions.set(id, { session, revision: digest([6, schema.version, row, revisions.get(nativeID)]),
          locator: { path, snapshot, version: schema.version } });
      } catch { errors.push('OpenCode: Skipped unreadable session metadata.'); }
    }
  }
  return { sessions: [...sessions.values()], projects: [...projects.values()], warnings: [], errors };
}

/** Bound both individual JSON fields and aggregate payloads before parsing. */
function payloadRows(db: DatabaseSync, query: string, values: (string | number)[], budget: { bytes: number; records: number }): Raw[] {
  const result: Raw[] = [];
  for (const row of db.prepare(query).iterate(...values)) {
    if (typeof row.data !== 'string') throw new Error('OpenCode history contains a missing or oversized JSON field (4 MB limit).');
    budget.bytes += Buffer.byteLength(row.data); budget.records++;
    if (budget.bytes > 32_000_000 || budget.records > 50_000) throw new Error('OpenCode history page exceeds the 32 MB / 50,000-record limit.');
    result.push(row);
  }
  return result;
}

export const opencodeAdapter: SessionAdapter = {
  id: 'opencode', name: 'OpenCode', description: 'Local SQLite history · V1 and V2 · no running service needed',
  capabilities: { history: true, forks: true, children: true, files: true },
  async detect() { return (await openCodeDatabases()).length > 0; },
  async discover() {
    const sessions = new Map<string, Candidate>(), projects = new Map<string, ReturnType<typeof project>>(), errors: string[] = [];
    for (const path of await openCodeDatabases()) {
      try {
        const snapshot = sqliteRevision(path);
        const found = withSqliteSnapshot(path, db => discoverDatabase(db, path, snapshot), snapshot);
        for (const candidate of found.sessions) {
          const previous = sessions.get(candidate.session.id);
          if (!previous || candidate.locator.version > previous.locator.version ||
            candidate.locator.version === previous.locator.version && candidate.session.updated > previous.session.updated) sessions.set(candidate.session.id, candidate);
        }
        for (const p of found.projects) projects.set(p.id, p);
        errors.push(...found.errors);
      } catch (error) { errors.push(`OpenCode: ${error instanceof Error ? error.message : 'Could not read a history database.'}`); }
    }
    return { sessions: [...sessions.values()], projects: [...projects.values()], warnings: [], errors: [...new Set(errors)] };
  },
  async read(candidate, cursor) {
    if (cursor && !/^[1-9]\d{0,5}$/.test(cursor)) throw new Error('Invalid OpenCode history cursor.');
    const offset = Number(cursor || 0);
    return withSqliteSnapshot(candidate.locator.path, db => {
      const schema = schemas(db).find(value => value.version === candidate.locator.version);
      if (!schema) throw new Error('OpenCode history schema changed.');
      const budget = { bytes: 0, records: 0 };
      const data = `CASE WHEN length(CAST(data AS BLOB))<=${MAX_JSON} THEN data END AS data`;
      const page = payloadRows(db, `SELECT id, time_created, ${schema.version === '2' ? 'type' : 'NULL AS type'}, ${data}
        FROM "${schema.message}" WHERE session_id=? ORDER BY ${schema.version === '2' ? 'seq DESC' : 'time_created DESC, id DESC'} LIMIT ${PAGE + 1} OFFSET ?`,
      [candidate.session.nativeID!, offset], budget);
      const messages = page.slice(0, PAGE).map(row => {
        const body = object(sqliteJSON(row.data));
        if (schema.version === '1' && !['user', 'assistant'].includes(body.role)) throw new Error('Unsupported OpenCode V1 message.');
        if (schema.version === '2' && !text(row.type)) throw new Error('Missing OpenCode message type.');
        const parts = schema.part ? payloadRows(db, `SELECT ${schema.version === '2' ? 'ordinal' : 'id'}, ${data} FROM "${schema.part}" WHERE message_id=? ORDER BY ${schema.version === '2' ? 'ordinal' : 'id'}`,
          [text(row.id)], budget).map(part => ({ ...object(sqliteJSON(part.data)), ...(schema.version === '1' ? { id: part.id } : {}) })) : [];
        const raw = schema.version === '1' ? openCodeV1Message(body, parts)
          : { ...body, type: row.type, content: [...parts, ...(Array.isArray(body.content) ? body.content : [])] };
        const message = openCodeMessage({ ...raw, id: text(row.id), time: { ...object(raw.time), created: time(raw.time?.created) || time(row.time_created) } } as RawMessage, candidate.session.id);
        if (schema.version === '1' && candidate.session.model === 'Unknown model' && message.metadata?.model) {
          candidate.session.model = message.metadata?.model || candidate.session.model;
          candidate.session.provider = message.metadata?.provider || candidate.session.provider;
        }
        return message;
      });
      return { messages, cursor: page.length > PAGE ? String(offset + PAGE) : undefined };
    }, candidate.locator.snapshot, true);
  },
};
