import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opencodeAdapter, openCodeDatabases } from '../server/adapters/opencode';
import { closeSqliteSnapshots } from '../server/adapters/sqlite-snapshot';
import { withSourcePaths } from '../server/source-paths';
import { SessionGraphStore } from '../server/store';
import { Importer } from '../server/importer';
import { LibraryService } from '../server/library-service';
import type { ImportedMessage, SessionAdapter } from '../server/adapters/types';

const at = 1_790_000_000_000;
const json = JSON.stringify;
const tokens = { input: 50, output: 20, reasoning: 5, cache: { read: 100, write: 10 } };

async function fixture(run: (root: string, path: string, db: DatabaseSync, adapter: SessionAdapter) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-opencode-')), path = join(root, 'opencode.db'), db = new DatabaseSync(path);
  const adapter = withSourcePaths(opencodeAdapter, () => ({ opencode: root }));
  try { await run(root, path, db, adapter); }
  finally { closeSqliteSnapshots(); try { db.close(); } catch { /* Some tests import a closed database. */ } await rm(root, { recursive: true, force: true }); }
}

function schema(db: DatabaseSync, version: 1 | 2, split = true) {
  const session = version === 1 ? 'session' : 'session_v2', message = version === 1 ? 'message' : 'session_message', part = version === 1 ? 'part' : 'session_part';
  db.exec(`CREATE TABLE ${session}(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, ${version === 2 ? 'fork_session_id TEXT,' : ''}
    directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER
    ${version === 2 ? ', model TEXT, agent TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER' : ''});
    CREATE TABLE ${message}(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, ${version === 2 ? 'type TEXT, seq INTEGER,' : ''} data TEXT);
    CREATE INDEX ${message}_session_idx ON ${message}(session_id);`);
  if (split) db.exec(`CREATE TABLE ${part}(${version === 1 ? 'id TEXT PRIMARY KEY,' : 'ordinal INTEGER,'} message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE INDEX ${part}_message_idx ON ${part}(message_id);`);
}

function session(db: DatabaseSync, version: 1 | 2, id = 'ses_test', extra: { parent?: string; fork?: string; title?: string } = {}) {
  db.prepare(version === 1 ? 'INSERT INTO session VALUES (?,?,?,?,?,?,?,?)' : 'INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(...[id, 'project', extra.parent || null, ...(version === 2 ? [extra.fork || null] : []),
      '/fixture/worktree', extra.title || 'Offline history', at, at + 500, at + 600,
      ...(version === 2 ? [json({ id: 'v2-model', providerID: 'provider' }), 'build', 0.5, 50, 20, 5, 100, 10] : [])]);
}

function message(db: DatabaseSync, version: 1 | 2, id: string, body: object, parts: object[] = [], sessionID = 'ses_test', seq = 1) {
  const table = version === 1 ? 'message' : 'session_message', part = version === 1 ? 'part' : 'session_part';
  db.prepare(`INSERT INTO ${table} VALUES (${version === 1 ? '?,?,?,?,?' : '?,?,?,?,?,?,?'})`)
    .run(id, sessionID, at + seq, at + seq, ...(version === 2 ? [(body as { type?: string }).type || 'assistant', seq] : []), json(body));
  parts.forEach((value, i) => db.prepare(`INSERT INTO ${part} VALUES (?,?,?,?,?,?)`)
    .run(version === 1 ? `${id}-${String(i).padStart(3, '0')}` : i, id, sessionID, at + seq, at + seq, json(value)));
}

async function importAll(adapter: SessionAdapter) {
  const store = new SessionGraphStore(':memory:'), importer = new Importer(store, [adapter]);
  importer.start(['opencode']); await importer.settled();
  return { store, importer };
}

