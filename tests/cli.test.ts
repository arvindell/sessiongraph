import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { SessionGraphStore } from '../server/store';
import { LibraryService } from '../server/library-service';
import { Importer } from '../server/importer';
import { blankMessage, blankSession } from '../server/adapters/common';
import { codexAdapter } from '../server/adapters/codex';
import { claudeAdapter } from '../server/adapters/claude';
import { qwenAdapter } from '../server/adapters/qwen';
import { resumeArgs } from '../src/launch-links';
import type { SessionAdapter } from '../server/adapters/types';
import type { Session } from '@sessiongraph/core/types';
import { sourcePath } from '../server/source-paths';
import { runCli } from '../server/cli';
import { commands, parseCLI } from '../server/cli-schema';
import { parseDate } from '../server/library-query';

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'sessiongraph-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const adapter = (id: string): SessionAdapter => ({ id, name: id, description: 'Fixture', capabilities: { history: true, files: false, forks: true, children: true },
  async detect() { return true; }, async discover() { return { sessions: [], projects: [], warnings: [] }; }, async read() { return { messages: [] }; } });
const at = Date.parse('2026-11-05T12:00:00Z');
function save(store: SessionGraphStore, id: string, extra: Partial<Session> = {}, texts = ['first prompt', 'assistant response']) {
  const candidate = { session: { ...blankSession('codex', id, resolve('app')), created: at - 10000, updated: at + 100000, ...extra }, revision: extra.revision || 'r1', locator: {} };
  store.upsert(candidate);
  store.replace(candidate, texts.map((text, i) => ({ ...blankMessage(`message-${i}`, at - 9000 + i, i % 2 ? 'assistant' : 'user'), fragments: [{ kind: i % 2 ? 'Assistant' as const : 'You' as const, text, time: at - 9000 + i }], events: [] })), false);
  return candidate.session.id;
}

test('CLI help, catalog and docs are discoverable without opening a library or detecting sources', async () => {
  for (const args of [['--help'], ['commands', '--json'], ['docs'], ['help', 'sources', 'setup', '--json'], ...commands.map(c => [...c.name.split(' '), '--help'])]) {
    let output = '', errors = '';
    const code = await runCli(args, { stdout: s => output += s, stderr: s => errors += s, openLibrary: () => { throw new Error('Must not open'); } });
    assert.equal(code, 0, args.join(' ')); assert.equal(errors, ''); assert.ok(output.length > 100);
    if (args.includes('--json')) { const data = JSON.parse(output); assert.equal(data.schemaVersion, 1); assert.ok(data.data.commands.length); }
  }
  const catalog = JSON.parse(await capture(['commands', '--json']));
  assert.deepEqual(catalog.data.commands.map((c: any) => c.name), commands.map(c => c.name));
  assert.ok(catalog.data.commands.every((c: any) => c.result && c.effect && c.examples.length));
});

async function capture(args: string[]) { let output = ''; await runCli(args, { stdout: s => output += s }); return output; }

test('CLI parser rejects typo commands, unsupported flags, missing values and ambiguous arguments', async () => {
  const invalid = [['soruces'], ['sources', 'delete'], ['sessions', '--limti', '1'], ['sessions', '--limit', '-1'], ['sessions', '--limit', '0'], ['sessions', '--limit', '201'], ['sessions', '--source'], ['search', 'two', 'words'], ['show'], ['doctor', '--source', 'codex'], ['sources', 'setup', '--auto-import', 'maybe'], ['--version', 'sessions']];
  for (const args of invalid) {
    let out = '', errors = '';
    const code = await runCli([...args, '--json'], { stdout: s => out += s, stderr: s => errors += s, openLibrary: () => { throw new Error('Must not open'); } });
    assert.equal(code, 2, args.join(' ')); assert.equal(JSON.parse(out).error.code, 'INVALID_ARGUMENT'); assert.equal(errors, '');
  }
  assert.deepEqual(parseCLI(['sessions', '--source=codex', '--source', 'claude-code']).options.source, ['codex', 'claude-code']);
  assert.equal(parseCLI(['search', '--', '--literal-query']).args[0], '--literal-query');
  assert.throws(() => parseDate('2026-02-30', at));
  assert.throws(() => parseDate('2026-02-30T12:00:00Z', at));
  assert.throws(() => parseDate('2026-01-01T12:00:00', at));
  assert.equal(parseDate('7d', at), at - 7 * 86400_000);
  assert.equal(parseDate('2026-11-05', at, true), Date.parse('2026-11-05T23:59:59.999Z'));
});

