import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { blankSession, digest, identity, project } from './common';
import { text, time, type LocalHistory, type Raw } from './local-files';
import { hasTable, sqliteRevision, withSqliteSnapshot } from './sqlite-snapshot';
import { expandHistory } from './compressed';
import type { Candidate, SessionAdapter } from './types';

// Parsers are synchronous; nested part/IR queries share one session budget.
let budget: { bytes: number; records: number } | undefined;
const rowBytes = (row: Raw) => Object.values(row).reduce<number>((n, v) => n + (typeof v === 'string' ? Buffer.byteLength(v) : v instanceof Uint8Array ? v.byteLength : 8), 0);
function consume(bytes: number, records = 0) {
  if (!budget) return;
  budget.bytes += bytes; budget.records += records;
  if (budget.bytes > 64_000_000 || budget.records > 50_000) throw new Error('Session exceeds the 64 MB / 50,000-record snapshot limit.');
}
function parseHistory(source: DatabaseHarness, db: DatabaseSync, row: Raw, path: string) {
  const previous = budget; budget = { bytes: 0, records: 0 };
  try {
    consume(rowBytes(row), 1);
    const history = source.parse(db, row, path);
    if (history && history.messages.length > 50_000) throw new Error('Session exceeds the 50,000-message limit.');
    return history;
  } finally { budget = previous; }
}

export function columns(db: DatabaseSync, table: string): Set<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table) || !hasTable(db, table)) throw new Error(`Unsupported history table: ${table}.`);
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(r => String(r.name)));
}

/** Fixed adapter-owned identifiers, bound values, bounded rows/fields/aggregate bytes. */
export function rows(db: DatabaseSync, table: string, fields: string[], filter?: [string, SQLInputValue], order?: string, limit = 50_000): Raw[] {
  const available = columns(db, table);
  for (const name of [...fields, ...(filter ? [filter[0]] : []), ...(order ? [order] : [])]) if (!/^[a-zA-Z_][\w]*$/.test(name)) throw new Error('Invalid history column.');
  if (filter && !available.has(filter[0])) throw new Error('Unsupported history relation.');
  const size = (f: string) => `length(CAST("${f}" AS BLOB))`;
  const select = fields.map(f => available.has(f) ? `CASE WHEN ${size(f)}<=32000000 THEN "${f}" END AS "${f}"` : `NULL AS "${f}"`).join(',');
  const oversized = fields.filter(f => available.has(f)).map(f => `COALESCE(${size(f)},0)>32000000`).join(' OR ') || '0';
  const query = `SELECT ${select}, (${oversized}) AS __sessiongraph_oversized FROM "${table}"${filter ? ` WHERE "${filter[0]}"=?` : ''}${order && available.has(order) ? ` ORDER BY "${order}"` : ''} LIMIT ${limit + 1}`;
  const result: Raw[] = []; let bytes = 0;
  for (const row of db.prepare(query).iterate(...(filter ? [filter[1]] : []))) {
    if (row.__sessiongraph_oversized) throw new Error('History field exceeds the 32 MB snapshot limit.');
    delete row.__sessiongraph_oversized;
    const size = rowBytes(row);
    bytes += size; consume(size, 1);
    if (bytes > 64_000_000 || result.length >= limit) throw new Error('History exceeds the 64 MB / record-count query limit.');
    result.push(row);
  }
  return result;
}

export function sqliteJSON(value: unknown): any {
  if (value instanceof Uint8Array) {
    const expanded = expandHistory(Buffer.from(value), Math.max(1, Math.min(32_000_000, 64_000_000 - (budget?.bytes || 0))));
    consume(expanded.byteLength);
    return JSON.parse(expanded.toString('utf8'));
  }
  if (typeof value === 'string') return JSON.parse(value);
  throw new Error('Missing or oversized history payload.');
}
export function optionalJSON(value: unknown): any { return value == null || value === '' ? {} : sqliteJSON(value); }

export interface DatabaseHarness {
  id: string;
  name: string;
  version?: number;
  paths: () => Promise<string[]>;
  table: string | ((db: DatabaseSync) => string);
  key: string;
  fields: string[];
  parse: (db: DatabaseSync, row: Raw, path: string) => LocalHistory | undefined;
  description?: string;
  history?: boolean;
}

