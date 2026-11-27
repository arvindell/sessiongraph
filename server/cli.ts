import { databasePath } from './config';
import { SessionGraphStore } from './store';
import { LibraryService } from './library-service';
import { EventReadError } from './event-store';
import { invalid, LibraryError, localPath, pageLimit, parseDate, type SessionFilters } from './library-query';
import { commands, help, manifest, markdownDocs, parseCLI, resolveCommand } from './cli-schema';
import type { AddressInfo } from 'node:net';

interface CLIOptions {
  version?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  openLibrary?: (path: string) => LibraryService | Promise<LibraryService>;
  now?: number;
}
/** Escape recorded terminal control sequences in human output, preserving JSON data. */
const cell = (value: unknown) => String(value ?? 'unknown').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const table = (headers: string[], rows: unknown[][]) => [headers.join('\t'), ...rows.map(row => row.map(cell).join('\t'))].join('\n');
function human(command: string, data: any): string {
  const continuation = (value: { nextCursor?: string | null }) => value.nextCursor ? `\nNext page: --cursor ${value.nextCursor}` : '';
  if (command === 'sessions') return `${table(['ID', 'SOURCE', 'TITLE', 'DIRECTORY'], data.items.map((s: any) => [s.id, s.source, s.title, s.directory]))}\n${data.total} sessions.${continuation(data)}`;
  if (command === 'search') return `${table(['ID', 'MATCH', 'TITLE', 'EXCERPT'], data.hits.map((h: any) => [h.id, h.source, h.session.title, h.excerpt]))}\n${data.total} matches.${continuation(data)}${data.coverage.limited ? `\nPartial search coverage (${data.coverage.complete}/${data.coverage.sessions} sessions complete). ${data.note}` : ''}`;
  if (command === 'sources list') return `${table(['SOURCE', 'SELECTED', 'AVAILABLE', 'SESSIONS', 'PATH'], data.sources.map((s: any) => [s.id, s.selected ? 'yes' : 'no', s.available ? 'yes' : 'no', s.sessions, s.path || '(automatic)']))}\nAuto-import: ${data.autoImport ? 'on' : 'off'}.`;
  if (command === 'sources setup' || command === 'sources remove') {
    const status = `Sources: ${data.selected.join(', ') || '(none)'}\nAuto-import: ${data.autoImport ? 'on' : 'off'}`;
    return status + (command === 'sources remove' ? '\nSaved history kept.' : data.selected.length ? '\nRun sessiongraph sync to import sessions.' : '');
  }
  if (command === 'sources sync') return [
    `Imported ${data.imported}; unchanged ${data.unchanged}; failed ${data.failed}; discovered ${data.discovered}.`,
    ...data.errors.map(cell), ...(data.warnings || []).map((warning: string) => `Warning: ${cell(warning)}`),
  ].join('\n');
  if (command === 'stats') {
    const metric = (v: any) => `${v.knownTotal ?? 'unknown'} (${v.unknownSessions} unknown)`;
    return `${data.totals.sessions} sessions\n${table([data.groupBy.toUpperCase(), 'SESSIONS', 'TOKENS', 'COST'], data.groups.items.map((g: any) => [g.key, g.sessions, metric(g.tokens), metric(g.cost)]))}${continuation(data.groups)}\n${data.note}`;
  }
  if (command === 'messages') return `${data.messages.map((m: any) => `[${cell(m.id)}] ${cell(m.role)} · ${m.time ? new Date(m.time).toISOString() : 'time unknown'}\n${m.fragments.map((f: any) => `${cell(f.kind)}: ${cell(f.text)}${f.truncated ? ' [truncated]' : ''}`).join('\n')}`).join('\n\n')}${continuation(data)}${data.partial ? '\nPartial history or truncated text. Use events for details.' : ''}`;
  if (command === 'doctor') return `${data.ok ? 'OK' : 'Needs attention'} — ${cell(data.database)}\n${table(['CHECK', 'STATUS', 'DETAIL'], data.checks.map((c: any) => [c.name, c.ok ? 'ok' : 'failed', c.message]))}${data.next ? `\n${data.next}` : ''}`;
  if (command === 'commands') return table(['COMMAND', 'EFFECT', 'DESCRIPTION'], commands.map(c => [c.name, c.effect, c.summary]));
  return JSON.stringify(data, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, cell);
}

