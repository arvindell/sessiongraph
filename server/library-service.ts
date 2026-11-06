import type { Session } from '@sessiongraph/core/types';
import { makeGraph, sessionEnd } from '@sessiongraph/core/layout';
import { SessionGraphStore } from './store';
import { Importer } from './importer';
import type { SessionAdapter } from './adapters/types';
import { sourcePathHint } from './source-paths';
import { filterSessions, fingerprint, invalid, LibraryError, localPath, nextCursor, page, pageLimit, pageOffset, type PageOptions, type SessionFilters } from './library-query';
import { SessionSearchIndex, parseQuery } from '../src/search/engine';
import { MAX_CHARACTERS, SESSION_CHARACTERS } from '../src/search/persistence';
import { sampleContent } from '../src/search/sampling';

export class LibraryService {
  readonly importer: Importer;
  constructor(readonly store: SessionGraphStore, adapters: SessionAdapter[]) { this.importer = new Importer(store, adapters); }
  private validateSources(ids: string[]) {
    for (const id of ids) if (!this.importer.adapters.some(a => a.id === id)) invalid(`Unknown source "${id}". Run sessiongraph sources list.`);
  }
  private snapshot<T>(read: () => T) {
    this.store.db.exec('BEGIN');
    try { const result = read(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  private sessions(filters: SessionFilters) {
    this.validateSources(filters.sources || []);
    const library = this.store.library([], this.importer.status.running);
    const sessions = filters.raw ? this.store.db.prepare('SELECT metadata FROM sessions').all().map(row => JSON.parse(String(row.metadata)) as Session) : library.sessions;
    return { sessions: filterSessions(sessions, filters), projects: library.projects };
  }
  private key(kind: string, sessions: Session[], filters: unknown) { return fingerprint([this.store.setting('libraryID'), kind, filters, sessions]); }
  async discoverSources() {
    const paths = this.store.setting<Record<string, string>>('sourcePaths') || {};
    return { sources: (await this.importer.sources()).map(source => ({ ...source, path: paths[source.id] || null, pathSupported: source.id !== 'opencode', pathHint: sourcePathHint(source.id) })),
      configured: this.store.setting('selected') !== undefined, autoImport: this.store.autoImportEnabled() };
  }
  private configure(change: () => void) {
    if (this.importer.status.running || !this.store.acquireImport()) throw new LibraryError('IMPORT_BUSY', 'Another SessionGraph process is importing this library. Retry when it finishes.');
    try {
      this.store.db.exec('BEGIN IMMEDIATE');
      try { change(); this.store.db.exec('COMMIT'); }
      catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    } finally { this.store.releaseImport(); }
    return { selected: this.store.selected(), paths: this.store.setting('sourcePaths') || {}, autoImport: this.store.autoImportEnabled(), historyRetained: true };
  }
  async setupSources(ids: string[], options: { detected?: boolean; path?: string; defaultPath?: boolean; autoImport?: boolean } = {}) {
    this.validateSources(ids);
    if (options.detected && ids.length) invalid('Choose source IDs or --detected, not both.');
    if (options.path !== undefined && options.defaultPath) invalid('Choose --path or --default-path, not both.');
    if (options.path !== undefined || options.defaultPath) {
      if (ids.length !== 1 || ids[0] === 'opencode') invalid('A path override requires exactly one filesystem source. OpenCode uses service discovery.');
      if (options.path !== undefined && (!options.path.trim() || options.path.includes('\0'))) invalid('Choose a nonempty local source directory.');
    }
    if (options.detected) ids = (await this.discoverSources()).sources.filter(s => s.available).map(s => s.id);
    if (!ids.length && options.autoImport === undefined) invalid('Choose source IDs or --detected. No sources were selected.');
    return this.configure(() => {
      this.store.setting('selected', [...new Set([...this.store.selected(), ...ids])]);
      const paths = this.store.setting<Record<string, string>>('sourcePaths') || {};
      if (options.path !== undefined) paths[ids[0]] = localPath(options.path);
      if (options.defaultPath) delete paths[ids[0]];
      this.store.setting('sourcePaths', paths);
      if (options.autoImport !== undefined) this.store.setting('autoImport', options.autoImport);
    });
  }
  removeSources(ids: string[], all = false) {
    this.validateSources(ids);
    if (all === !!ids.length) invalid('Choose source IDs or --all.');
    return this.configure(() => {
      const removed = all ? this.importer.adapters.map(a => a.id) : ids;
      this.store.setting('selected', this.store.selected().filter(id => !removed.includes(id)));
      const paths = this.store.setting<Record<string, string>>('sourcePaths') || {};
      for (const id of removed) delete paths[id];
      this.store.setting('sourcePaths', paths);
    });
  }
  async importSessions(ids?: string[]) {
    const selected = this.store.selected(), sources = ids?.length ? ids : selected;
    this.validateSources(sources);
    if (!sources.length) invalid('No import sources configured. Run sessiongraph sources setup <source...> first.');
    if (sources.some(id => !selected.includes(id))) invalid('Set up each source before syncing it: sessiongraph sources setup <source...>.');
    try { this.importer.sync(sources); }
    catch (error) { if ((error as Error).message.includes('importing this library')) throw new LibraryError('IMPORT_BUSY', (error as Error).message); throw error; }
    await this.importer.settled();
    return { ...this.importer.status, sources, selected: this.store.selected() };
  }
  listSessions(filters: SessionFilters = {}, options: PageOptions = {}) {
    return this.snapshot(() => {
      const { sessions } = this.sessions(filters);
      return { ...page(sessions, this.key('sessions', sessions, filters), options), filters, order: 'latest-message-first' };
    });
  }
  getSession(id: string) {
    const session = this.store.getSession(id);
    if (!session) throw new LibraryError('NOT_FOUND', 'Session not imported. Use the full ID from sessiongraph sessions.', 1);
    return session;
  }
  getMessages(id: string, options: PageOptions = {}) { this.getSession(id); return this.store.messages(id, options); }
  getTimeline(id: string) { this.getSession(id); return this.store.timeline(id); }
  getEvents(id: string, options: Parameters<SessionGraphStore['events']>[1] = {}) { this.getSession(id); return this.store.events(id, options); }
  getFileChanges(id: string, cursor?: string) {
    this.getSession(id);
    if (cursor && (!/^\d{1,9}$/.test(cursor) || Number(cursor) > 50_000)) invalid('Invalid file cursor. Use nextCursor from the previous page.');
    return this.store.detail(id, cursor);
  }
  getRelationships(id: string, options: PageOptions = {}) {
    return this.snapshot(() => {
      const session = this.getSession(id), sessions = this.sessions({ raw: true }).sessions;
      const relation = (target: string, kind: string, direction: string) => ({ id: target, kind, direction, imported: sessions.some(s => s.id === target) });
      const items = [
        ...(session.parentID && session.parentID !== session.forkID ? [relation(session.parentID, 'child', 'parent')] : []),
        ...(session.forkID ? [relation(session.forkID, 'fork', 'parent')] : []),
        ...(session.linkedSessionIDs || []).map(target => relation(target, 'provider-link', 'outgoing')),
        ...sessions.flatMap(s => [
          ...(s.parentID === id && s.forkID !== id ? [relation(s.id, 'child', 'child')] : []),
          ...(s.forkID === id ? [relation(s.id, 'fork', 'child')] : []),
          ...(s.linkedSessionIDs?.includes(id) ? [relation(s.id, 'provider-link', 'incoming')] : []),
        ]),
      ];
      return { sessionID: id, ...page(items, fingerprint(['relationships', id, items]), options) };
    });
  }
  searchSessions(query: string, filters: SessionFilters = {}, options: PageOptions = {}) {
    if (!query.trim() || query.length > 300) invalid('Search query must contain 1–300 characters.');
    const plan = parseQuery(query); if (plan.error) invalid(plan.error);
    return this.snapshot(() => {
      const { sessions, projects } = this.sessions(filters);
      const index = new SessionSearchIndex(); index.setData(sessions, projects);
      let characters = 0, complete = 0;
      const quota = Math.min(SESSION_CHARACTERS, Math.floor(MAX_CHARACTERS / Math.max(1, sessions.length)));
      for (const session of sessions) {
        let cursor: string | undefined, used = 0, partial = session.coverage?.history !== 'complete', done = false;
        for (let n = 0; n < 8 && used < quota; n++) {
          const content = this.store.content(session.id, cursor), sampled = sampleContent(content, quota - used);
          index.addContent(session.id, sampled.fragments); used += sampled.characters; partial ||= sampled.partial;
          if (!content.nextCursor) { done = true; break; }
          cursor = content.nextCursor;
        }
        characters += used; if (done && !partial) complete++;
      }
      const key = this.key('search', sessions, [query, filters, projects]), offset = pageOffset(options.cursor, key), limit = pageLimit(options.limit);
      const result = index.search(query, false, limit, offset), byID = new Map(sessions.map(s => [s.id, s]));
      return { query, hits: result.hits.map(hit => ({ ...hit, session: byID.get(hit.id)! })), total: result.total,
        nextCursor: offset + limit < result.total ? nextCursor(key, offset + limit) : null,
        coverage: { sessions: sessions.length, complete, partial: sessions.length - complete, characters, limited: complete < sessions.length },
        note: 'Search samples saved content using the app search limits (8 pages and up to 48,000 characters per session, 24 million overall). Narrow filters for more coverage; use messages/events for details.' };
    });
  }
  getStats(filters: SessionFilters = {}, groupBy = 'source', options: PageOptions = {}) {
    if (!['source', 'model', 'project', 'directory'].includes(groupBy)) invalid('Group by source, model, project, or directory.');
    return this.snapshot(() => {
      const { sessions } = this.sessions(filters), grouped = new Map<string, Session[]>();
      const usage = (values: (number | null | undefined)[]) => {
        const known = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        return { knownTotal: known.length || !values.length ? known.reduce((a, b) => a + b, 0) : null, knownSessions: known.length, unknownSessions: values.length - known.length };
      };
      const summary = (values: Session[]) => ({ sessions: values.length, tokens: usage(values.map(s => s.tokens)), cost: usage(values.map(s => s.cost)), userMessages: usage(values.map(s => s.activity?.userMessages)),
        coverage: { complete: values.filter(s => s.coverage?.history === 'complete').length, partial: values.filter(s => s.coverage?.history === 'partial').length, pending: values.filter(s => !s.coverage || s.coverage.history === 'pending').length },
        firstCreated: values.some(s => s.created > 0) ? values.reduce((min, s) => s.created > 0 ? Math.min(min, s.created) : min, Infinity) : null,
        lastActivity: values.some(s => sessionEnd(s) > 0) ? values.reduce((max, s) => Math.max(max, sessionEnd(s)), 0) : null });
      for (const s of sessions) { const key = (groupBy === 'project' ? s.projectID : s[groupBy as 'source' | 'model' | 'directory']) || 'unknown'; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key)!.push(s); }
      const groups = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, ...summary(values) }));
      return { totals: summary(sessions), groupBy, groups: page(groups, this.key('stats', sessions, [filters, groupBy]), options), filters,
        note: 'Date filters select sessions overlapping the window; usage is recorded lifetime usage for those sessions, not usage spent within the window. Groups use the primary source; unknown usage is not zero.' };
    });
  }
  getGraph(filters: SessionFilters = {}) {
    return this.snapshot(() => {
      const { sessions, projects } = this.sessions(filters);
      if (sessions.length > 5000) invalid('Graph output is limited to 5,000 sessions. Narrow --source, --directory, or --since.');
      return { graph: makeGraph(sessions, projects), filters };
    });
  }
  async diagnose() {
    const sources = await this.discoverSources(), checks: { name: string; ok: boolean; message: string }[] = [];
    const integrity = this.store.db.prepare('PRAGMA quick_check').all();
    checks.push({ name: 'database', ok: integrity.every(row => row.quick_check === 'ok'), message: integrity.map(row => String(row.quick_check)).join('; ') });
    for (const source of sources.sources.filter(s => s.selected)) checks.push({ name: source.id, ok: source.available && !source.error, message: source.error || (source.available ? source.description : source.id === 'opencode' ? 'No healthy local service. Open OpenCode and retry sync.' : 'History unavailable. Check the configured path and filesystem permissions.') });
    const lock = this.store.db.prepare('SELECT pid,heartbeat FROM import_lock WHERE id=1').get();
    return { ok: checks.every(c => c.ok), database: this.store.path, node: process.versions.node, configured: sources.configured, selected: this.store.selected(), autoImport: sources.autoImport,
      importLock: lock ? { pid: Number(lock.pid), heartbeat: Number(lock.heartbeat) } : null, checks,
      next: !this.store.selected().length ? 'Run sessiongraph sources setup <source...>, then sessiongraph sources sync.' : 'Run sessiongraph sources sync to refresh saved history.' };
  }
}