export function sqliteHistoryAdapter(source: DatabaseHarness): SessionAdapter {
  const metadata = new Map<string, { revision: string; candidates: Candidate[]; blocked: string[]; warnings: string[] }>();
  return {
    id: source.id, name: source.name, description: source.description || 'Local SQLite session history · isolated read-only snapshots',
    capabilities: { history: source.history !== false, forks: false, children: false, files: false },
    async detect() { return (await source.paths()).length > 0; },
    async discover() {
      const sessions = new Map<string, Candidate>(), warnings: string[] = [], blocked: string[] = []; let unavailable = false;
      for (const path of await source.paths()) {
        try {
          const snapshot = sqliteRevision(path), rev = digest([source.version || 2, source.id, snapshot]);
          let cached = metadata.get(path);
          if (!cached || cached.revision !== rev) {
            cached = withSqliteSnapshot(path, db => {
              const table = typeof source.table === 'string' ? source.table : source.table(db);
              const values = rows(db, table, source.fields, undefined, source.key, 20_000), found: Candidate[] = [];
              const blocked: string[] = [], warnings: string[] = []; let empty = 0;
              for (const row of values) {
                try {
                  const h = parseHistory(source, db, row, path); if (!h) continue;
                  if (source.history !== false && !h.messages.length) { blocked.push(identity(source.id, String(row[source.key]))); empty++; continue; }
                  if (!h.nativeID || h.nativeID.length > 512) throw new Error('Missing native session identity.');
                  const created = time(h.session?.created) || h.messages.map(m => time(m.time)).find(Boolean);
                  if (!created) throw new Error('Session has no recorded creation or message date.');
                  const session = { ...blankSession(source.id, h.nativeID), ...h.session, created };
                  session.id = identity(source.id, h.nativeID); session.nativeID = h.nativeID; session.source = source.id;
                  session.directory = text(session.directory); session.projectID = project(source.id, session.directory).id;
                  session.agent ||= source.name; session.updated ||= created;
                  session.parentID = h.parent ? identity(source.id, h.parent) : undefined;
                  session.forkID = h.fork ? identity(source.id, h.fork) : undefined;
                  if (!session.title || session.title === 'Untitled session') session.title = h.messages.flatMap(m => m.role === 'user' ? m.fragments.filter(f => f.kind === 'You').map(f => f.text) : []).find(Boolean)?.replace(/\s+/g, ' ').slice(0, 180) || `${source.name} session`;
                  found.push({ session, revision: rev, locator: { path, snapshot, table, key: String(row[source.key]) } });
                } catch { blocked.push(identity(source.id, String(row[source.key]))); }
              }
              if (blocked.length > empty) warnings.push(`${blocked.length - empty} ${source.name} sessions had unsupported, undated, missing, or oversized history; saved imports are kept.`);
              if (empty) warnings.push(`${empty} empty ${source.name} sessions had no saved messages; previous imports are kept.`);
              return { revision: rev, candidates: found, blocked, warnings };
            }, snapshot);
            metadata.set(path, cached);
          }
          warnings.push(...cached.warnings); blocked.push(...cached.blocked);
          for (const c of cached.candidates) {
            const old = sessions.get(c.session.id);
            if (!old || c.session.updated > old.session.updated) sessions.set(c.session.id, c);
          }
        } catch { unavailable = true; warnings.push(`A ${source.name} database could not be read consistently; saved imports are kept.`); }
      }
      const values = [...sessions.values()];
      return { sessions: values, projects: [...new Map(values.map(c => { const p = project(source.id, c.session.directory); return [p.id, p]; })).values()], warnings, blocked, unavailable };
    },
    async read(candidate, cursor) {
      if (cursor) throw new Error('Invalid SQLite history cursor.');
      const { path, snapshot, key } = candidate.locator;
      return withSqliteSnapshot(path, db => {
        const table = typeof source.table === 'string' ? source.table : source.table(db);
        const row = rows(db, table, source.fields, [source.key, key], undefined, 1)[0];
        if (!row) throw new Error('Session metadata is unavailable.');
        const history = parseHistory(source, db, row, path);
        if (!history || history.nativeID !== candidate.session.nativeID) throw new Error('Session identity changed.');
        if (source.history !== false && !history.messages.length) throw new Error('No readable conversation.');
        return { messages: history.messages, partial: Boolean(history.partial || history.messages.some(m => m.partial)), note: `${history.note} File snapshots are unavailable. Missing message timestamps remain unknown.` };
      }, snapshot);
    },
  };
}

export async function existingDatabases(paths: string[]) {
  const found: string[] = [];
  for (const path of new Set(paths)) { try { if ((await lstat(path)).isFile()) found.push(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  return found;
}

/** Representations of one harness share native identity. Earlier adapters win. */
export function combineAdapters(parts: SessionAdapter[]): SessionAdapter {
  const first = parts[0];
  return { ...first,
    async detect() { for (const p of parts) if (await p.detect().catch(() => false)) return true; return false; },
    async discover() {
      const sessions = new Map<string, Candidate>(), projects = new Map(), warnings: string[] = [], blocked = new Set<string>();
      for (const [i, part] of parts.entries()) {
        let result;
        try { if (!await part.detect()) continue; result = await part.discover(); }
        catch { warnings.push(`A ${part.name} representation could not be read; saved imports are retained.`); break; }
        warnings.push(...result.warnings);
        for (const id of result.blocked || []) blocked.add(id);
        for (const p of result.projects) projects.set(p.id, p);
        for (const c of result.sessions) if (!blocked.has(c.session.id) && !sessions.has(c.session.id)) sessions.set(c.session.id, { ...c, revision: digest([i, c.revision]), locator: { ...c.locator, representation: String(i), originalRevision: c.revision } });
        if (result.unavailable) break;
      }
      return { sessions: [...sessions.values()], projects: [...projects.values()], warnings };
    },
    async read(candidate, cursor) {
      const index = Number(candidate.locator.representation);
      if (!Number.isInteger(index) || !parts[index]) throw new Error('Invalid history representation.');
      return parts[index].read({ ...candidate, revision: candidate.locator.originalRevision }, cursor);
    },
  };
}