test('source configuration is atomic, persistent, shares the import lock, and removal retains history', async t => {
  const dir = await directory(t), path = join(dir, 'sessiongraph.sqlite');
  const store = new SessionGraphStore(path), other = new SessionGraphStore(path);
  try {
  let reads = 0, unavailable = false;
  const first = adapter('codex'), second = adapter('claude-code');
  first.detect = async () => !unavailable;
  first.discover = async () => ({ projects: [], warnings: [], sessions: [{ session: blankSession('codex', 'one'), revision: 'v1', locator: {} }] });
  first.read = async () => { reads++; return { messages: [blankMessage('m', at, 'user')] }; };
  const service = new LibraryService(store, [first, second]);
  assert.equal((await service.setupSources(['codex', 'claude-code'])).selected.length, 2);
  const synced = await service.importSessions(['codex']);
  assert.equal(synced.imported, 1); assert.equal(reads, 1); assert.deepEqual(store.selected(), ['codex', 'claude-code']);
  assert.equal((await service.importSessions(['codex'])).unchanged, 1);
  await service.setupSources(['codex'], { path: dir, autoImport: false });
  assert.equal(other.setting<Record<string, string>>('sourcePaths')?.codex, dir);
  assert.equal(other.autoImportEnabled(), false);
  assert.ok(other.acquireImport());
  assert.throws(() => service.removeSources(['codex']), { code: 'IMPORT_BUSY' });
  await assert.rejects(service.setupSources(['codex'], { defaultPath: true }), { code: 'IMPORT_BUSY' });
  await assert.rejects(service.importSessions(), { code: 'IMPORT_BUSY' });
  assert.equal(store.setting<Record<string, string>>('sourcePaths')?.codex, dir);
  other.releaseImport();
  unavailable = true;
  assert.equal((await service.importSessions(['codex'])).failed, 1);
  assert.ok(store.getSession('codex:one'));
  assert.equal((await service.diagnose()).ok, false);
  service.removeSources(['codex']);
  assert.deepEqual(other.selected(), ['claude-code']); assert.deepEqual(other.setting('sourcePaths'), {});
  assert.ok(store.getSession('codex:one'));
  await assert.rejects(service.importSessions(['codex']), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.setupSources(['unknown']), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(other.selected(), ['claude-code']);
  service.removeSources([], true); assert.deepEqual(other.selected(), []); assert.ok(store.getSession('codex:one'));
  } finally { store.close(); other.close(); }
});

test('saved source paths work in the existing importer and isolate concurrent libraries', async t => {
  const dir = await directory(t), first = new SessionGraphStore(join(dir, 'one.sqlite')), second = new SessionGraphStore(join(dir, 'two.sqlite'));
  try {
  const seen: string[] = [], source = adapter('codex');
  source.detect = async () => { const path = sourcePath('codex'); await Promise.resolve(); assert.equal(sourcePath('codex'), path); seen.push(path!); return true; };
  await new LibraryService(first, [source]).setupSources(['codex'], { path: join(dir, 'first') });
  await new LibraryService(second, [source]).setupSources(['codex'], { path: join(dir, 'second') });
  await Promise.all([new Importer(first, [source]).sources(), new Importer(second, [source]).sources()]);
  assert.deepEqual(seen.sort(), [join(dir, 'first'), join(dir, 'second')].sort());
  assert.equal(sourcePath('codex'), undefined);
  } finally { first.close(); second.close(); }
});

test('CLI configured Codex paths import the actual native format and can be reset without deleting history', async t => {
  const dir = await directory(t), home = join(dir, 'codex'), library = join(dir, 'library');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const transcript = [
    { type: 'session_meta', timestamp: new Date(at).toISOString(), payload: { id: 'native-fixture', cwd: dir } },
    { type: 'response_item', timestamp: new Date(at + 1).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate OAuth callback' }] } },
  ].map(row => JSON.stringify(row)).join('\n');
  const file = join(home, 'sessions', 'fixture.jsonl'); await writeFile(file, transcript);
  const store = new SessionGraphStore(join(library, 'sessiongraph.sqlite')), service = new LibraryService(store, [codexAdapter]);
  try {
  await service.setupSources(['codex'], { path: home });
  assert.equal((await service.discoverSources()).sources[0].available, true);
  assert.equal((await service.importSessions()).imported, 1);
  assert.equal(service.searchSessions('OAuth').hits[0].id, 'codex:native-fixture');
  assert.equal(service.getSession('codex:native-fixture').nativeResume, false);
  assert.throws(() => resumeArgs(service.getSession('codex:native-fixture')), /context handoff/);
  assert.equal(await readFile(file, 'utf8'), transcript);
  await service.setupSources(['codex'], { defaultPath: true });
  assert.deepEqual(store.setting('sourcePaths'), {}); assert.ok(store.getSession('codex:native-fixture'));
  } finally { store.close(); }
});

test('custom Claude and Qwen homes use their own native IDs and transcript metadata', async t => {
  const dir = await directory(t), home = join(dir, 'archive'), path = join(home, 'projects', 'project');
  await mkdir(path, { recursive: true });
  const id = 'c50c12c3-1111-4111-8111-111111111111';
  await writeFile(join(path, `${id}.jsonl`), [
    { type: 'user', uuid: 'prompt', sessionId: id, cwd: dir, timestamp: new Date(at).toISOString(), message: { role: 'user', content: 'Unique archived request' } },
    { type: 'assistant', uuid: 'answer', parentUuid: 'prompt', sessionId: id, cwd: dir, timestamp: new Date(at + 1).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Archived answer' }] } },
  ].map(row => JSON.stringify(row)).join('\n'));
  const store = new SessionGraphStore(join(dir, 'library.sqlite')), service = new LibraryService(store, [claudeAdapter, qwenAdapter]);
  try {
  await service.setupSources(['claude-code'], { path: home });
  const result = await service.importSessions(['claude-code']); assert.equal(result.failed, 0, result.errors.join('; ')); assert.equal(result.imported, 1);
  assert.equal(service.getSession(`claude-code:${id}`).directory, dir);
  assert.equal(service.getSession(`claude-code:${id}`).nativeResume, false);
  assert.equal(service.searchSessions('archived').total, 1);
  // Qwen's registered ID is qwen-code, not the source filename's shorter name.
  await service.setupSources(['qwen-code'], { path: home });
  const sources = await service.discoverSources();
  assert.equal(sources.sources.find(s => s.id === 'qwen-code')!.available, true);
  } finally { store.close(); }
});

test('saved queries preserve explicit relationships, time semantics, unknown usage and deduplication', () => {
  const store = new SessionGraphStore(':memory:'), service = new LibraryService(store, [adapter('codex'), adapter('t3-code')]);
  try {
    const root = save(store, 'root', { tokens: null, cost: null });
    const child = save(store, 'child', { parentID: root, tokens: 0, cost: 0 });
    const fork = save(store, 'fork', { parentID: root, forkID: root, tokens: 7, cost: 2 });
    save(store, 'neighbor', { directory: resolve('app-other'), created: at - 50000, updated: at + 999999 });
    assert.equal(service.listSessions({ directory: resolve('app') }).total, 3);
    save(store, 'relative', { directory: 'relative-path', tokens: null });
    assert.equal(service.listSessions({ directory: resolve('.') }).items.some(s => s.id === 'codex:relative'), false);
    assert.equal(service.listSessions({ since: at }).total, 0, 'metadata updated time is not activity');
    const stats = service.getStats({ directory: resolve('app') });
    assert.deepEqual(stats.totals.tokens, { knownTotal: 7, knownSessions: 2, unknownSessions: 1 });
    assert.equal(service.getStats({ directory: resolve('app-other') }).totals.tokens.knownTotal, null);
    assert.equal(service.getStats({ directory: resolve('nothing') }).totals.tokens.knownTotal, 0);
    assert.deepEqual(service.getRelationships(root).items.map(r => [r.id, r.kind]), [[child, 'child'], [fork, 'fork']]);
    assert.equal(service.getGraph({ directory: resolve('app') }).graph.edges.length, 2);
    save(store, 'thread', { id: 't3-code:thread', source: 't3-code', linkedSessionIDs: [root] });
    assert.equal(service.listSessions().items.some(s => s.id === root), false);
    assert.equal(service.listSessions({ raw: true }).items.some(s => s.id === root), true);
    assert.ok(service.listSessions({ sources: ['codex'] }).items.some(s => s.id === 't3-code:thread'));
  } finally { store.close(); }
});

test('list and ranked search pagination traverse more than 250 results and reject stale or mismatched cursors', () => {
  const store = new SessionGraphStore(':memory:'), service = new LibraryService(store, [adapter('codex')]);
  try {
    for (let n = 0; n < 265; n++) save(store, String(n).padStart(3, '0'), { title: `OAuth ${n}` }, ['Matching callback']);
    let cursor: string | undefined; const listed: string[] = [], found: string[] = [];
    do { const result = service.listSessions({}, { cursor, limit: 100 }); listed.push(...result.items.map(s => s.id)); cursor = result.nextCursor || undefined; } while (cursor);
    do { const result = service.searchSessions('callback in:messages', {}, { cursor, limit: 100 }); found.push(...result.hits.map(s => s.id)); cursor = result.nextCursor || undefined; assert.equal(result.coverage.complete, 265); } while (cursor);
    assert.equal(new Set(listed).size, 265); assert.equal(new Set(found).size, 265);
    const next = service.listSessions({}, { limit: 1 }).nextCursor!;
    assert.throws(() => service.listSessions({ archived: 'only' }, { cursor: next }), { code: 'STALE_CURSOR' });
    save(store, 'new'); assert.throws(() => service.listSessions({}, { cursor: next }), { code: 'STALE_CURSOR' });
    assert.throws(() => service.listSessions({}, { cursor: 'nonsense' }), { code: 'INVALID_ARGUMENT' });
  } finally { store.close(); }
});

test('message, event and file reads reuse saved evidence with bounded text, unknown times and stale revisions', () => {
  const store = new SessionGraphStore(':memory:'), service = new LibraryService(store, [adapter('codex')]);
  try {
    const id = save(store, 'messages', {}, ['old prompt', 'x'.repeat(90000), 'latest']);
    const first = service.getMessages(id, { limit: 1 });
    assert.equal(first.messages[0].fragments[0].text, 'latest');
    const second = service.getMessages(id, { limit: 1, cursor: first.nextCursor! });
    assert.equal(second.messages[0].fragments[0].text.length, 64000); assert.equal(second.partial, true);
    assert.equal(service.getMessages(id, { cursor: second.nextCursor! }).messages[0].fragments[0].text, 'old prompt');
    assert.equal(service.getTimeline(id).totalUserMessages, 2);
    assert.deepEqual(service.getFileChanges(id).files, []);
    assert.equal(service.getEvents(id).items.length, 0, 'explicitly empty events must not be fabricated');
    save(store, 'messages', { revision: 'r2' });
    assert.throws(() => service.getMessages(id, { cursor: first.nextCursor! }), { code: 'STALE_CURSOR' });
    assert.throws(() => service.getSession('missing'), { code: 'NOT_FOUND' });
  } finally { store.close(); }
});

test('CLI JSON is a single document, relative-window cursors stay stable, and human output escapes terminal commands', async t => {
  const dir = await directory(t), path = join(dir, 'sessiongraph.sqlite'), store = new SessionGraphStore(path);
  save(store, 'one', { title: '\x1b]52;c;c2VjcmV0\x07' }); save(store, 'two'); store.close();
  async function run(args: string[], now = at) {
    let out = '', err = '';
    const code = await runCli(args, { now, stdout: s => out += s, stderr: s => err += s, openLibrary: () => new LibraryService(new SessionGraphStore(path), [adapter('codex')]) });
    return { out, err, code };
  }
  const first = await run(['sessions', '--since', '7d', '--limit', '1', '--json']);
  assert.equal(first.code, 0); assert.equal(first.err, '');
  const second = await run(['sessions', '--since', '7d', '--limit', '1', '--json', '--cursor', JSON.parse(first.out).data.nextCursor], at + 60_000);
  assert.equal(second.code, 0); assert.notEqual(JSON.parse(first.out).data.items[0].id, JSON.parse(second.out).data.items[0].id);
  const human = await run(['sessions']); assert.ok(!human.out.includes('\x1b')); assert.ok(human.out.includes('\\u001b'));
  const json = await run(['show', 'codex:one', '--json']); assert.equal(JSON.parse(json.out).data.title, '\x1b]52;c;c2VjcmV0\x07');
  const missing = await run(['show', 'absent', '--json']); assert.equal(missing.code, 1); assert.equal(JSON.parse(missing.out).error.code, 'NOT_FOUND');
});

test('standalone npm launcher loads the bundled CLI without native packages or node_modules', async t => {
  const dir = await directory(t), root = join(dir, 'package'), data = join(dir, 'data');
  await mkdir(join(root, 'bin'), { recursive: true });
  await cp('bin/sessiongraph.mjs', join(root, 'bin', 'sessiongraph.mjs'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sessiongraph', version: '9.8.7', type: 'module' }));
  await build({ entryPoints: ['server/cli.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: join(root, 'dist-server', 'cli.mjs'), banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
  const exec = promisify(execFile), bin = join(root, 'bin', 'sessiongraph.mjs');
  const options = { env: { ...process.env, SESSIONGRAPH_DATA_DIR: data }, cwd: dir, maxBuffer: 2_000_000 };
  const catalog = await exec(process.execPath, [bin, 'commands', '--json'], options);
  assert.equal(JSON.parse(catalog.stdout).data.commands.length, commands.length);
  await assert.rejects(access(data), 'help/catalog must not create a database');
  const version = await exec(process.execPath, [bin, '--version', '--json'], options);
  assert.equal(JSON.parse(version.stdout).data.version, '9.8.7');
  const empty = await exec(process.execPath, [bin, 'sessions', '--json'], options);
  assert.equal(JSON.parse(empty.stdout).data.total, 0);
  const setup = await exec(process.execPath, [bin, 'sources', 'setup', 'codex', '--path', join(dir, 'absent'), '--json'], options);
  assert.deepEqual(JSON.parse(setup.stdout).data.selected, ['codex']);
  await assert.rejects(exec(process.execPath, [bin, 'sync', '--json'], options), (error: any) => {
    assert.equal(error.code, 1); const result = JSON.parse(error.stdout); assert.equal(result.data.failed, 1); assert.equal(result.data.running, false); return true;
  });
  const removed = await exec(process.execPath, [bin, 'sources', 'remove', '--all', '--json'], options);
  assert.deepEqual(JSON.parse(removed.stdout).data.selected, []);
});
