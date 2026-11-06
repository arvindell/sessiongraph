import { databasePath } from './config';
import { SessionGraphStore } from './store';
import { LibraryService } from './library-service';
import { EventReadError } from './event-store';
import { invalid, LibraryError, localPath, pageLimit, parseDate, type SessionFilters } from './library-query';
import { commands, help, manifest, markdownDocs, parseCLI, resolveCommand } from './cli-schema';

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
  if (command === 'search') return `${table(['ID', 'MATCH', 'TITLE', 'EXCERPT'], data.hits.map((h: any) => [h.id, h.source, h.session.title, h.excerpt]))}\n${data.total} matches; ${data.coverage.complete}/${data.coverage.sessions} sessions fully indexed.${continuation(data)}\n${data.note}`;
  if (command === 'sources list') return `${table(['SOURCE', 'SELECTED', 'AVAILABLE', 'SESSIONS', 'PATH'], data.sources.map((s: any) => [s.id, s.selected ? 'yes' : 'no', s.available ? 'yes' : 'no', s.sessions, s.path || '(automatic)']))}\n${data.sources.length} supported sources. Auto-import: ${data.autoImport ? 'on' : 'off'}.\nUse --json for capabilities, import errors, and path hints.`;
  if (command === 'sources setup' || command === 'sources remove') return `Selected sources: ${data.selected.join(', ') || '(none)'}\nAuto-import: ${data.autoImport ? 'on' : 'off'}\nSaved history retained. Run sessiongraph sources sync to refresh.`;
  if (command === 'sources sync') return `Imported ${data.imported}; unchanged ${data.unchanged}; failed ${data.failed}; discovered ${data.discovered}.\n${data.errors.map(cell).join('\n')}`;
  if (command === 'stats') {
    const metric = (v: any) => `${v.knownTotal ?? 'unknown'} (${v.unknownSessions} unknown)`;
    return `${data.totals.sessions} sessions\n${table([data.groupBy.toUpperCase(), 'SESSIONS', 'TOKENS', 'COST'], data.groups.items.map((g: any) => [g.key, g.sessions, metric(g.tokens), metric(g.cost)]))}${continuation(data.groups)}\n${data.note}`;
  }
  if (command === 'messages') return `${data.messages.map((m: any) => `[${cell(m.id)}] ${cell(m.role)} · ${m.time ? new Date(m.time).toISOString() : 'time unknown'}\n${m.fragments.map((f: any) => `${cell(f.kind)}: ${cell(f.text)}${f.truncated ? ' [truncated]' : ''}`).join('\n')}`).join('\n\n')}${continuation(data)}${data.partial ? '\nPartial saved history or shortened content. Inspect events for structured details.' : ''}`;
  if (command === 'doctor') return `${data.ok ? 'OK' : 'Needs attention'} — ${cell(data.database)}\n${table(['CHECK', 'STATUS', 'DETAIL'], data.checks.map((c: any) => [c.name, c.ok ? 'ok' : 'failed', c.message]))}\n${data.next}`;
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
    const directory = text('data-dir');
    const path = databasePath(directory ? { ...process.env, SESSIONGRAPH_DATA_DIR: localPath(directory) } : process.env);
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