test('OpenCode V1 imports closed SQLite history without any service or fetch', async () => fixture(async (_root, path, db, adapter) => {
  schema(db, 1); session(db, 1, 'ses_parent'); session(db, 1, 'ses_test', { parent: 'ses_parent' });
  message(db, 1, 'user', { role: 'user', time: { created: at + 10 }, model: { modelID: 'v1-model', providerID: 'provider' }, agent: 'build' },
    [{ type: 'text', text: 'Find the offline prompt' }], 'ses_test', 10);
  message(db, 1, 'assistant', { role: 'assistant', time: { created: at + 20, completed: at + 30 }, modelID: 'v1-model', providerID: 'provider',
    agent: 'build', finish: 'stop', path: { cwd: '/fixture/worktree', root: '/fixture' }, tokens, cost: 0.5 }, [
    { type: 'text', text: 'Done offline', time: { start: at + 21, end: at + 22 } },
    { type: 'tool', callID: 'call_write', tool: 'write', state: { status: 'completed', input: { filePath: 'saved.ts' }, output: 'Saved file', time: { start: at + 23, end: at + 24 } } },
    { type: 'tool', callID: 'call_read', tool: 'read', state: { status: 'completed', input: { filePath: 'not-edited.ts' }, output: 'Read file', time: { start: at + 24, end: at + 25 } } },
    { type: 'tool', callID: 'call_error', tool: 'edit', state: { status: 'error', input: { filePath: 'failed.ts' }, error: 'Failed', time: { start: at + 25, end: at + 26 } } },
    { type: 'tool', callID: 'call_commit', tool: 'bash', state: { status: 'completed', input: { command: 'git commit -m Saved' }, output: '[main abc1234] Saved\n 1 file changed',
      metadata: { exit: 0 }, time: { start: at + 26, end: at + 27 } } },
  ], 'ses_test', 20);
  db.close();
  const before = await readFile(path), fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline imports must not make network calls'); };
  let result: Awaited<ReturnType<typeof importAll>> | undefined;
  try {
    assert.equal(await adapter.detect(), true);
    result = await importAll(adapter);
    assert.equal(result.importer.status.failed, 0, json(result.importer.status.errors));
    const saved = result.store.getSession('opencode:ses_test')!;
    assert.equal(saved.parentID, 'opencode:ses_parent'); assert.equal(saved.forkID, undefined);
    assert.equal(saved.archived, true); assert.equal(saved.tokens, 180); assert.equal(saved.cost, 0.5);
    assert.equal(saved.model, 'v1-model'); assert.equal(saved.coverage?.history, 'complete');
    const messages = result.store.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal').all(saved.id).map(row => JSON.parse(String(row.data)) as ImportedMessage);
    assert.deepEqual(messages.map(m => m.id), ['user', 'assistant']);
    assert.equal(messages[0].fragments[0].text, 'Find the offline prompt');
    assert.ok(messages[1].fragments.some(f => f.text === 'Saved file'));
    assert.deepEqual(messages[1].files.map(f => f.path), ['saved.ts']);
    assert.equal(messages[1].metadata?.cwd, '/fixture/worktree');
    const events = messages[1].events!;
    assert.equal(events.find(e => e.kind === 'tool_result' && e.callID === 'call_write')?.time, at + 24);
    assert.equal(events.find(e => e.kind === 'tool_result' && e.callID === 'call_error')?.status, 'failed');
    assert.equal(result.store.commits(saved.id).items[0]?.repositoryPath, '/fixture/worktree');
    assert.equal(result.store.commits(saved.id).items[0]?.sha, 'abc1234');
    assert.deepEqual(await readFile(path), before);
  } finally { globalThis.fetch = fetch; result?.store.close(); }
}));

test('OpenCode V2 reads WAL-only writes, split parts in ordinal order, inline tails, projects, and explicit lineage', async () => fixture(async (root, path, db, adapter) => {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  schema(db, 2);
  db.exec('CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT, worktree TEXT, sandboxes TEXT);');
  db.prepare('INSERT INTO project VALUES (?,?,?,?)').run('project', 'Repo name', '/fixture', json(['/fixture/worktree']));
  session(db, 2, 'ses_test', { parent: 'ses_parent', fork: 'ses_fork' });
  message(db, 2, 'user', { type: 'user', text: 'Split history', time: { created: at + 1 } }, [], 'ses_test', 1);
  message(db, 2, 'assistant', { type: 'assistant', time: { created: at + 2 }, content: [{ type: 'text', text: 'Inline tail' }] }, [
    { type: 'text', text: 'First part' }, { type: 'text', text: 'Second part' },
    { type: 'tool', id: 'shell', name: 'shell', time: { created: at + 3, completed: at + 4 }, state: { status: 'completed',
      input: { command: 'echo offline', workdir: '/fixture' }, metadata: { exit: 0 }, content: [{ type: 'text', text: 'offline' }] } },
  ], 'ses_test', 2);
  const files = await readdir(root);
  const before = await Promise.all(files.map(async name => ({ name, bytes: await readFile(join(root, name)), modified: (await stat(join(root, name))).mtimeMs })));
  const found = await adapter.discover();
  assert.deepEqual(found.errors, []);
  assert.equal(found.sessions[0].session.forkID, 'opencode:ses_fork');
  assert.equal(found.sessions[0].session.parentID, 'opencode:ses_parent');
  assert.equal(found.sessions[0].session.projectID, 'opencode:project');
  assert.deepEqual(found.projects[0].worktrees, ['/fixture/worktree']);
  const page = await adapter.read(found.sessions[0]);
  assert.deepEqual(page.messages.map(m => m.id), ['assistant', 'user']);
  assert.deepEqual(page.messages[0].fragments.filter(f => f.kind === 'Assistant').map(f => f.text), ['First part', 'Second part', 'Inline tail']);
  assert.equal(page.messages[0].events!.find(e => e.kind === 'tool_result')?.exitCode, 0);
  assert.equal(found.sessions[0].session.tokens, 180);
  for (const file of before) {
    assert.deepEqual(await readFile(join(root, file.name)), file.bytes, file.name);
    assert.equal((await stat(join(root, file.name))).mtimeMs, file.modified, file.name);
  }
  assert.deepEqual(await readdir(root), files);
}));

