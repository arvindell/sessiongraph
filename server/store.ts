import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AtlasData, Session, SessionDetail, SourceStatus } from '../src/types';
import type { ContentPage } from '../src/search/types';
import { MAX_CHARACTERS, validRecord, type CachedContent } from '../src/search/persistence';
import type { Candidate, ImportedMessage } from './adapters/types';

export function dataDirectory() {
  if (process.env.ATLAS_DATA_DIR) return process.env.ATLAS_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Atlas');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'Atlas');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atlas');
}

/** Atlas owns this database. No adapter opens or modifies a harness database. */
export class AtlasStore {
  private owner = randomUUID();
  readonly db: DatabaseSync;
  constructor(readonly path = join(dataDirectory(), 'atlas.sqlite')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 2) throw new Error('This Atlas database requires a newer version of the app.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, last_import INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, source TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, native_id TEXT NOT NULL,
        metadata TEXT NOT NULL, imported_revision TEXT, locator TEXT NOT NULL, UNIQUE(source, native_id));
      CREATE INDEX IF NOT EXISTS sessions_source ON sessions(source);
      CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, id));
      CREATE INDEX IF NOT EXISTS messages_order ON messages(session_id, ordinal);
      CREATE TABLE IF NOT EXISTS search_cache (id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL, characters INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS import_lock (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(search_cache)').all().some((column) => column.name === 'characters')) {
      this.db.exec("ALTER TABLE search_cache ADD COLUMN characters INTEGER NOT NULL DEFAULT 0; UPDATE search_cache SET characters=json_extract(data, '$.characters');");
    }
    this.db.exec('PRAGMA user_version=2;');
    if (!this.setting('libraryID')) this.setting('libraryID', randomUUID());
    // An interrupted import never exposes staged/half-replaced messages.
  }
  setting<T = string>(key: string, value?: T): T | undefined {
    if (value !== undefined) this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  selected() { return this.setting<string[]>('selected') || []; }
  acquireImport() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.db.prepare('SELECT * FROM import_lock WHERE id=1').get();
      if (lock && lock.owner !== this.owner) {
        let live = true; try { process.kill(Number(lock.pid), 0); } catch (error) { live = (error as NodeJS.ErrnoException).code === 'EPERM'; }
        if (live && Date.now() - Number(lock.heartbeat) < 300_000) { this.db.exec('ROLLBACK'); return false; }
      }
      this.db.prepare('INSERT OR REPLACE INTO import_lock VALUES (1,?,?,?)').run(this.owner, process.pid, Date.now());
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  heartbeat() { this.db.prepare('UPDATE import_lock SET heartbeat=? WHERE owner=?').run(Date.now(), this.owner); }
  releaseImport() { this.db.prepare('DELETE FROM import_lock WHERE owner=?').run(this.owner); }
  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT metadata FROM sessions WHERE id=?').get(id);
    return row ? JSON.parse(String(row.metadata)) : undefined;
  }
  revision(id: string) { return this.db.prepare('SELECT imported_revision FROM sessions WHERE id=?').get(id)?.imported_revision; }
  upsert(candidate: Candidate) {
    const s = candidate.session, previous = this.getSession(s.id);
    const metadata = { ...s, model: s.model === 'Unknown model' ? previous?.model || s.model : s.model,
      parentID: previous?.parentID && candidate.locator.agent ? previous.parentID : s.parentID,
      revision: previous?.revision || '', coverage: previous?.coverage || { history: 'pending' } };
    this.db.prepare(`INSERT INTO sessions (id,source,native_id,metadata,locator) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,locator=excluded.locator`).run(s.id, s.source!, s.nativeID!, JSON.stringify(metadata), JSON.stringify(candidate.locator));
  }
  replace(candidate: Candidate, messages: ImportedMessage[], partial: boolean, note?: string) {
    const s = { ...candidate.session, revision: candidate.revision, coverage: { history: partial ? 'partial' : 'complete', note, importedAt: Date.now() } };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(s.id);
      const insert = this.db.prepare('INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET ordinal=excluded.ordinal,data=excluded.data');
      messages.forEach((message, i) => insert.run(s.id, message.id, i, JSON.stringify(message)));
      this.db.prepare('UPDATE sessions SET metadata=?, imported_revision=? WHERE id=?').run(JSON.stringify(s), candidate.revision, s.id);
      this.db.prepare('DELETE FROM search_cache WHERE id=?').run(s.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordSource(id: string, error?: string) {
    this.db.prepare('INSERT INTO sources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET last_import=excluded.last_import,error=excluded.error').run(id, Date.now(), error || null);
  }
  failed(id: string, error: string) {
    const session = this.getSession(id);
    if (!session) return;
    session.coverage = { ...session.coverage, history: session.coverage?.importedAt ? 'partial' : 'pending', note: `Latest import failed: ${error}${session.coverage?.importedAt ? ' Showing the previous saved history.' : ''}` };
    this.db.prepare('UPDATE sessions SET metadata=? WHERE id=?').run(JSON.stringify(session), id);
  }
  sourceInfo(id: string) {
    const row = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE source=?').get(id)!;
    return { sessions: Number(count.n), lastImport: row?.last_import ? Number(row.last_import) : undefined, error: row?.error ? String(row.error) : undefined };
  }
  atlas(sources: SourceStatus[], importing: boolean): AtlasData {
    return { sourceID: this.setting('libraryID'), onboarding: this.setting('selected') === undefined, sources, importing,
      sessions: this.db.prepare('SELECT metadata FROM sessions').all().map((r) => JSON.parse(String(r.metadata))),
      projects: this.db.prepare('SELECT data FROM projects').all().map((r) => JSON.parse(String(r.data))), loadedAt: Date.now(), warnings: [],
    };
  }
  private messagePage(id: string, cursor = 0, limit = 60) {
    if (!this.getSession(id)) throw new Error('Session not imported.');
    const rows = this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal DESC LIMIT ? OFFSET ?').all(id, limit + 1, cursor);
    return { messages: rows.slice(0, limit).map((r) => JSON.parse(String(r.data)) as ImportedMessage), next: rows.length > limit ? String(cursor + limit) : null };
  }
  content(id: string, cursor?: string): ContentPage {
    const page = this.messagePage(id, Number(cursor || 0));
    let remaining = 64_000, truncated = false;
    const fragments = page.messages.flatMap((m) => {
      truncated ||= Boolean(m.partial);
      return m.fragments.flatMap((f) => {
        const text = f.text.slice(0, Math.min(remaining, 8_000));
        truncated ||= text.length < f.text.length; remaining -= text.length;
        return text ? [{ ...f, text }] : [];
      });
    });
    truncated ||= this.getSession(id)?.coverage?.history !== 'complete';
    return { id, fragments, messages: page.messages.length, nextCursor: page.next, truncated };
  }
  detail(id: string, cursor?: string): SessionDetail {
    const page = this.messagePage(id, Number(cursor || 0), 120), session = this.getSession(id)!;
    const files = new Map<string, SessionDetail['files'][number]>(), tools = new Map<string, number>();
    for (const message of page.messages) {
      for (const file of message.files) {
        const previous = files.get(file.path);
        files.set(file.path, { ...file, source: previous?.source === 'snapshot' ? 'snapshot' : file.source, steps: (previous?.steps || 0) + file.steps });
      }
      message.tools.forEach((tool) => tools.set(tool, (tools.get(tool) || 0) + 1));
    }
    return { id, files: [...files.values()].sort((a, b) => b.steps - a.steps), tools: [...tools].map(([name, count]) => ({ name, count })), locations: [], messagesScanned: page.messages.length,
      snapshotSteps: page.messages.reduce((n, m) => n + (m.snapshots || 0), 0), nextCursor: page.next, partial: Boolean(page.next) || session.coverage?.history !== 'complete', loadedAt: Date.now(), note: session.coverage?.note || (session.coverage?.history === 'pending' ? 'Waiting for import.' : undefined) };
  }
  checkpoints(after = '') {
    const rows = this.db.prepare('SELECT id,data FROM search_cache WHERE id>? ORDER BY id LIMIT 51').all(after);
    const records: CachedContent[] = [];
    for (const row of rows.slice(0, 50)) {
      const record = JSON.parse(String(row.data));
      if (validRecord(record, this.getSession(String(row.id)))) records.push(record);
      else this.db.prepare('DELETE FROM search_cache WHERE id=?').run(row.id);
    }
    return { records, cursor: rows.length > 50 ? String(rows[49].id) : undefined, epoch: this.setting<number>('indexEpoch') || 0 };
  }
  saveCheckpoint(record: CachedContent, epoch: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== (this.setting<number>('indexEpoch') || 0) || !validRecord(record, this.getSession(record.id))) { this.db.exec('ROLLBACK'); return false; }
      const total = Number(this.db.prepare('SELECT COALESCE(SUM(characters),0) AS n FROM search_cache WHERE id<>?').get(record.id)!.n);
      if (total + record.characters > MAX_CHARACTERS) { this.db.exec('ROLLBACK'); return false; }
      // Don't let a slower tab overwrite a more advanced checkpoint.
      const previous = this.db.prepare('SELECT data FROM search_cache WHERE id=?').get(record.id);
      if (previous) { const old = JSON.parse(String(previous.data)); if (old.version === record.version && old.pages > record.pages) { this.db.exec('ROLLBACK'); return false; } }
      this.db.prepare('INSERT INTO search_cache (id,data,characters) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,characters=excluded.characters').run(record.id, JSON.stringify(record), record.characters);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  clearIndex() {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.exec('DELETE FROM search_cache'); this.setting('indexEpoch', (this.setting<number>('indexEpoch') || 0) + 1); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
