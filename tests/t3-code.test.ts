import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t3CodeAdapter } from '../server/adapters/t3-code';
import { closeSqliteSnapshots } from '../server/adapters/sqlite-snapshot';
import { Importer } from '../server/importer';
import { SessionGraphStore } from '../server/store';
import { addText, blankMessage, blankSession, digest } from '../server/adapters/common';
import { sessionMatchesSource, visibleSessions } from '../src/session-links';

const at = '2026-11-03T12:00:00.000Z';
async function fixture(run: (path: string, db: DatabaseSync) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-t3-'));
  const old = process.env.SESSIONGRAPH_T3_CODE_HISTORY_DIR;
  process.env.SESSIONGRAPH_T3_CODE_HISTORY_DIR = root;
  await mkdir(join(root, 'userdata'));
  const path = join(root, 'userdata', 'statev2.sqlite'), db = new DatabaseSync(path);
  try { await run(path, db); }
  finally {
    closeSqliteSnapshots(); try { db.close(); } catch { /* The V1 fixture closes its unused V2 database. */ }
    if (old === undefined) delete process.env.SESSIONGRAPH_T3_CODE_HISTORY_DIR;
    else process.env.SESSIONGRAPH_T3_CODE_HISTORY_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
}

test('T3 V2 imports app threads, ordered activity, explicit lineage, and strong provider bindings', async () => fixture(async (path, db) => {
  db.exec(`
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, updated_at TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT, provider TEXT, payload_json TEXT);
  `);
  db.prepare('INSERT INTO projection_projects VALUES (?,?,NULL)').run('p', '/fixture/project');
  const thread = db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)');
  thread.run('parent', 'p', 'Parent', 'codex', at, at, JSON.stringify({ modelSelection: { model: 'gpt-6' }, lineage: { parentThreadId: null } }));
  thread.run('fork', 'p', 'Fork', 'claudeAgent', at, at, JSON.stringify({ worktreePath: '/fixture/worktree', lineage: { parentThreadId: 'parent', relationshipToParent: 'fork' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('parent', 'codex', JSON.stringify({ nativeThreadRef: { driver: 'codex', nativeId: 'native-codex', strength: 'strong' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('parent', 'opencode', JSON.stringify({ nativeThreadRef: { driver: 'opencode', nativeId: 'ses_native', strength: 'strong' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('fork', 'claudeAgent', JSON.stringify({ nativeThreadRef: { driver: 'claudeAgent', nativeId: 'weak-id', strength: 'weak' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('fork', 'opencode', JSON.stringify({ nativeThreadRef: { driver: 'opencode', nativeId: 'ses_weak', strength: 'weak' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('fork', 'opencode', JSON.stringify({ nativeThreadRef: { driver: 'codex', nativeId: 'ses_mismatch', strength: 'strong' } }));
  const item = db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)');
  const put = (id: string, ordinal: number, type: string, status: string, data: object) => item.run(id, 'parent', ordinal, type, status, at, JSON.stringify({ id, startedAt: at, completedAt: at, ...data }));
  put('u', 1, 'user_message', 'completed', { text: 'Please edit the file' });
  put('cmd', 2, 'command_execution', 'completed', { input: 'cat file.txt', output: 'old contents', exitCode: 7, nativeItemRef: { driver: 'codex', nativeId: 'command-native', strength: 'strong' } });
  put('edit', 3, 'file_change', 'completed', { fileName: 'file.txt' });
  put('check', 4, 'checkpoint', 'completed', { files: [{ path: 'other.txt' }] });
  put('a', 5, 'assistant_message', 'completed', { text: 'Done' });
  const before = await readFile(path);
  const found = await t3CodeAdapter.discover();
  assert.equal(found.sessions.length, 2);
  const parent = found.sessions.find(c => c.session.nativeID === 'parent')!;
  assert.deepEqual(parent.session.linkedSessionIDs, ['codex:native-codex', 'opencode:ses_native']);
  assert.equal(parent.session.model, 'gpt-6');
  assert.equal(found.sessions.find(c => c.session.nativeID === 'fork')?.session.forkID, 't3-code:parent');
  assert.equal(found.sessions.find(c => c.session.nativeID === 'fork')?.session.directory, '/fixture/worktree');
  assert.deepEqual(found.sessions.find(c => c.session.nativeID === 'fork')?.session.linkedSessionIDs, []);
  const page = await t3CodeAdapter.read(parent);
  assert.deepEqual(page.messages.map(m => m.id), ['item:u', 'item:cmd', 'item:edit', 'item:check', 'item:a']);
  assert.equal(page.messages[0].fragments[0].text, 'Please edit the file');
  assert.equal(page.messages[1].events?.[0].kind, 'tool_result');
  assert.equal(page.messages[1].events?.[0].exitCode, 7);
  assert.equal(page.messages[1].events?.[0].callID, 'command-native');
  assert.deepEqual(page.messages[2].files.map(f => f.path), ['/fixture/project/file.txt']);
  assert.deepEqual(page.messages[3].files, []);
  assert.equal(page.messages[4].events?.[0].kind, 'message');
  assert.deepEqual(await readFile(path), before);
}));

test('T3 PR links are imported, scoped to their thread, and refreshed independently of thread timestamps', async () => fixture(async (_path, db) => {
  db.exec(`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE projection_thread_pull_requests(thread_id TEXT, host TEXT, repository TEXT, number INTEGER, url TEXT, source TEXT,
      PRIMARY KEY (thread_id, host, repository, number));`);
  const thread = db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)');
  thread.run('app', 'p', 'Task', 'opencode', at, at, '{}');
  thread.run('other', 'p', 'Other', 'opencode', at, at, '{}');
  db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)').run('u', 'app', 1, 'user_message', 'completed', at, JSON.stringify({ text: 'A task', startedAt: at }));
  const put = db.prepare('INSERT INTO projection_thread_pull_requests VALUES (?,?,?,?,?,?)');
  put.run('app', 'github.com', 'Example/Repo', 7, 'https://github.com/Example/Repo/pull/7', 'manual');
  put.run('app', 'github.com', 'example/repo', 7, 'https://github.com/example/repo/pull/7', 'manual');
  put.run('app', 'github.com', 'example/repo', 8, 'https://github.com/example/repo/pull/8', 'stack-dismissed');
  put.run('app', 'github.com', 'example/repo', 9, 'javascript:alert(1)', 'manual');
  put.run('app', 'github.com', 'example/repo', 10, 'https://other.example/example/repo/pull/10', 'manual');
  put.run('other', 'git.example.com', 'example/repo', 7, 'https://git.example.com/example/repo/pull/7', 'created');
  const store = new SessionGraphStore(':memory:');
  try {
    const native = blankSession('opencode', 'native');
    store.upsert({ session: native, revision: '1', locator: {} });
    const importer = new Importer(store, [t3CodeAdapter]);
    const refresh = async () => { importer.sync(['t3-code']); await importer.settled(); assert.equal(importer.status.failed, 0); };
    await refresh();
    const original = store.detail('t3-code:app');
    assert.deepEqual(original.pullRequests, [{ host: 'github.com', repository: 'example/repo', number: 7, url: 'https://github.com/example/repo/pull/7', source: 'manual' }]);
    assert.equal(store.detail('t3-code:other').pullRequests?.[0].host, 'git.example.com');
    assert.equal(store.detail(native.id).pullRequests, undefined);
    assert.equal(store.detail('t3-code:app', '120').pullRequests, undefined);
    await refresh(); assert.equal(importer.status.unchanged, 2);
    db.exec('ALTER TABLE projection_thread_pull_requests RENAME TO unavailable');
    await refresh();
    assert.deepEqual(store.detail('t3-code:app').pullRequests, original.pullRequests);
    db.exec(`DELETE FROM unavailable WHERE thread_id='app'; ALTER TABLE unavailable RENAME TO projection_thread_pull_requests;`);
    await refresh();
    const current = store.detail('t3-code:app');
    assert.notEqual(current.revision, original.revision);
    assert.equal(current.pullRequests, undefined);
    assert.equal(current.messagesScanned, 1);
    assert.equal(store.detail('t3-code:other').pullRequests?.length, 1);
  } finally { store.close(); }
}));

test('T3 app threads replace only uniquely linked native sessions in the visible library', async () => fixture(async (_path, db) => {
  db.exec(`
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, updated_at TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads(thread_id TEXT, provider TEXT, payload_json TEXT);
  `);
  db.prepare('INSERT INTO projection_projects VALUES (?,?,NULL)').run('p', '/fixture');
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)').run('app', 'p', 'Task', 'codex', at, at, JSON.stringify({ lineage: {} }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('app', 'codex', JSON.stringify({ nativeThreadRef: { nativeId: 'native', strength: 'strong' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)').run('u', 'app', 1, 'user_message', 'completed', at, JSON.stringify({ text: 'A task', startedAt: at }));
  const store = new SessionGraphStore(':memory:');
  try {
    const native = blankSession('codex', 'native', '/fixture'); native.created = Date.parse(at);
    store.upsert({ session: native, revision: 'native', locator: { path: 'fixture' } });
    const nativeMessage = blankMessage('native-user', Date.parse(at), 'user');
    addText(nativeMessage, 'Provider-only detail', 'You');
    store.replace({ session: native, revision: 'native', locator: { path: 'fixture' } }, [nativeMessage], false);
    const child = blankSession('codex', 'child', '/fixture'); child.created = Date.parse(at); child.parentID = native.id;
    store.upsert({ session: child, revision: 'child', locator: { path: 'fixture' } });
    const importer = new Importer(store, [t3CodeAdapter]); importer.start(['t3-code']); await importer.settled();
    assert.equal(importer.status.imported, 1);
    const library = store.library([], false);
    assert.deepEqual(library.sessions.map(s => s.id).sort(), ['codex:child', 't3-code:app']);
    assert.equal(library.sessions.find(s => s.id === 'codex:child')?.parentID, 't3-code:app');
    assert.ok(sessionMatchesSource(library.sessions.find(s => s.id === 't3-code:app')!, 'codex'));
    assert.equal(store.getSession(native.id)?.id, native.id);
    const incomplete = { ...library.sessions.find(s => s.id === 't3-code:app')!, coverage: { history: 'partial' as const } };
    assert.deepEqual(visibleSessions([native, incomplete]).map(s => s.id), ['t3-code:app']);
    assert.equal(store.getSession(native.id)?.id, native.id, 'provider history stays directly accessible');
    assert.equal(store.events(native.id, { filter: 'messages' }).selected?.text, 'Provider-only detail');
    assert.equal(visibleSessions([native, incomplete, child]).find(s => s.id === child.id)?.parentID, 't3-code:app');
  } finally { store.close(); }
}));

test('T3 OpenCode edit labels stay tool activity; real file paths and other providers retain file evidence', async () => fixture(async (path, db) => {
  db.exec(`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);`);
  db.prepare('INSERT INTO projection_projects VALUES (?,?,NULL)').run('p', '/fixture');
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)').run('app', 'p', 'Task', 'opencode', at, at, '{}');
  const insert = db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)');
  let ordinal = 0;
  const put = (id: string, fileName: string, driver: string | undefined, status = 'completed') => insert.run(id, 'app', ++ordinal, 'file_change', status, at, JSON.stringify({ fileName, startedAt: at, nativeItemRef: driver ? { driver, nativeId: `call-${id}`, strength: 'strong' } : undefined }));
  for (const name of ['patch', 'apply_patch', 'edit', 'write', 'multiedit', 'Edit', 'Write']) put(`tool-${name}`, name, 'opencode');
  for (const state of ['pending', 'running', 'failed', 'unknown']) put(`tool-${state}`, 'patch', 'opencode', state);
  put('codex-patch', 'patch', 'codex');
  put('claude-edit', 'edit', 'claudeAgent');
  put('unattributed-patch', 'patch', undefined);
  put('absolute-patch', '/fixture/patch', 'opencode');
  put('relative-patch', './patch', 'opencode');
  put('nested-write', 'src/write', 'opencode');
  put('source-file', 'src/patch.ts', 'opencode');
  put('failed-file', 'failed.ts', 'codex', 'failed');
  const before = await readFile(path), candidate = (await t3CodeAdapter.discover()).sessions[0];
  const page = await t3CodeAdapter.read(candidate), byID = new Map(page.messages.map(m => [m.id, m]));
  for (const message of page.messages.filter(m => m.id.startsWith('item:tool-'))) {
    assert.deepEqual(message.files, []);
    assert.deepEqual(message.tools, [message.events![0].name]);
    assert.equal(message.events![0].nativeType, 'file_change');
    assert.equal(message.events![0].callID, `call-${message.id.slice(5)}`);
  }
  assert.equal(byID.get('item:tool-patch')!.events![0].kind, 'tool_result');
  for (const state of ['pending', 'running', 'unknown']) assert.equal(byID.get(`item:tool-${state}`)!.events![0].kind, 'tool_call');
  assert.equal(byID.get('item:tool-failed')!.events![0].kind, 'tool_result');
  assert.equal(byID.get('item:tool-failed')!.events![0].status, 'failed');
  for (const id of ['codex-patch', 'unattributed-patch', 'absolute-patch', 'relative-patch']) assert.deepEqual(byID.get(`item:${id}`)!.files, [{ path: '/fixture/patch', source: 'file change', steps: 1 }]);
  assert.equal(byID.get('item:claude-edit')!.files[0].path, '/fixture/edit');
  assert.equal(byID.get('item:nested-write')!.files[0].path, '/fixture/src/write');
  assert.equal(byID.get('item:source-file')!.files[0].path, '/fixture/src/patch.ts');
  assert.deepEqual(byID.get('item:failed-file')!.files, []);
  assert.deepEqual(await readFile(path), before);
}));

test('T3 refresh repairs old phantom file counts across pages without changed source timestamps', async () => fixture(async (path, db) => {
  db.exec(`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);`);
  db.prepare('INSERT INTO projection_projects VALUES (?,?,NULL)').run('p', '/fixture');
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)').run('app', 'p', 'Task', 'opencode', at, at, '{}');
  const insert = db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)');
  insert.run('user', 'app', 0, 'user_message', 'completed', at, JSON.stringify({ text: 'Keep this conversation', startedAt: at }));
  for (let n = 1; n <= 120; n++) insert.run(String(n), 'app', n, 'file_change', 'completed', at, JSON.stringify({ fileName: 'patch', startedAt: at, nativeItemRef: { driver: 'opencode', nativeId: `call-${n}`, strength: 'strong' } }));
  const candidate = (await t3CodeAdapter.discover()).sessions[0];
  const oldRevision = digest([at, undefined, [121, at], undefined]);
  assert.notEqual(candidate.revision, oldRevision);
  const store = new SessionGraphStore(':memory:');
  try {
    const old = { ...candidate, revision: oldRevision }, message = blankMessage('item:user', Date.parse(at), 'user');
    addText(message, 'Keep this conversation', 'You');
    const phantom = { ...blankMessage('item:1', Date.parse(at), 'tool'), files: [{ path: '/fixture/patch', source: 'file change' as const, steps: 120 }] };
    store.upsert(old); store.replace(old, [message, phantom], false);
    assert.equal(store.detail(candidate.session.id).files[0].steps, 120);
    const before = await readFile(path), importer = new Importer(store, [t3CodeAdapter]);
    importer.sync(['t3-code']); await importer.settled();
    assert.equal(importer.status.imported, 1); assert.equal(importer.status.failed, 0);
    assert.equal(store.revision(candidate.session.id), candidate.revision);
    let cursor: string | undefined, scanned = 0, patches = 0;
    do {
      const detail = store.detail(candidate.session.id, cursor);
      assert.deepEqual(detail.files, []); scanned += detail.messagesScanned;
      patches += detail.tools.find(t => t.name === 'patch')?.count ?? 0;
      cursor = detail.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(scanned, 121); assert.equal(patches, 120);
    assert.equal(store.events(candidate.session.id, { filter: 'messages' }).selected?.text, 'Keep this conversation');
    importer.sync(['t3-code']); await importer.settled();
    assert.equal(importer.status.unchanged, 1);
    assert.deepEqual(await readFile(path), before);
  } finally { store.close(); }
}));

test('T3 V1 fallback imports text with explicit partial coverage', async () => fixture(async (path, db) => {
  db.close();
  await rm(path);
  const legacy = new DatabaseSync(path.replace('statev2.sqlite', 'state.sqlite'));
  try {
    legacy.exec(`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
      CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, worktree_path TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, model_selection_json TEXT);
      CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, text TEXT, created_at TEXT, updated_at TEXT);`);
    legacy.prepare('INSERT INTO projection_projects VALUES (?,?,NULL)').run('p', '/legacy');
    legacy.prepare('INSERT INTO projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)').run('old', 'p', 'Old thread', null, at, at, '{}');
    legacy.prepare('INSERT INTO projection_thread_messages VALUES (?,?,?,?,?,?)').run('u', 'old', 'user', 'Old prompt', at, at);
    const found = await t3CodeAdapter.discover();
    assert.equal(found.sessions.length, 1);
    const page = await t3CodeAdapter.read(found.sessions[0]);
    assert.equal(page.messages[0].fragments[0].text, 'Old prompt');
    assert.equal(page.partial, true);
  } finally { legacy.close(); }
}));

test('T3 discovery includes threads past the old 20,000-thread cutoff', async () => fixture(async (_path, db) => {
  db.exec(`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT, updated_at TEXT);
    CREATE INDEX turn_item_thread ON orchestration_v2_projection_turn_items(thread_id);
    WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<20001)
      INSERT INTO orchestration_v2_projection_threads
      SELECT printf('thread-%05d',n), 'p', 'Task', 'opencode', '${at}', '${at}', NULL, NULL, '{}' FROM ids;`);
  const found = await t3CodeAdapter.discover();
  assert.equal(found.sessions.length, 20_001);
  assert.equal(found.sessions.at(-1)?.session.nativeID, 'thread-20001');
}));

test('T3 paged reads remain on one verified snapshot while the server database changes', async () => fixture(async (_path, db) => {
  db.exec(`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, updated_at TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, type TEXT, status TEXT, updated_at TEXT, payload_json TEXT);`);
  db.prepare('INSERT INTO projection_projects VALUES (?,?,NULL)').run('p', '/fixture');
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?,?,?,?,?,?,NULL,NULL,?)').run('app', 'p', 'Task', 'codex', at, at, '{}');
  const insert = db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)');
  for (let n = 1; n <= 501; n++) insert.run(String(n), 'app', n, 'assistant_message', 'completed', at, JSON.stringify({ text: `Message ${n}`, startedAt: at }));
  const candidate = (await t3CodeAdapter.discover()).sessions[0];
  const first = await t3CodeAdapter.read(candidate);
  assert.equal(first.messages.length, 100);
  insert.run('502', 'app', 502, 'assistant_message', 'completed', at, JSON.stringify({ text: 'Later message', startedAt: at }));
  const ids = first.messages.map(m => m.id); let cursor = first.cursor;
  while (cursor) { const page = await t3CodeAdapter.read(candidate, cursor); ids.push(...page.messages.map(m => m.id)); cursor = page.cursor; }
  assert.equal(ids.length, 501);
  assert.equal(ids.at(-1), 'item:501');
  const newer = (await t3CodeAdapter.discover()).sessions[0];
  assert.notEqual(newer.revision, candidate.revision);
}));

test('ambiguous or empty T3 bindings do not hide provider history', () => {
  const native = blankSession('codex', 'native');
  const first = { ...blankSession('t3-code', 'first'), linkedSessionIDs: [native.id], coverage: { history: 'complete' as const }, activity: { firstMessageAt: 1, lastMessageAt: 1, userMessages: 1, untimedUserMessages: 0 } };
  const second = { ...first, id: 't3-code:second', nativeID: 'second' };
  assert.equal(visibleSessions([native, first, second]).length, 3);
  assert.equal(visibleSessions([native, first, { ...second, coverage: { history: 'partial' } }]).length, 3);
  assert.equal(visibleSessions([native, first, { ...second, coverage: { history: 'pending' } }]).length, 3);
  assert.equal(visibleSessions([native, { ...first, activity: { ...first.activity, userMessages: 0 } }]).length, 2);
  assert.equal(visibleSessions([native, { ...first, coverage: { history: 'pending' } }]).length, 2);
  assert.equal(visibleSessions([native, { ...first, linkedSessionIDs: [native.id, native.id], coverage: { history: 'partial' } }]).length, 1);
});

test('OpenCode duplicates use explicit T3 bindings, preserve provider snapshots, and remap child and fork links', () => {
  const native = blankSession('opencode', 'ses_native', '/fixture');
  const app = { ...blankSession('t3-code', 'app', '/fixture'), linkedSessionIDs: [native.id], coverage: { history: 'partial' as const },
    activity: { firstMessageAt: 1, lastMessageAt: 2, userMessages: 1, untimedUserMessages: 0 } };
  const child = { ...blankSession('opencode', 'ses_child', '/fixture'), parentID: native.id };
  const fork = { ...blankSession('opencode', 'ses_fork', '/fixture'), forkID: native.id };
  const unrelated = { ...blankSession('opencode', 'ses_unrelated', '/fixture'), title: app.title, created: app.created };
  const visible = visibleSessions([native, app, child, fork, unrelated]);
  assert.deepEqual(visible.map(s => s.id), [app.id, child.id, fork.id, unrelated.id]);
  assert.equal(visible.find(s => s.id === child.id)?.parentID, app.id);
  assert.equal(visible.find(s => s.id === fork.id)?.forkID, app.id);
  assert.ok(sessionMatchesSource(app, 'opencode'));
  assert.ok(sessionMatchesSource(app, 't3-code'));
  assert.equal(child.parentID, native.id, 'saved provider metadata is not mutated');
  assert.equal(fork.forkID, native.id);
  assert.deepEqual(visibleSessions([native, { ...app, linkedSessionIDs: [] }]).map(s => s.id), [native.id, app.id]);
});