test('OpenCode supports pre-split V2 content and V1/V2 coexistence without duplicate native sessions', async () => fixture(async (_root, _path, db, adapter) => {
  schema(db, 1); schema(db, 2, false);
  session(db, 1); session(db, 1, 'ses_legacy'); session(db, 2, 'ses_test', { title: 'Migrated V2' });
  message(db, 1, 'old', { role: 'user' }, [{ type: 'text', text: 'Stale V1' }]);
  message(db, 1, 'legacy', { role: 'user' }, [{ type: 'text', text: 'Unmigrated V1' }], 'ses_legacy');
  message(db, 2, 'new', { type: 'assistant', time: { created: at + 1 }, content: [{ type: 'text', text: 'Inline V2' }] });
  const found = await adapter.discover();
  assert.equal(found.sessions.length, 2);
  const migrated = found.sessions.find(c => c.session.nativeID === 'ses_test')!;
  assert.equal(migrated.session.title, 'Migrated V2');
  assert.equal((await adapter.read(migrated)).messages[0].fragments[0].text, 'Inline V2');
  const legacy = found.sessions.find(c => c.session.nativeID === 'ses_legacy')!;
  assert.equal((await adapter.read(legacy)).messages[0].fragments[0].text, 'Unmigrated V1');
}));

test('OpenCode V1 snapshots remain authoritative and usage is not counted twice from step parts', async () => fixture(async (_root, _path, db, adapter) => {
  schema(db, 1); session(db, 1);
  message(db, 1, 'assistant', { role: 'assistant', tokens, cost: 0.5 }, [
    { type: 'step-start', snapshot: 'before' },
    { type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: 'fallback.ts' }, output: 'Saved' } },
    { type: 'patch', hash: 'patch', files: ['authoritative.ts'] },
    { type: 'step-finish', snapshot: 'after', tokens, cost: 0.5 },
  ]);
  const found = await adapter.discover(), page = await adapter.read(found.sessions[0]);
  assert.deepEqual(page.messages[0].files.map(f => [f.path, f.source]), [['authoritative.ts', 'snapshot']]);
  assert.equal(page.messages[0].usage?.total, 180); assert.equal(page.messages[0].snapshots, 1);
}));

test('OpenCode pages are pinned to one private snapshot and unrelated sessions do not invalidate revisions', async () => fixture(async (_root, _path, db, adapter) => {
  schema(db, 2); session(db, 2); session(db, 2, 'ses_other');
  for (let i = 0; i < 125; i++) message(db, 2, `m${i}`, { type: 'user', text: `Prompt ${i}` }, [], 'ses_test', i);
  const found = await adapter.discover(), candidate = found.sessions.find(c => c.session.nativeID === 'ses_test')!;
  const first = await adapter.read(candidate);
  assert.equal(first.messages.length, 60); assert.equal(first.cursor, '60');
  message(db, 2, 'new', { type: 'user', text: 'Not in the pinned copy' }, [], 'ses_other', 200);
  const second = await adapter.read(candidate, first.cursor), third = await adapter.read(candidate, second.cursor);
  assert.equal(second.messages.length, 60); assert.equal(third.messages.length, 5); assert.equal(third.cursor, undefined);
  assert.equal(new Set([...first.messages, ...second.messages, ...third.messages].map(m => m.id)).size, 125);
  const refreshed = await adapter.discover();
  assert.equal(refreshed.sessions.find(c => c.session.nativeID === 'ses_test')!.revision, candidate.revision);
  const other = refreshed.sessions.find(c => c.session.nativeID === 'ses_other')!;
  assert.notEqual(other.revision, found.sessions.find(c => c.session.nativeID === 'ses_other')!.revision);
  await assert.rejects(adapter.read(candidate, 'bad'), /cursor/);
  await assert.rejects(adapter.read(candidate), /changed during import/);
}));

