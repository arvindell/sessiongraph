import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionGraphData, Session, SessionDetail, SessionTimeline, SourceStatus } from '../src/types';
import type { ContentPage } from '../src/search/types';
import { MAX_CHARACTERS, validRecord, type CachedContent } from '../src/search/persistence';
import type { Candidate, ImportedMessage } from './adapters/types';
import { databasePath } from './config';
import { activitySQL, isUserMessage, messageTime } from './activity';
import { EVENT_SCHEMA, writeEvents, readEvents, readEventMarkers } from './event-store';
import { normalizePreferences, type Preferences } from '../src/preferences';
import { normalizeViewState } from '../src/view-state';

/** SessionGraph owns this database. No adapter opens or modifies a harness database. */
export class SessionGraphStore {
  private owner = randomUUID();
  readonly db: DatabaseSync;
  constructor(readonly path = databasePath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 4) throw new Error('This SessionGraph database requires a newer version of the app.');
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
    if (version < 3) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Backfill from SessionGraph's saved snapshot, without rereading sources.
        if (!this.db.prepare('PRAGMA table_info(messages)').all().some((column) => column.name === 'time')) {
          this.db.exec(`ALTER TABLE messages ADD COLUMN time REAL;
            ALTER TABLE messages ADD COLUMN is_user INTEGER NOT NULL DEFAULT 0;
            UPDATE messages SET time=CASE WHEN json_type(data, '$.time') IN ('integer','real') AND json_extract(data, '$.time') > 0 AND json_extract(data, '$.time') <= 8640000000000000 THEN json_extract(data, '$.time') END,
              is_user=CASE WHEN json_extract(data, '$.role')='user' AND EXISTS (SELECT 1 FROM json_each(data, '$.fragments') WHERE json_extract(value, '$.kind')='You' AND trim(json_extract(value, '$.text'))<>'') THEN 1 ELSE 0 END;`);
        }
        const summarize = this.db.prepare(activitySQL);
        const update = this.db.prepare("UPDATE sessions SET metadata=json_set(metadata, '$.activity', json(?)) WHERE id=?");
        for (const { id } of this.db.prepare('SELECT id FROM sessions').all()) update.run(JSON.stringify(summarize.get(id)), id);
        this.db.exec('CREATE INDEX IF NOT EXISTS messages_user_time ON messages(session_id,is_user,time); PRAGMA user_version=3; COMMIT;');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    if (version < 4) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(EVENT_SCHEMA);
        for (const { id } of this.db.prepare('SELECT id FROM sessions').all()) {
          writeEvents(this.db, String(id), this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal').iterate(id));
        }
        this.db.exec('PRAGMA user_version=4; COMMIT;');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    if (!this.setting('libraryID')) this.setting('libraryID', randomUUID());
    // An interrupted import never exposes staged/half-replaced messages.
  }
  setting<T = string>(key: string, value?: T): T | undefined {
    if (value !== undefined) this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  selected() { return this.setting<string[]>('selected') || []; }
  autoImportEnabled() { return this.setting<boolean>('autoImport') !== false; }
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
      activity: previous?.activity, revision: previous?.revision || '', coverage: previous?.coverage || { history: 'pending' } };
    this.db.prepare(`INSERT INTO sessions (id,source,native_id,metadata,locator) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,locator=excluded.locator`).run(s.id, s.source!, s.nativeID!, JSON.stringify(metadata), JSON.stringify(candidate.locator));
  }
  replace(candidate: Candidate, messages: ImportedMessage[], partial: boolean, note?: string) {
    const s = { ...candidate.session, revision: candidate.revision, coverage: { history: partial ? 'partial' : 'complete', note, importedAt: Date.now() } };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(s.id);
      const insert = this.db.prepare('INSERT INTO messages (session_id,id,ordinal,data,time,is_user) VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET ordinal=excluded.ordinal,data=excluded.data,time=excluded.time,is_user=excluded.is_user');
      messages.forEach((message, i) => insert.run(s.id, message.id, i, JSON.stringify(message), messageTime(message.time), Number(isUserMessage(message))));
      writeEvents(this.db, s.id, this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal').iterate(s.id));
      const activity = this.db.prepare(activitySQL).get(s.id);
      this.db.prepare('UPDATE sessions SET metadata=?, imported_revision=? WHERE id=?').run(JSON.stringify({ ...s, activity }), candidate.revision, s.id);
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
  library(sources: SourceStatus[], importing: boolean): SessionGraphData {
    return { sourceID: this.setting('libraryID'), onboarding: this.setting('selected') === undefined, autoImport: this.autoImportEnabled(), sources, importing,
      preferences: this.setting<Preferences>('preferences') ? { ...normalizePreferences(this.setting('preferences')), autoImport: this.autoImportEnabled() } : undefined,
      viewState: normalizeViewState(this.setting('viewState')),
      sessions: this.db.prepare('SELECT metadata FROM sessions').all().map((r) => JSON.parse(String(r.metadata))),
      projects: this.db.prepare('SELECT data FROM projects').all().map((r) => JSON.parse(String(r.data))), loadedAt: Date.now(), warnings: [],
    };
  }
  private messagePage(id: string, cursor = 0, limit = 60) {
    if (!this.getSession(id)) throw new Error('Session not imported.');
    const rows = this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal DESC LIMIT ? OFFSET ?').all(id, limit + 1, cursor);
    return { messages: rows.slice(0, limit).map((r) => JSON.parse(String(r.data)) as ImportedMessage), next: rows.length > limit ? String(cursor + limit) : null };
  }
  handoff(id: string) {
    // One saved snapshot, even if another window is replacing this session.
    this.db.exec('BEGIN');
    try {
      const session = this.getSession(id);
      if (!session) throw new Error('Session not imported.');
      const totalMessages = Number(this.db.prepare('SELECT count(*) AS n FROM messages WHERE session_id=?').get(id)!.n);
      const rows = this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal DESC LIMIT 200').all(id).reverse();
      const messages = rows.map((r) => JSON.parse(String(r.data)) as ImportedMessage);
      const first = this.db.prepare('SELECT data FROM messages WHERE session_id=? AND is_user=1 ORDER BY ordinal LIMIT 1').get(id);
      const firstUser = first ? JSON.parse(String(first.data)) as ImportedMessage : undefined;
      this.db.exec('COMMIT');
      return { session, messages, firstUser, totalMessages };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  timeline(id: string): SessionTimeline {
    this.db.exec('BEGIN');
    try {
      const session = this.getSession(id);
      if (!session) throw new Error('Session not imported.');
      const rows = this.db.prepare('SELECT id,time FROM messages WHERE session_id=? AND is_user=1 AND time>=? ORDER BY time DESC,ordinal DESC LIMIT 2000').all(id, session.created);
      const earlier = Number(this.db.prepare('SELECT count(*) AS n FROM messages WHERE session_id=? AND is_user=1 AND time<?').get(id, session.created)!.n);
      const activity = session.activity!;
      const result: SessionTimeline = { id, userMessages: rows.reverse().map((row) => ({ id: String(row.id), time: Number(row.time) })),
        totalUserMessages: activity?.userMessages ?? 0, untimedUserMessages: activity?.untimedUserMessages ?? 0, earlierUserMessages: earlier,
        partial: session.coverage?.history !== 'complete' || rows.length + earlier < (activity?.userMessages ?? 0), note: session.coverage?.note };
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(id: string, options: Parameters<typeof readEvents>[2] = {}) {
    return this.eventSnapshot(id, (session) => readEvents(this.db, session, options));
  }
  eventMarkers(id: string) { return this.eventSnapshot(id, (session) => readEventMarkers(this.db, session)); }
  private eventSnapshot<T>(id: string, read: (session: Session) => T): T {
    this.db.exec('BEGIN');
    try {
      const session = this.getSession(id);
      if (!session) throw new Error('Session not imported.');
      const result = read(session); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
