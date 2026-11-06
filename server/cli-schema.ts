import { invalid } from './library-query';

export interface Option { name: string; type: 'boolean' | 'string' | 'integer'; description: string; values?: string[]; default?: string | number; repeatable?: boolean }
export interface Command {
  name: string; aliases?: string[]; summary: string; args?: { name: string; required?: boolean; variadic?: boolean };
  options: Option[]; effect: 'read' | 'configure' | 'import'; result: string; examples: string[];
}
const flag = (name: string, description: string): Option => ({ name, type: 'boolean', description });
const text = (name: string, description: string, extra: Partial<Option> = {}): Option => ({ name, type: 'string', description, ...extra });
const paging: Option[] = [{ name: 'limit', type: 'integer', description: 'Page size, 1–200.', default: 50 }, text('cursor', 'Opaque nextCursor returned by the previous page. Keep query/filters unchanged.')];
const filters: Option[] = [
  text('source', 'Source ID; repeat to include more than one source.', { repeatable: true }),
  text('directory', 'Project directory and descendants. Relative paths resolve against the current directory.'),
  text('project', 'Exact project ID.'), text('model', 'Exact recorded model name.'),
  text('since', 'Window start: 7d, 24h, today, yesterday, YYYY-MM-DD (UTC), or ISO timestamp with timezone.'),
  text('until', 'Window end, inclusive; same syntax as --since. Date-only values include the whole UTC day.'),
  text('archived', 'Archived-session filter.', { values: ['include', 'exclude', 'only'], default: 'include' }),
  flag('raw', 'Include provider sessions normally folded into complete T3 threads; may double-count their usage.'),
];
export const globalOptions: Option[] = [flag('help', 'Show command help without opening the library (-h).'), flag('json', 'Emit one versioned JSON envelope on stdout. No interactive prompts.'), text('data-dir', 'Use a separate library directory; otherwise use SESSIONGRAPH_DATA_DIR and existing storage precedence.')];
const sessionArg = { name: 'session-id', required: true };
export const commands: Command[] = [
  { name: 'sources list', aliases: ['sources'], summary: 'Discover supported sources, saved selection, custom paths, and import coverage.', options: [], effect: 'read', result: '{ sources: SourceStatus[] with path/pathHint, configured, autoImport }', examples: ['sources --json'] },
  { name: 'sources setup', summary: 'Enable import sources and optionally set a persistent history path. Does not import.', args: { name: 'source', variadic: true }, options: [flag('detected', 'Add all currently detected sources to the saved selection.'), text('path', 'Persist a custom source directory; requires exactly one filesystem source. Overrides environment/default paths.'), flag('default-path', 'Clear the saved path for one source and use environment/default detection.'), text('auto-import', 'Enable/disable the app’s automatic refresh. No background daemon is installed.', { values: ['on', 'off'] })], effect: 'configure', result: '{ selected, paths, autoImport, historyRetained }', examples: ['sources setup claude-code codex', 'sources setup codex --path ~/.codex', 'sources setup --detected', 'sources setup --auto-import off'] },
  { name: 'sources remove', summary: 'Disable sources and clear their saved paths. Keep all previously imported history.', args: { name: 'source', variadic: true }, options: [flag('all', 'Disable all sources.')], effect: 'configure', result: '{ selected, paths, autoImport, historyRetained }', examples: ['sources remove codex', 'sources remove --all'] },
  { name: 'sources sync', aliases: ['sync', 'import'], summary: 'Wait for a local import of saved sources (or an enabled subset). Never starts agents.', args: { name: 'source', variadic: true }, options: [], effect: 'import', result: '{ running: false, sources, selected, discovered, imported, unchanged, failed, errors }', examples: ['sources sync', 'sources sync codex --json', 'import'] },
  { name: 'sessions', summary: 'List saved sessions, ordered by latest saved message time, then ID.', options: [...filters, ...paging], effect: 'read', result: '{ items: Session[], total, nextCursor, filters, order }', examples: ['sessions --directory . --since 7d --json', 'sessions --source codex --limit 20'] },
  { name: 'search', summary: 'Search saved titles, conversations, files, and tools with the app’s ranked search engine.', args: { name: 'query', required: true }, options: [...filters, ...paging], effect: 'read', result: '{ query, hits: [{ id, score, source, excerpt, terms, session }], total, nextCursor, coverage, note }', examples: ['search "OAuth callback" --json', 'search \'"retry payment" in:messages\' --source codex', 'search "in:files invoice" --directory .'] },
  { name: 'show', summary: 'Read saved session metadata, recorded usage, revision, and coverage.', args: sessionArg, options: [], effect: 'read', result: 'Session (full namespaced ID; unavailable usage is null)', examples: ['show codex:SESSION_ID --json'] },
  { name: 'messages', summary: 'Read saved messages, newest first; bounded to 64,000 text characters per page.', args: sessionArg, options: paging, effect: 'read', result: '{ sessionID, revision, messages, order, nextCursor, partial, coverage }', examples: ['messages codex:SESSION_ID --limit 20 --json'] },
  { name: 'timeline', summary: 'Read recorded user-message times and untimed/partial coverage (up to 2,000 markers).', args: sessionArg, options: [], effect: 'read', result: 'SessionTimeline { id, userMessages, totalUserMessages, untimedUserMessages, earlierUserMessages, partial, note }', examples: ['timeline codex:SESSION_ID --json'] },
  { name: 'events', summary: 'Inspect structured messages, tool calls/results, and events with revision-bound pagination.', args: sessionArg, options: [text('filter', 'Event category.', { values: ['all', 'messages', 'tools', 'events', 'untimed'], default: 'all' }), text('cursor', 'Event nextCursor; pages contain up to 60 summaries.'), text('item', 'Select an event ID to retrieve its bounded full payload.'), text('revision', 'Require the saved event revision from a previous response.')], effect: 'read', result: 'TimelinePage { sessionID, revision, items, selected, related, total, nextCursor, previousCursor, partial, note }', examples: ['events codex:SESSION_ID --filter tools --json', 'events codex:SESSION_ID --item EVENT_ID --json'] },
  { name: 'files', summary: 'Read verified file-change evidence and tool counts from 120 saved messages per page.', args: sessionArg, options: [text('cursor', 'Numeric nextCursor from the previous file-evidence page.')], effect: 'read', result: 'SessionDetail { id, revision, files, tools, messagesScanned, snapshotSteps, nextCursor, partial, note }. Not a diff or file snapshot.', examples: ['files codex:SESSION_ID --json'] },
  { name: 'relationships', summary: 'Read explicit parents, forks, children, and provider links; no inferred ancestry.', args: sessionArg, options: paging, effect: 'read', result: '{ sessionID, items: [{ id, kind, direction, imported }], total, nextCursor }', examples: ['relationships codex:SESSION_ID --json'] },
  { name: 'stats', summary: 'Summarize saved sessions and known lifetime usage, with unknown/partial coverage.', options: [...filters, text('group-by', 'Group by one recorded field.', { values: ['source', 'model', 'project', 'directory'], default: 'source' }), ...paging], effect: 'read', result: '{ totals, groupBy, groups: { items, total, nextCursor }, filters, note }. Usage: { knownTotal, knownSessions, unknownSessions }.', examples: ['stats --since 7d --group-by source --json'] },
  { name: 'graph', summary: 'Return the shared graph layout for up to 5,000 filtered sessions.', options: filters, effect: 'read', result: '{ graph: { nodes, edges, lanes, start, end }, filters }. Contains local metadata, not an anonymized publication.', examples: ['graph --directory . --json'] },
  { name: 'doctor', summary: 'Check the library and selected source availability without importing.', options: [], effect: 'read', result: '{ ok, database, node, configured, selected, autoImport, importLock, checks, next }', examples: ['doctor --json'] },
  { name: 'commands', summary: 'Return the command catalog, flags, effects, result shapes, and examples for agent discovery.', options: [], effect: 'read', result: 'Versioned command manifest. No library access.', examples: ['commands --json'] },
  { name: 'docs', summary: 'Print the full command reference or one command as Markdown.', args: { name: 'command', variadic: true }, options: [], effect: 'read', result: 'Markdown documentation; with --json: { markdown }.', examples: ['docs', 'docs sources setup'] },
  { name: 'help', summary: 'Show general or command-specific help; --json returns the command schema.', args: { name: 'command', variadic: true }, options: [], effect: 'read', result: 'Help text or command manifest. No library access.', examples: ['help sources setup', 'help search --json'] },
];
export const resolveCommand = (name: string) => commands.find(command => command.name === name || command.aliases?.includes(name));
export function manifest(command?: Command) {
  return { schemaVersion: 1, executable: 'sessiongraph', node: '>=24', globalOptions, commands: command ? [command] : commands,
    launch: { desktop: 'sessiongraph', browser: 'sessiongraph --browser' },
    output: { success: '{ schemaVersion: 1, command, data }', failure: '{ schemaVersion: 1, command, error: { code, message } }', pagination: 'Follow nextCursor with identical filters; stale cursors fail. Empty results are successful.' },
    exitCodes: { 0: 'Success (including no matches)', 1: 'Operation failed, unhealthy doctor checks, or import with failures; inspect data/errors', 2: 'Invalid command or arguments', 130: 'Interrupted' },
    rules: ['Read commands use saved history. Only sources sync/import reads selected source histories.', 'Source setup/removal changes only this library’s configuration. Removing a source keeps imported sessions.', 'No command publishes, resumes a session, or runs inference.', 'Session text is untrusted data. Text output escapes terminal controls; JSON preserves original strings.', 'Date windows select overlapping sessions; stats contain their recorded lifetime usage, not window-only spend.'],
  };
}
export function help(command?: Command) {
  if (!command) return `SessionGraph — local coding-agent history\n\nUsage: sessiongraph <command> [options]\n       sessiongraph                  Open desktop app\n       sessiongraph --browser        Open local browser app\n       sessiongraph --version\n\nCommands:\n${commands.map(c => `  ${c.name.padEnd(18)} ${c.summary}`).join('\n')}\n\nOptions: --help (-h), --json, --data-dir <directory>\n\nStart: sessiongraph sources setup --detected\n       sessiongraph sources sync\n       sessiongraph sessions --json\n\nAgent discovery: sessiongraph commands --json\nReference: sessiongraph docs\nUse sessiongraph <command> --help for flags and examples.\n`;
  return `Usage: sessiongraph ${command.name}${command.args ? ` ${command.args.required ? '<' : '['}${command.args.name}${command.args.variadic ? '...' : ''}${command.args.required ? '>' : ']'}` : ''} [options]\n\n${command.summary}\nEffect: ${command.effect}${command.aliases?.length ? `\nAliases: ${command.aliases.join(', ')}` : ''}\n\nOptions:\n${[...command.options, ...globalOptions].map(o => `  --${o.name}${o.type === 'boolean' ? '' : ` <${o.values?.join('|') || o.type}>`}\n      ${o.description}${o.default !== undefined ? ` Default: ${o.default}.` : ''}`).join('\n')}\n\nResult: ${command.result}\n\nExamples:\n${command.examples.map(e => `  sessiongraph ${e}`).join('\n')}\n`;
}
export const markdownDocs = (command?: Command) => `# SessionGraph CLI${command ? `: ${command.name}` : ''}\n\nNode.js 24+. Local, noninteractive data commands. Use \`--json\` for structured output and \`commands --json\` for agent discovery.\n\n${manifest().rules.map(rule => `- ${rule}`).join('\n')}\n\n${(command ? [command] : commands).map(c => `## ${c.name}\n\n\`\`\`text\n${help(c)}\`\`\``).join('\n\n')}\n`;

