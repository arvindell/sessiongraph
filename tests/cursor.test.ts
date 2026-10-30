import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCursorAdapter } from '../server/adapters/cursor';
import { cursorEnvelopeTime, cursorMessage } from '../server/adapters/cursor-message';
import { cursorStoreMetadata, readCursorStore } from '../server/adapters/cursor-store';
import { Importer } from '../server/importer';
import { SessionAtlasStore } from '../server/store';
import { blankSession } from '../server/adapters/common';
import { prepareLaunch } from '../server/launch';
import type { ImportedMessage } from '../server/adapters/types';

const at = Date.UTC(2026, 7, 31, 2, 51);
const user = (text = 'Continue 星🌌é', extra = {}) => ({ role: 'user', message: { content: [{ type: 'text', text }] }, ...extra });
const write = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const lines = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const ref = (field: number, id: string) => Buffer.concat([Buffer.from([field * 8 + 2, 32]), Buffer.from(id, 'hex')]);
const uint = (value: number) => { const out = []; do { out.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value); return Buffer.from(out); };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-cursor-test-'));
  const home = join(dir, 'cursor'), userData = join(dir, 'editor'), directory = join(dir, 'my-project');
  const bucket = directory.replace(/^\/+|\/+$/g, '').replace(/[/:\\]+/g, '-');
  await mkdir(directory, { recursive: true });
  await write(join(userData, 'User/workspaceStorage/one/workspace.json'), JSON.stringify({ folder: pathToFileURL(directory).href }));
  return { dir, home, userData, directory, transcripts: join(home, 'projects', bucket, 'agent-transcripts'), adapter: createCursorAdapter({ home, userData }) };
}

async function database(path: string, id = 'native', wal = false) {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
  const blob = (data: Buffer) => { const id = hash(data); db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)').run(id, data); return id; };
  const leaf = (value: unknown, wrapped = false) => {
    const data = Buffer.from(JSON.stringify(value));
    return blob(wrapped ? Buffer.concat([Buffer.from([0x22]), uint(data.length), data]) : data);
  };
  const commit = (root: string) => db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('0', Buffer.from(JSON.stringify({ agentId: id, latestRootBlobId: root, name: 'Store fixture', createdAt: at })).toString('hex'));
  return { db, blob, leaf, commit };
}

test('Cursor normalizes human envelopes and native IDs without inventing timing or successful edits', () => {
  assert.equal(cursorEnvelopeTime('<timestamp>Sunday, Aug 30, 2026, 8:51 PM (UTC-6)</timestamp>'), at);
  assert.equal(cursorEnvelopeTime('<timestamp>Aug 31, 2026, 8:21 AM (UTC+5:30)</timestamp>'), at);
  assert.equal(cursorEnvelopeTime('Quoted: <timestamp>2026-08-31T02:51:00Z</timestamp>'), 0);
  const msg = cursorMessage(user('<timestamp>2026-08-31T02:51:00Z</timestamp>\n<user_info>context</user_info><user_query>Do the work</user_query>', { uuid: 'native-turn' }), 'fallback')!;
  assert.equal(msg.id, 'native-turn'); assert.equal(msg.time, at); assert.equal(msg.fragments[0].text, 'Do the work');
  const tool = cursorMessage({ role: 'user', message: { content: [{ type: 'tool_result', content: 'result' }] } }, 'tool')!;
  assert.ok(tool.fragments.every((f) => f.kind !== 'You')); assert.equal(tool.time, 0);
  const edit = cursorMessage({ role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { path: '/work/file.ts', content: 'requested' } }, { type: 'image', data: 'opaque' }] }, 'edit')!;
  assert.deepEqual(edit.tools, ['Write']); assert.deepEqual(edit.files, []); assert.equal(edit.partial, true);
  assert.equal(cursorMessage(user('No timestamp'), 'untimed')!.time, 0);
  assert.equal(cursorMessage(user('Explain <user_query>quoted XML</user_query> in this example'), 'xml')!.fragments[0].text, 'Explain <user_query>quoted XML</user_query> in this example');
});