test('OpenCode fails safely on corrupt or oversized history and retains previously imported messages', async () => fixture(async (_root, _path, db, adapter) => {
  schema(db, 1); session(db, 1);
  message(db, 1, 'user', { role: 'user' }, [{ type: 'text', text: 'Keep this saved history' }]);
  const { store, importer } = await importAll(adapter);
  try {
    assert.equal(importer.status.failed, 0);
    db.prepare('UPDATE part SET data=?, time_updated=?').run('not JSON', at + 100);
    importer.start(['opencode']); await importer.settled();
    assert.equal(importer.status.failed, 1);
    assert.equal(store.messages('opencode:ses_test').messages[0].fragments[0].text, 'Keep this saved history');
    db.prepare('UPDATE part SET data=?, time_updated=?').run(json({ type: 'text', text: 'x'.repeat(4_000_001) }), at + 200);
    importer.start(['opencode']); await importer.settled();
    assert.equal(importer.status.failed, 1); assert.match(importer.status.errors.join(' '), /oversized/);
    assert.equal(store.messages('opencode:ses_test').messages[0].fragments[0].text, 'Keep this saved history');
  } finally { store.close(); }
}));

test('OpenCode discovery respects XDG, OPENCODE_DB and library path overrides without creating missing files', async () => fixture(async (root, path, db) => {
  schema(db, 1); session(db, 1);
  const old = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENCODE_DB: process.env.OPENCODE_DB, SESSIONGRAPH_OPENCODE_HISTORY_DIR: process.env.SESSIONGRAPH_OPENCODE_HISTORY_DIR };
  const store = new SessionGraphStore(':memory:'), service = new LibraryService(store, [opencodeAdapter]);
  try {
    delete process.env.SESSIONGRAPH_OPENCODE_HISTORY_DIR; delete process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = join(root, 'xdg');
    assert.deepEqual(await openCodeDatabases(), []);
    await mkdir(join(root, 'xdg', 'opencode'), { recursive: true });
    await writeFile(join(root, 'xdg', 'opencode', 'opencode.db'), '');
    assert.deepEqual(await openCodeDatabases(), [join(root, 'xdg', 'opencode', 'opencode.db')]);
    process.env.OPENCODE_DB = path;
    assert.deepEqual(await openCodeDatabases(), [path]);
    await service.setupSources(['opencode'], { path });
    const sources = await service.discoverSources();
    assert.equal(sources.sources[0].pathSupported, true); assert.equal(sources.sources[0].available, true);
    assert.deepEqual((await service.importer.adapters[0].discover()).sessions[0].session.nativeResume, false);
    process.env.OPENCODE_DB = join(root, 'missing.db');
    assert.deepEqual(await openCodeDatabases(), []);
    assert.equal((await service.discoverSources()).sources[0].available, true);
    await service.setupSources(['opencode'], { defaultPath: true });
    assert.equal((await service.discoverSources()).sources[0].available, false);
    assert.equal((await readdir(root)).includes('missing.db'), false);
  } finally {
    store.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}));

test('OpenCode reports unsupported databases rather than consulting a service', async () => fixture(async (_root, _path, db, adapter) => {
  db.exec('CREATE TABLE unrelated(id TEXT);');
  assert.equal(await adapter.detect(), true);
  const found = await adapter.discover();
  assert.equal(found.sessions.length, 0); assert.match(found.errors!.join(' '), /Unsupported OpenCode database schema/);
}));

test('OpenCode does not substitute retained V1 rows for unreadable migrated V2 metadata', async () => fixture(async (_root, _path, db, adapter) => {
  schema(db, 1); schema(db, 2); session(db, 1); session(db, 2);
  message(db, 1, 'stale', { role: 'user' }, [{ type: 'text', text: 'Do not restore this stale V1 row' }]);
  db.prepare('UPDATE session_v2 SET model=?').run('not JSON');
  const found = await adapter.discover();
  assert.equal(found.sessions.length, 0); assert.match(found.errors!.join(' '), /unreadable session metadata/);
}));