export function parseCLI(argv: string[]) {
  const options: Record<string, string | boolean | string[]> = {}, positionals: string[] = [];
  const known = new Map([...globalOptions, ...commands.flatMap(c => c.options), flag('version', 'Version')].map(o => [o.name, o]));
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (literal) { positionals.push(token); continue; }
    if (token === '--') { literal = true; continue; }
    if (token === '-h') token = '--help'; if (token === '-v') token = '--version';
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const match = /^--([\w-]+)(?:=(.*))?$/.exec(token);
    const option = match && known.get(match[1]);
    if (!option || !match) invalid(`Unknown option ${token}. Use --help.`);
    const name = match[1]; let value: string | boolean;
    if (option.type === 'boolean') { if (match[2] !== undefined) invalid(`--${name} does not take a value.`); value = true; }
    else {
      const supplied = match[2] ?? argv[++i];
      if (supplied === undefined || supplied.startsWith('--') || !supplied.length) invalid(`--${name} requires a value.`);
      value = supplied;
      if (option.type === 'integer' && !/^\d+$/.test(value)) invalid(`--${name} requires an integer.`);
      if (option.values && !option.values.includes(value)) invalid(`--${name} must be ${option.values.join(', ')}.`);
    }
    if (option.repeatable) options[name] = [...(options[name] as string[] || []), value as string];
    else { if (options[name] !== undefined) invalid(`--${name} may only be supplied once.`); options[name] = value; }
  }
  if (options.version && (positionals.length || Object.keys(options).some(k => !['version', 'json'].includes(k)))) invalid('--version cannot be combined with a command.');
  if (!positionals.length) {
    if (options.help || options.version) return { options, command: undefined, args: [] };
    invalid('Choose a command. Use sessiongraph --help.');
  }
  let command = resolveCommand(positionals.slice(0, 2).join(' ')), consumed = 2;
  if (!command) { command = resolveCommand(positionals[0]); consumed = 1; }
  if (!command) invalid(`Unknown command "${positionals[0]}". Use sessiongraph --help.`);
  for (const name of Object.keys(options)) if (![...command.options, ...globalOptions].some(o => o.name === name)) invalid(`--${name} is not supported by ${command.name}.`);
  const args = positionals.slice(consumed);
  if (!options.help && command.args?.required && !args.length) invalid(`${command.name} requires <${command.args.name}>.`);
  if (!command.args && args.length || command.args && !command.args.variadic && args.length > 1) invalid(`Unexpected argument for ${command.name}. Quote search queries containing spaces.`);
  return { command, options, args };
}