test('Cursor discovers IDE layouts, explicit subagents, unique workspace mappings and ignores symlinks', async () => {
  const f = await fixture();
  try {
    await write(join(f.transcripts, 'parent/parent.jsonl'), lines(user('Main request', { timestamp: '2026-08-31T02:51:00Z' })));
    await write(join(f.transcripts, 'parent/subagents/child.jsonl'), lines(user('Child request')));
    await write(join(f.transcripts, 'flat.jsonl'), lines(user('Flat layout')));
    await write(join(f.transcripts, 'old.txt'), 'Legacy text');
    await write(join(f.home, 'projects/ambiguous-name/agent-transcripts/unknown.jsonl'), lines(user('Unknown directory')));
    if (process.platform !== 'win32') await symlink(join(f.transcripts, 'flat.jsonl'), join(f.transcripts, 'link.jsonl'));
    assert.equal(await f.adapter.detect(), true);
    const discovery = await f.adapter.discover();
    assert.equal(discovery.sessions.length, 4);
    const parent = discovery.sessions.find((c) => c.session.nativeID === 'parent')!;
    const child = discovery.sessions.find((c) => c.session.nativeID === 'parent/agent/child')!;
    assert.equal(parent.session.directory, f.directory); assert.equal(parent.session.created, at);
    assert.equal(child.session.parentID, 'cursor:parent'); assert.equal(child.session.forkID, undefined);
    assert.equal(parent.session.nativeResume, false); assert.equal(parent.session.tokens, null);
    assert.equal(discovery.sessions.find((c) => c.session.nativeID === 'unknown')!.session.directory, '');
    assert.match(discovery.warnings.join(' '), /plain-text/);
    const page = await f.adapter.read(parent); assert.equal(page.partial, true); assert.match(page.note!, /snapshots/);
  } finally { await rm(f.dir, { recursive: true }); }
});

test('Cursor transcript pagination preserves identical turns, deduplicates native IDs and rejects changed snapshots', async () => {
  const f = await fixture(), store = new SessionAtlasStore(':memory:');
  try {
    const path = join(f.transcripts, 'parent.jsonl');
    await write(path, lines(...Array.from({ length: 240 }, (_, i) => user('same 星🌌é', i < 2 ? { uuid: 'repeated-native-id' } : {}))) + '{broken\n');
    const [candidate] = (await f.adapter.discover()).sessions;
    const messages: ImportedMessage[] = []; let cursor: string | undefined;
    do { const page = await f.adapter.read(candidate, cursor); messages.push(...page.messages); cursor = page.cursor; } while (cursor);
    assert.equal(messages.length, 240); assert.equal(new Set(messages.map((m) => m.id)).size, 239);
    const importer = new Importer(store, [f.adapter]); importer.start(['cursor']); await importer.settled();
    assert.equal(importer.status.imported, 1); assert.equal(store.getSession('cursor:parent')!.activity!.userMessages, 239);
    assert.equal(store.timeline('cursor:parent').untimedUserMessages, 239);
    importer.start(); await importer.settled(); assert.equal(importer.status.unchanged, 1);
    await appendFile(path, lines(user('new turn', { timestamp: '2026-09-01T00:00:00Z' })));
    await assert.rejects(f.adapter.read(candidate), /changed during import/);
    importer.start(); await importer.settled(); assert.equal(importer.status.imported, 1);
    assert.equal(store.getSession('cursor:parent')!.activity!.userMessages, 240);
    await rm(path); importer.start(); await importer.settled();
    assert.equal(store.getSession('cursor:parent')!.activity!.userMessages, 240);
  } finally { store.close(); await rm(f.dir, { recursive: true }); }
});

test('Cursor reads committed WAL roots in order without modifying source DB, WAL, SHM or importing abandoned blobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-cursor-wal-')), path = join(dir, 'store.db');
  const f = await database(path, 'native', true);
  try {
    const first = f.leaf({ role: 'user', content: 'Repeated request' });
    const reply = f.leaf({ role: 'assistant', content: [{ type: 'text', text: 'Stored reply' }] }, true);
    f.leaf({ role: 'user', content: 'Abandoned branch' });
    const tree = f.blob(Buffer.concat([ref(1, first), ref(1, reply)]));
    f.commit(f.blob(Buffer.concat([ref(2, tree), ref(1, first)])));
    const before = await Promise.all(['', '-wal', '-shm'].map((suffix) => readFile(path + suffix)));
    assert.equal(cursorStoreMetadata(path).agentId, 'native');
    const parsed = readCursorStore(path);
    assert.equal(parsed.partial, false);
    assert.deepEqual(parsed.messages.map((m) => m.fragments[0].text), ['Repeated request', 'Stored reply', 'Repeated request']);
    assert.equal(new Set(parsed.messages.map((m) => m.id)).size, 3);
    assert.ok(parsed.messages.every((m) => m.time === 0));
    const after = await Promise.all(['', '-wal', '-shm'].map((suffix) => readFile(path + suffix)));
    assert.deepEqual(after, before);
    assert.deepEqual((await readdir(dir)).sort(), ['store.db', 'store.db-shm', 'store.db-wal']);
  } finally { f.db.close(); await rm(dir, { recursive: true }); }
});

