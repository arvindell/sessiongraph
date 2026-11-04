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
import { blankSession } from '../server/adapters/common';
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
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?,?,?)').run('fork', 'claudeAgent', JSON.stringify({ nativeThreadRef: { driver: 'claudeAgent', nativeId: 'weak-id', strength: 'weak' } }));
  const item = db.prepare('INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?,?,?)');
  const put = (id: string, ordinal: number, type: string, status: string, data: object) => item.run(id, 'parent', ordinal, type, status, at, JSON.stringify({ id, startedAt: at, completedAt: at, ...data }));
  put('u', 1, 'user_message', 'completed', { text: 'Please edit the file' });
  put('cmd', 2, 'command_execution', 'completed', { input: 'cat file.txt', output: 'old contents' });
  put('edit', 3, 'file_change', 'completed', { fileName: 'file.txt' });
  put('check', 4, 'checkpoint', 'completed', { files: [{ path: 'other.txt' }] });
  put('a', 5, 'assistant_message', 'completed', { text: 'Done' });
  const before = await readFile(path);
  const found = await t3CodeAdapter.discover();
  assert.equal(found.sessions.length, 2);
  const parent = found.sessions.find(c => c.session.nativeID === 'parent')!;
  assert.deepEqual(parent.session.linkedSessionIDs, ['codex:native-codex']);
  assert.equal(parent.session.model, 'gpt-6');
  assert.equal(found.sessions.find(c => c.session.nativeID === 'fork')?.session.forkID, 't3-code:parent');
  assert.equal(found.sessions.find(c => c.session.nativeID === 'fork')?.session.directory, '/fixture/worktree');
  assert.deepEqual(found.sessions.find(c => c.session.nativeID === 'fork')?.session.linkedSessionIDs, []);
  const page = await t3CodeAdapter.read(parent);
  assert.deepEqual(page.messages.map(m => m.id), ['item:u', 'item:cmd', 'item:edit', 'item:check', 'item:a']);
  assert.equal(page.messages[0].fragments[0].text, 'Please edit the file');
  assert.equal(page.messages[1].events?.[0].kind, 'tool_result');
  assert.deepEqual(page.messages[2].files.map(f => f.path), ['/fixture/project/file.txt']);
  assert.deepEqual(page.messages[3].files, []);
  assert.equal(page.messages[4].events?.[0].kind, 'message');
  assert.deepEqual(await readFile(path), before);
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
    store.replace({ session: native, revision: 'native', locator: { path: 'fixture' } }, [], false);
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
    assert.equal(visibleSessions([native, incomplete]).length, 2);
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
  assert.equal(visibleSessions([native, { ...first, activity: { ...first.activity, userMessages: 0 } }]).length, 2);
});