/** Noninteractive command runner shared by the npm entry point and fixture tests. */
export async function runCli(argv: string[], io: CLIOptions = {}): Promise<number> {
  const stdout = io.stdout || (text => { process.stdout.write(text); }), stderr = io.stderr || (text => { process.stderr.write(text); });
  let command = 'cli', json = argv.includes('--json'), library: LibraryService | undefined;
  const emit = (data: unknown, text?: string) => stdout((json ? JSON.stringify({ schemaVersion: 1, command, data }) : text ?? human(command, data)) + '\n');
  try {
    const parsed = parseCLI(argv), options = parsed.options, args = parsed.args;
    json = options.json === true;
    const definition = parsed.command;
    command = definition?.name || (options.version ? 'version' : 'help');
    if (options.version) { emit({ version: io.version || 'development' }, `SessionGraph ${io.version || 'development'}`); return 0; }
    if (!definition || options.help || command === 'help') {
      const target = command === 'help' && args.length ? resolveCommand(args.join(' ')) : command === 'help' ? undefined : definition;
      if (command === 'help' && args.length && !target) invalid('Unknown help topic. Use sessiongraph commands.');
      emit(manifest(target), help(target)); return 0;
    }
    if (command === 'commands') { emit(manifest()); return 0; }
    if (command === 'docs') {
      const target = args.length ? resolveCommand(args.join(' ')) : undefined;
      if (args.length && !target) invalid('Unknown documentation topic. Use sessiongraph commands.');
      const markdown = markdownDocs(target); emit({ markdown }, markdown); return 0;
    }
    const text = (name: string) => options[name] as string | undefined;
    const version = io.version || 'development';
    const port = Number(text('port') ?? 4783);
    const directory = text('data-dir');
    const path = databasePath(directory ? { ...process.env, SESSIONGRAPH_DATA_DIR: localPath(directory) } : process.env);
    if (command === 'api') {
      if (directory) invalid('Use --port to select a running API.');
      const { getLocalApi } = await import('./agent-http');
      const result = await getLocalApi(port, args[0]);
      stdout(JSON.stringify(result.body, null, json ? undefined : 2) + '\n'); return result.ok ? 0 : 1;
    }
    if (command === 'serve' || command === 'mcp') {
      if (command === 'mcp' && json) invalid('Use mcp without --json for the stdio protocol.');
      const http = command === 'serve' ? await import('./agent-http') : undefined;
      const credential = http?.apiCredential(process.env);
      if (http && (!Number.isInteger(port) || port > 65535)) invalid('Port must be 0–65535.');
      library = io.openLibrary ? await io.openLibrary(path) : new LibraryService(new SessionGraphStore(path), (await import('./adapters')).adapters);
      library.store.db.exec('PRAGMA query_only=ON');
      if (http && credential) {
        const server = await http.startAgentHttp(library, port, credential, version);
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const closed = new Promise<void>(resolve => server.once('close', resolve));
        const stop = () => { server.close(); server.closeAllConnections(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        try { if (json) emit({ url }); else stderr(`Listening on ${url}\n`); await closed; }
        finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      } else await (await import('./agent-mcp')).runAgentMcp(library, version);
      return 0;
    }
    let now = io.now ?? Date.now(), cursor = text('cursor');
    const windowCursor = ['sessions', 'search', 'stats'].includes(command);
    if (windowCursor && cursor) {
      try {
        if (cursor.length > 1024 || !/^[\w-]+$/.test(cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.version !== 1 || !Number.isSafeInteger(value.at) || value.at < 0 || typeof value.cursor !== 'string' || !value.cursor) throw new Error();
        now = value.at; cursor = value.cursor;
      } catch { invalid('Invalid cursor. Use nextCursor from the previous response.'); }
    }
    const filters: SessionFilters = {
      sources: options.source as string[] | undefined, directory: text('directory') ? localPath(text('directory')!) : undefined,
      project: text('project'), model: text('model'), archived: text('archived') as SessionFilters['archived'], raw: options.raw === true,
      since: text('since') ? parseDate(text('since')!, now) : undefined, until: text('until') ? parseDate(text('until')!, now, true) : undefined,
    };
    if (filters.since !== undefined && filters.until !== undefined && filters.since > filters.until) invalid('--since must not be later than --until.');
    const paging = { limit: text('limit') ? pageLimit(Number(text('limit'))) : undefined, cursor };
    library = io.openLibrary ? await io.openLibrary(path) : new LibraryService(new SessionGraphStore(path), (await import('./adapters')).adapters);
    let data: unknown;
    switch (command) {
      case 'sources list': data = await library.discoverSources(); break;
      case 'sources setup': data = await library.setupSources(args, { detected: options.detected === true, path: text('path'), defaultPath: options['default-path'] === true, autoImport: options['auto-import'] === undefined ? undefined : options['auto-import'] === 'on' }); break;
      case 'sources remove': data = library.removeSources(args, options.all === true); break;
      case 'sources sync':
        if (!json) stderr('Syncing local sources…\n');
        data = await library.importSessions(args); break;
      case 'sessions': data = library.listSessions(filters, paging); break;
      case 'search': data = library.searchSessions(args[0], filters, paging); break;
      case 'show': data = library.getSession(args[0]); break;
      case 'messages': data = library.getMessages(args[0], paging); break;
      case 'timeline': data = library.getTimeline(args[0]); break;
      case 'commits': data = library.getCommits(args[0], paging); break;
      case 'events': data = library.getEvents(args[0], { cursor: text('cursor'), item: text('item'), filter: text('filter'), revision: text('revision') }); break;
      case 'files': data = library.getFileChanges(args[0], text('cursor')); break;
      case 'relationships': data = library.getRelationships(args[0], paging); break;
      case 'stats': data = library.getStats(filters, text('group-by'), paging); break;
      case 'graph': data = library.getGraph(filters); break;
      case 'doctor': data = await library.diagnose(); break;
      default: return invalid('Unknown command.');
    }
    if (windowCursor) {
      const result = (command === 'stats' ? (data as { groups: unknown }).groups : data) as { nextCursor: string | null };
      if (result.nextCursor) result.nextCursor = Buffer.from(JSON.stringify({ version: 1, at: now, cursor: result.nextCursor })).toString('base64url');
    }
    emit(data);
    return command === 'sources sync' && (data as { failed: number }).failed > 0 || command === 'doctor' && !(data as { ok: boolean }).ok ? 1 : 0;
  } catch (error) {
    const failure = error instanceof LibraryError ? error : error instanceof EventReadError ? new LibraryError(error.status === 409 ? 'STALE_CURSOR' : error.status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT', error.message, error.status === 400 ? 2 : 1)
      : new LibraryError('OPERATION_FAILED', error instanceof Error ? error.message : 'Local operation failed.');
    if (json) stdout(JSON.stringify({ schemaVersion: 1, command, error: { code: failure.code, message: failure.message } }) + '\n');
    else stderr(`sessiongraph: ${cell(failure.message)}\n`);
    return failure.exitCode;
  } finally { library?.store.close(); }
}