test('Cursor bounds corrupt, missing, oversized and cyclic blobs and fails an unreadable root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-cursor-bounds-')), path = join(dir, 'store.db');
  const f = await database(path);
  try {
    const good = f.leaf({ role: 'user', content: 'Keep readable history' });
    const large = f.leaf({ role: 'assistant', content: 'x'.repeat(2_000_001) });
    const corrupt = f.blob(Buffer.from([0x22, 0xff]));
    const cycle = 'c'.repeat(64);
    f.db.prepare('INSERT INTO blobs VALUES (?,?)').run(cycle, ref(2, cycle));
    f.commit(f.blob(Buffer.concat([ref(1, good), ref(1, large), ref(1, corrupt), ref(1, 'd'.repeat(64)), ref(2, cycle)])));
    assert.deepEqual(readCursorStore(path).messages.map((m) => m.fragments[0].text), ['Keep readable history']);
    assert.equal(readCursorStore(path).partial, true);
    f.commit('d'.repeat(64)); assert.throws(() => readCursorStore(path), /no readable conversation/);
  } finally { f.db.close(); await rm(dir, { recursive: true }); }
});

test('Cursor chooses one representation per native session, discovers ACP, and leaves source directories untouched', async () => {
  const f = await fixture();
  const workspace = createHash('md5').update(f.directory).digest('hex');
  const path = join(f.home, 'chats', workspace, 'native/store.db');
  const cli = await database(path);
  const acp = await database(join(f.home, 'acp-sessions/acp/store.db'), 'acp');
  const store = new SessionAtlasStore(':memory:');
  try {
    cli.commit(cli.blob(ref(1, cli.leaf({ role: 'user', content: 'Canonical store' })))); cli.db.close();
    acp.commit(acp.blob(ref(1, acp.leaf({ role: 'user', content: 'ACP history' })))); acp.db.close();
    await write(join(f.transcripts, 'native.jsonl'), lines(user('Duplicate export')));
    const before = await readdir(dirname(path));
    const discovery = await f.adapter.discover();
    assert.equal(discovery.sessions.length, 2);
    const native = discovery.sessions.find((c) => c.session.nativeID === 'native')!;
    assert.equal(native.locator.kind, 'cli'); assert.equal(native.session.directory, f.directory);
    assert.equal(native.session.created, at);
    assert.equal((await f.adapter.read(native)).messages[0].fragments[0].text, 'Canonical store');
    assert.deepEqual(await readdir(dirname(path)), before); // No WAL/SHM created beside the source.
    const importer = new Importer(store, [f.adapter]); importer.start(['cursor']); await importer.settled();
    await writeFile(path, 'Unreadable database'); importer.start(); await importer.settled();
    assert.match(importer.status.errors.join(' '), /unreadable/);
    // An unreadable primary store cannot downgrade previously saved history.
    assert.equal(store.getSession('cursor:native')!.coverage!.history, 'complete');
    assert.equal(store.content('cursor:native').messages, 1);
    assert.equal(store.content('cursor:native').fragments[0].text, 'Canonical store');
  } finally { store.close(); await rm(f.dir, { recursive: true }); }
});

test('Cursor IDE/subagents use handoffs; only verified CLI sessions in their original directory resume', async () => {
  const f = await fixture(), store = new SessionAtlasStore(join(f.dir, 'library.sqlite'));
  try {
    const session = blankSession('cursor', 'native', f.directory);
    const candidate = { session, locator: {}, revision: 'r1' };
    store.upsert(candidate); store.replace(candidate, [cursorMessage(user(), 'u1')!], true);
    assert.equal((await prepareLaunch(store, session, 'cursor')).mode, 'handoff');
    const cli = { ...session, nativeResume: true };
    const resumed = await prepareLaunch(store, cli, 'cursor');
    assert.equal(resumed.mode, 'resume'); assert.match(resumed.command, /'--resume' 'native'/);
    assert.equal((await prepareLaunch(store, cli, 'cursor', f.dir)).mode, 'handoff');
    assert.equal((await prepareLaunch(store, { ...session, nativeID: 'parent/agent/child', parentID: 'cursor:parent' }, 'cursor')).mode, 'handoff');
  } finally { store.close(); await rm(f.dir, { recursive: true }); }
});
