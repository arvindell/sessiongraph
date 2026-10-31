import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { adapters } from '../server/adapters';
import { closeSqliteSnapshots } from '../server/adapters/sqlite-snapshot';
import { rows, sqliteHistoryAdapter } from '../server/adapters/sqlite-histories';
import { discoverComposers, readComposer } from '../server/adapters/cursor-composer';
import { createCursorAdapter } from '../server/adapters/cursor';
import { codexAdapter } from '../server/adapters/codex';
import { expandHistory } from '../server/adapters/compressed';
import { protoFields } from '../server/adapters/harness-metadata';
import { sourceName } from '../src/sources';
import { Importer } from '../server/importer';
import { SessionGraphStore } from '../server/store';
import type { ImportedMessage, SessionAdapter } from '../server/adapters/types';

const iso = '2025-03-04T12:30:00.000Z', at = Date.parse(iso);
const lines = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
async function put(root: string, path: string, value: string | Uint8Array) { const p = join(root, path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, value); return p; }
async function fixture(id: string, run: (root: string, adapter: SessionAdapter) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-harness-')), key = `SESSIONGRAPH_${id.toUpperCase().replace(/-/g, '_')}_HISTORY_DIR`, old = process.env[key];
  process.env[key] = root;
  try { await run(root, adapters.find(a => a.id === id)!); }
  finally { closeSqliteSnapshots(); if (old === undefined) delete process.env[key]; else process.env[key] = old; await rm(root, { recursive: true, force: true }); }
}
async function only(adapter: SessionAdapter) {
  const found = await adapter.discover(); assert.equal(found.sessions.length, 1, JSON.stringify(found.warnings));
  const candidate = found.sessions[0], messages: ImportedMessage[] = []; let cursor: string | undefined;
  do { const page = await adapter.read(candidate, cursor); messages.push(...page.messages); cursor = page.cursor; } while (cursor);
  return { candidate, messages };
}
const piRows = lines({ type: 'session', id: 'native', timestamp: iso, cwd: '/fixture/project' }, { type: 'message', id: 'u1', message: { role: 'user', content: 'Repeated', timestamp: at } }, { type: 'message', id: 'u2', message: { role: 'user', content: 'Repeated' } });

test('registered harnesses have unique IDs and matching display names', () => {
  assert.equal(new Set(adapters.map(a => a.id)).size, adapters.length);
  for (const a of adapters) assert.equal(sourceName(a.id), a.name);
});

for (const id of ['prime-agent', 'omp', 'senpi', 'kimchi', 'gajae', 'openclaw']) test(`${id}: shared Pi transcripts preserve native identity and unknown timing`, async () => fixture(id, async (root, adapter) => {
  await put(root, id === 'openclaw' ? 'agent/sessions/session.jsonl' : 'project/session.jsonl', piRows);
  const { candidate, messages } = await only(adapter);
  assert.equal(candidate.session.nativeID, 'native'); assert.equal(candidate.session.created, at);
  assert.deepEqual(messages.map(m => m.id), ['u1', 'u2']); assert.equal(messages[1].time, 0);
  assert.equal(candidate.session.parentID, undefined); assert.equal(candidate.session.tokens, null);
}));

for (const id of ['droid', 'cherry-studio', 'command-code', 'zcode', 'codebuddy', 'workbuddy', 'proma', 'aside']) test(`${id}: conversation envelopes use native record IDs, not shared API response IDs`, async () => fixture(id, async (root, adapter) => {
  await put(root, id === 'aside' ? 'account/sessions/session/messages.jsonl' : 'project/session.jsonl', lines(
    { sessionId: 'native', uuid: 'u', type: 'user', timestamp: iso, message: { content: 'Prompt' } },
    { sessionId: 'native', uuid: 'a1', type: 'assistant', message: { id: 'shared-api-response', content: 'First' } },
    { sessionId: 'native', uuid: 'a2', type: 'assistant', message: { id: 'shared-api-response', content: 'Second' } },
  ));
  const { messages } = await only(adapter);
  assert.deepEqual(messages.map(m => m.id), ['u', 'a1', 'a2']); assert.equal(messages[2].time, 0);
}));

test('Codebuff and Freebuff attribute shared storage by positive root-agent marker', async () => fixture('codebuff', async (root, adapter) => {
  const old = process.env.SESSIONGRAPH_FREEBUFF_HISTORY_DIR; process.env.SESSIONGRAPH_FREEBUFF_HISTORY_DIR = root;
  try {
    await put(root, 'projects/project/chats/ordinary/chat-messages.json', JSON.stringify([{ id: 'u', role: 'user', content: 'Codebuff prompt', timestamp: iso }]));
    await put(root, 'projects/project/chats/free/chat-messages.json', JSON.stringify([{ id: 'u', role: 'user', content: 'Freebuff prompt', timestamp: iso, metadata: { runState: { sessionState: { mainAgentState: { agentType: 'base2-free' } } } } }]));
    assert.match((await only(adapter)).candidate.session.nativeID!, /ordinary$/);
    assert.match((await only(adapters.find(a => a.id === 'freebuff')!)).candidate.session.nativeID!, /free$/);
  } finally { if (old === undefined) delete process.env.SESSIONGRAPH_FREEBUFF_HISTORY_DIR; else process.env.SESSIONGRAPH_FREEBUFF_HISTORY_DIR = old; }
}));

test('Mux combines sealed and active chat without importing cumulative usage or duplicate turns', async () => fixture('mux', async (root, adapter) => {
  const u = { id: 'u', role: 'user', metadata: { timestamp: at }, parts: [{ type: 'text', text: 'Earlier prompt' }] };
  await put(root, 'workspace/chat-archive.jsonl', lines(u));
  await put(root, 'workspace/chat.jsonl', lines(u, { id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolCallId: 'c', toolName: 'write', input: { path: '/fixture/file' }, state: 'output-error', errorText: 'Denied' }] }));
  await put(root, 'workspace/session-usage.json', JSON.stringify({ byModel: { m: { output: { tokens: 9999 } } } }));
  const { candidate, messages } = await only(adapter);
  assert.equal(candidate.session.nativeID, 'workspace'); assert.deepEqual(messages.map(m => m.id), ['u', 'a']);
  assert.equal(messages[1].events?.[1].status, 'failed'); assert.equal(messages[1].files.length, 0); assert.equal(candidate.session.tokens, null);
}));

test('Kiro CLI preserves source seconds, missing times, and separates tool results from prompts', async () => fixture('kiro', async (root, adapter) => {
  await put(root, 'cli/native.json', JSON.stringify({ session_id: 'native', cwd: '/fixture' }));
  await put(root, 'cli/native.jsonl', lines(
    { kind: 'Prompt', data: { message_id: 'u', content: [{ kind: 'text', data: 'Prompt' }], meta: { timestamp: at / 1000 } } },
    { kind: 'AssistantMessage', data: { message_id: 'a', content: [{ kind: 'text', data: 'Answer' }] } },
    { kind: 'ToolResults', data: { message_id: 't', content: [{ kind: 'text', data: 'Result' }] } },
  ));
  const { messages } = await only(adapter); assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool']); assert.equal(messages[0].time, at); assert.equal(messages[1].time, 0);
}));

test('Kimi context has unknown turn times even when its wire log is timed', async () => fixture('kimi', async (root, adapter) => {
  await put(root, 'project/session/context.jsonl', lines({ role: 'user', content: 'Prompt' }, { role: 'assistant', content: 'Answer' }));
  await put(root, 'project/session/wire.jsonl', lines({ timestamp: at / 1000, type: 'TurnBegin' }));
  const { candidate, messages } = await only(adapter); assert.equal(candidate.session.created, at); assert.ok(messages.every(m => m.time === 0));
}));

test('Grok and Devin Desktop ACP chunks remain ordered partial text', async () => {
  for (const id of ['grok', 'devin-desktop']) await fixture(id, async (root, adapter) => {
    const events = ['user_message_chunk', 'agent_message_chunk', 'agent_message_chunk'].map((sessionUpdate, i) => ({ sessionUpdate, content: { type: 'text', text: ['Prompt', 'An', 'swer'][i] } }));
    await put(root, id === 'grok' ? 'p/s/updates.jsonl' : 'native.ndjson', lines(...events.map(update => id === 'grok' ? { params: { sessionId: 'native', update }, timestamp: iso } : { notification: update, timestamp: iso })));
    const { messages } = await only(adapter); assert.equal(messages.length, 2); assert.equal(messages[1].fragments[0].text, 'Answer');
  });
});

test('DeepSeek bounded zstd snapshots omit usage-only mirrors and prefer uncompressed copies', async () => fixture('deepseek-harness', async (root, adapter) => {
  const data = lines({ type: 'session', id: 'native', createdAt: at }, { type: 'user/message', time: at, data: { message: { id: 'u', role: 'user', content: 'Prompt' } } }, { type: 'assistant/attempt', data: { message: { id: 'attempt', role: 'assistant', content: 'Do not duplicate' } } });
  await put(root, 's/session.jsonl', data); await put(root, 's/session.jsonl.zstd', zstdCompressSync(Buffer.from(data)));
  const { candidate, messages } = await only(adapter); assert.ok(candidate.locator.path.endsWith('.jsonl')); assert.equal(messages.length, 1);
  assert.throws(() => expandHistory(gzipSync(Buffer.alloc(10_000)), 50));
}));

test('Amp, Jcode and Vibe retain actual conversation snapshots and journal IDs', async () => {
  for (const id of ['amp', 'jcode', 'vibe']) await fixture(id, async (root, adapter) => {
    const m = { id: 'u', role: 'user', content: 'Prompt', timestamp: iso };
    if (id === 'amp') await put(root, 'thread.json', JSON.stringify({ id: 'native', created: iso, messages: [m] }));
    if (id === 'jcode') {
      await put(root, 'session_native.json', JSON.stringify({ id: 'native', created_at: iso, messages: [m] }));
      await put(root, 'session_native.journal.jsonl', lines({ append_messages: [m, { id: 'a', role: 'assistant', content: 'Answer' }] }));
    }
    if (id === 'vibe') { await put(root, 'native/meta.json', JSON.stringify({ session_id: 'native', start_time: iso })); await put(root, 'native/messages.jsonl', lines(m)); }
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.nativeID, 'native'); assert.equal(messages[0].id, 'u'); assert.equal(messages.length, id === 'jcode' ? 2 : 1);
  });
});

test('SQLite snapshots include committed WAL rows while leaving live bytes and stats untouched', async () => fixture('hermes', async (root, adapter) => {
  const p = join(root, 'state.db'), db = new DatabaseSync(p);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, started_at REAL, parent_session_id TEXT); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL)");
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('native', 'cli', at / 1000, 'compression-parent');
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(1, 'native', 'user', 'Prompt', at / 1000);
    const paths = [p, p + '-wal', p + '-shm'];
    const before = await Promise.all(paths.map(async path => ({ bytes: await readFile(path), stat: await stat(path) })));
    const { candidate, messages } = await only(adapter);
    assert.equal(candidate.session.created, at); assert.equal(candidate.session.parentID, undefined); assert.equal(messages[0].time, at);
    for (let i = 0; i < paths.length; i++) { assert.deepEqual(await readFile(paths[i]), before[i].bytes); assert.equal((await stat(paths[i])).mtimeMs, before[i].stat.mtimeMs); }
    db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(2, 'native', 'assistant', 'Answer', at / 1000 + 1);
    await assert.rejects(adapter.read(candidate), /changed/);
    assert.equal((await only(adapter)).messages.length, 2);
  } finally { closeSqliteSnapshots(); db.close(); }
}));

test('SQLite import failures retain saved messages and coverage instead of replacing them with empty history', async () => fixture('unsloth', async (root, adapter) => {
  const db = new DatabaseSync(join(root, 'studio.db'));
  const store = new SessionGraphStore(':memory:');
  try {
    db.exec('CREATE TABLE chat_threads(id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, forked_from_thread_id TEXT); CREATE TABLE chat_messages(id TEXT, thread_id TEXT, role TEXT, content_json TEXT, created_at INTEGER)');
    db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?)').run('native', 'Test thread', at / 1000, 'origin');
    db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)').run('u', 'native', 'user', JSON.stringify([{ type: 'text', text: 'Preserve this' }]), at / 1000);
    const importer = new Importer(store, [adapter]); importer.start([adapter.id]); await importer.settled(); assert.equal(importer.status.imported, 1);
    const saved = store.getSession('unsloth:native')!; assert.equal(saved.forkID, 'unsloth:origin');
    db.exec('DELETE FROM chat_messages'); importer.start(); await importer.settled();
    assert.equal(store.getSession('unsloth:native')?.coverage?.importedAt, saved.coverage?.importedAt);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get()?.n, 1);
  } finally { store.close(); closeSqliteSnapshots(); db.close(); }
}));

test('oversized SQLite content preserves saved history rather than becoming an empty message', async () => fixture('hermes', async (root, adapter) => {
  const db = new DatabaseSync(join(root, 'state.db')), store = new SessionGraphStore(':memory:');
  try {
    db.exec('CREATE TABLE sessions(id TEXT, started_at REAL); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL)');
    db.prepare('INSERT INTO sessions VALUES (?,?)').run('native', at / 1000);
    db.prepare('INSERT INTO messages VALUES (1,?,?,?,?)').run('native', 'user', 'Preserve this prompt', at / 1000);
    const importer = new Importer(store, [adapter]); importer.start([adapter.id]); await importer.settled();
    assert.equal(importer.status.imported, 1);
    const saved = store.getSession('hermes:native')!;
    db.prepare('UPDATE messages SET content=?').run('🌌'.repeat(8_000_001));
    importer.start(); await importer.settled();
    assert.ok(importer.status.errors.some(e => e.includes('oversized')));
    assert.equal(store.getSession('hermes:native')!.coverage!.importedAt, saved.coverage!.importedAt);
    assert.equal(store.content('hermes:native').fragments[0].text, 'Preserve this prompt');
  } finally { store.close(); closeSqliteSnapshots(); db.close(); }
}));

test('nested SQLite queries share a bounded per-session read budget', async () => fixture('hermes', async root => {
  const path = join(root, 'nested.db'), db = new DatabaseSync(path);
  db.exec("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('native'); CREATE TABLE chunks(id INTEGER, content BLOB); INSERT INTO chunks VALUES (1, zeroblob(17000000))");
  db.close();
  let reads = 0;
  const adapter = sqliteHistoryAdapter({ id: 'fixture', name: 'Fixture', paths: async () => [path], table: 'sessions', key: 'id', fields: ['id'], parse(copy) {
    for (let i = 0; i < 4; i++) { rows(copy, 'chunks', ['content'], ['id', 1]); reads++; }
    throw new Error('Session budget did not stop nested reads.');
  } });
  const found = await adapter.discover();
  assert.equal(reads, 3); assert.deepEqual(found.blocked, ['fixture:native']);
  assert.equal(found.sessions.length, 0);
}));

test('legacy Cursor inline, mapped and separate bubbles retain original dates and stable native IDs', async () => fixture('cursor', async root => {
  const path = join(root, 'User/globalStorage/state.vscdb'); await mkdir(dirname(path), { recursive: true }); const db = new DatabaseSync(path);
  db.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT)');
  const putKV = (key: string, value: unknown) => db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)').run(key, JSON.stringify(value));
  putKV('composerData:inline', { composerId: 'inline', createdAt: at, conversation: [{ bubbleId: 'u', type: 1, text: 'Old prompt' }, { bubbleId: 'a', type: 2, text: 'Old answer', timingInfo: { clientStartTime: at + 1000 } }] });
  putKV('composerData:map', { composerId: 'map', createdAt: at, fullConversationHeadersOnly: [{ bubbleId: 'm', type: 1 }], conversationMap: { m: { text: 'Mapped prompt' } } });
  putKV('composerData:separate', { composerId: 'separate', createdAt: at, fullConversationHeadersOnly: [{ bubbleId: 'u', type: 1 }, { bubbleId: 'missing', type: 2 }] });
  putKV('bubbleId:separate:u', { type: 1, text: 'Stored prompt', createdAt: at });
  putKV('composerData:draft', { composerId: 'draft', createdAt: at, conversation: [] }); db.close();
  const before = await readFile(path), found = discoverComposers(path); assert.equal(found.sessions.length, 3);
  const inline = readComposer(found.sessions.find(c => c.session.nativeID === 'inline')!);
  assert.deepEqual(inline.messages.map(m => m.id), ['u', 'a']); assert.deepEqual(inline.messages.map(m => m.time), [0, at + 1000]);
  assert.equal(readComposer(found.sessions.find(c => c.session.nativeID === 'map')!).messages[0].fragments[0].text, 'Mapped prompt');
  assert.match(readComposer(found.sessions.find(c => c.session.nativeID === 'separate')!).note, /omitted/);
  const adapter = createCursorAdapter({ home: join(root, 'cursor-home'), userData: root });
  await put(root, 'cursor-home/projects/project/agent-transcripts/inline.jsonl', lines({ role: 'user', content: 'Modern export' }));
  const candidates = await adapter.discover(), modern = candidates.sessions.find(c => c.session.nativeID === 'inline')!;
  assert.equal(candidates.sessions.length, 3); assert.equal(modern.session.created, at); assert.equal(modern.locator.kind, 'transcript');
  assert.deepEqual(await readFile(path), before);
}));

test('Codex compressed archives deduplicate by native session identity', async () => fixture('codex', async root => {
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = root;
  try {
    const data = lines({ type: 'session_meta', timestamp: iso, payload: { id: 'native', cwd: '/fixture' } }, { type: 'response_item', timestamp: iso, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Archived prompt' }] } });
    await put(root, 'archived_sessions/rollout.jsonl.zst', zstdCompressSync(Buffer.from(data)));
    assert.equal((await only(codexAdapter)).messages[0].fragments[0].text, 'Archived prompt');
    await put(root, 'sessions/rollout.jsonl', data);
    assert.ok((await only(codexAdapter)).candidate.locator.path.endsWith('/sessions/rollout.jsonl'));
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; }
}));

test('usage-only sources expose limitations without fabricating sessions', async () => {
  for (const id of ['reasonix', 'trae', 'warp', 'lm-studio', 'hindsight']) await fixture(id, async (root, adapter) => {
    await put(root, 'usage.jsonl', lines({ timestamp: at, total: 9999 }));
    assert.equal(await adapter.detect(), true); assert.equal(adapter.capabilities.history, false);
    const d = await adapter.discover(); assert.equal(d.sessions.length, 0); assert.ok(d.warnings.length);
  });
  assert.throws(() => protoFields(Uint8Array.from([0x12, 0xff])), /varint/);
  assert.throws(() => protoFields(Uint8Array.from([0x12, 0x20, 0x01])), /length/);
});

test('SQLite conversation families preserve content, identity, and recorded creation dates', async () => {
  const cases = [
    { id: 'goose', path: 'sessions.db', sql: 'CREATE TABLE sessions(id TEXT, created_at TEXT); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER)', session: 'INSERT INTO sessions VALUES (?,?)', values: ['native', iso], row: 'INSERT INTO messages VALUES (1,?,?,?,?)', message: ['native', 'user', JSON.stringify([{ type: 'text', text: 'Prompt' }]), at / 1000] },
    { id: 'devin', path: 'sessions.db', sql: 'CREATE TABLE sessions(id TEXT, created_at INTEGER); CREATE TABLE message_nodes(row_id INTEGER, node_id INTEGER, session_id TEXT, chat_message TEXT, created_at INTEGER)', session: 'INSERT INTO sessions VALUES (?,?)', values: ['native', at], row: 'INSERT INTO message_nodes VALUES (1,1,?,?,?)', message: ['native', JSON.stringify({ role: 'user', content: 'Prompt' }), at] },
    { id: 'crush', path: 'crush.db', sql: 'CREATE TABLE sessions(id TEXT, created_at INTEGER, cost REAL); CREATE TABLE messages(id TEXT, session_id TEXT, role TEXT, parts TEXT, created_at INTEGER)', session: 'INSERT INTO sessions VALUES (?,?,?)', values: ['native', at / 1000, 0.25], row: 'INSERT INTO messages VALUES (?,?,?,?,?)', message: ['u', 'native', 'user', JSON.stringify([{ type: 'text', data: { text: 'Prompt' } }]), at / 1000] },
  ];
  for (const c of cases) await fixture(c.id, async (root, adapter) => {
    const db = new DatabaseSync(join(root, c.path)); db.exec(c.sql); db.prepare(c.session).run(...c.values); db.prepare(c.row).run(...c.message); db.close();
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.nativeID, 'native'); assert.equal(candidate.session.created, at); assert.equal(messages[0].fragments[0].text, 'Prompt'); assert.equal(messages[0].time, at);
    if (c.id === 'crush') { assert.equal(candidate.session.cost, 0.25); assert.equal(candidate.session.tokens, null); }
  });
});

test('Kilo and MiMo native stores read message parts; MiMo desktop attribution is explicit', async () => {
  for (const id of ['kilo-cli', 'mimo-code', 'mimo-desktop']) await fixture(id, async (root, adapter) => {
    const db = new DatabaseSync(join(root, 'native.db'));
    db.exec('CREATE TABLE session(id TEXT, version TEXT, time_created INTEGER); CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER); CREATE TABLE part(id TEXT, message_id TEXT, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('native', id === 'mimo-desktop' ? 'desktop-1' : '1', at);
    db.prepare('INSERT INTO session VALUES (?,?,?)').run('other', id === 'mimo-code' ? 'desktop-1' : '1', at);
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('u', 'native', JSON.stringify({ role: 'user' }), at);
    db.prepare('INSERT INTO part VALUES (?,?,?)').run('p', 'u', JSON.stringify({ type: 'text', text: 'Prompt' })); db.close();
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.nativeID, 'native'); assert.equal(messages[0].fragments[0].text, 'Prompt');
  });
});

test('OpenClaw prefers database events and blocks stale JSONL fallback when the primary becomes unreadable', async () => fixture('openclaw', async (root, adapter) => {
  const path = join(root, 'agent/agent/openclaw-agent.sqlite'); await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE session_windows(session_id TEXT, created_at INTEGER); CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB)');
    db.prepare('INSERT INTO session_windows VALUES (?,?)').run('native', at);
    db.prepare('INSERT INTO transcript_events VALUES (?,1,NULL,?)').run('native', zstdCompressSync(Buffer.from(JSON.stringify({ type: 'message', id: 'u', timestamp: iso, message: { role: 'user', content: 'Authoritative' } }))));
    await put(root, 'agent/sessions/native.jsonl', piRows);
    assert.equal((await only(adapter)).messages[0].fragments[0].text, 'Authoritative');
    db.exec("UPDATE transcript_events SET event_zstd=x'0102'");
    const found = await adapter.discover(); assert.equal(found.sessions.length, 0); assert.ok(found.warnings.some(w => w.includes('unsupported')));
    assert.equal((await adapter.discover()).sessions.length, 0, 'cached failures must still block fallback');
  } finally { closeSqliteSnapshots(); db.close(); }
}));

test('Zed externally tagged zstd messages and Octofriend IR retain untimed native records', async () => {
  await fixture('zed', async (root, adapter) => {
    const db = new DatabaseSync(join(root, 'threads.db'));
    db.exec('CREATE TABLE threads(id TEXT, created_at TEXT, data_type TEXT, data BLOB)');
    db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('native', iso, 'zstd', zstdCompressSync(Buffer.from(JSON.stringify({ messages: [{ User: { id: 'u', content: [{ Text: 'Prompt' }] } }, { Agent: { content: [{ Text: 'Answer' }] } }] })))); db.close();
    const { messages } = await only(adapter); assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']); assert.ok(messages.every(m => m.time === 0)); assert.equal(messages[1].fragments[0].text, 'Answer');
  });
  await fixture('octofriend', async (root, adapter) => {
    const db = new DatabaseSync(join(root, 'sqlite.db'));
    db.exec('CREATE TABLE trees(id INTEGER, name TEXT); CREATE TABLE tree_nodes(id INTEGER, tree_id INTEGER, history_item_id INTEGER, created_at TEXT); CREATE TABLE history_items(id INTEGER, llm_ir_id INTEGER); CREATE TABLE llm_irs(id INTEGER, json TEXT)');
    db.exec("INSERT INTO trees VALUES (1,'Mutable title'); INSERT INTO history_items VALUES (2,3)");
    db.prepare('INSERT INTO tree_nodes VALUES (4,1,2,?)').run(iso);
    db.prepare('INSERT INTO llm_irs VALUES (3,?)').run(JSON.stringify({ version: 'octo-llm-ir/v1', ir: { role: 'user', content: [{ type: 'text', content: 'Prompt' }] } })); db.close();
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.nativeID, '1'); assert.equal(messages[0].id, '4'); assert.equal(messages[0].fragments[0].text, 'Prompt');
  });
});

test('Kiro IDE payload roles and SQLite tagged turns keep native IDs and unknown user timing', async () => {
  await fixture('kiro', async (root, adapter) => {
    await put(root, 'workspace/sess_native/session.json', JSON.stringify({ id: 'sess_native', createdAt: iso }));
    await put(root, 'workspace/sess_native/messages.jsonl', lines({ payload: { type: 'user', content: 'Prompt' } }, { payload: { type: 'assistant', content: 'Answer' }, timestamp: iso }));
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.nativeID, 'sess_native'); assert.equal(messages[0].role, 'user'); assert.equal(messages[0].time, 0);
  });
  await fixture('kiro', async (root, adapter) => {
    const db = new DatabaseSync(join(root, 'data.sqlite3')); db.exec('CREATE TABLE conversations_v2(key TEXT, conversation_id TEXT, value TEXT)');
    db.prepare('INSERT INTO conversations_v2 VALUES (?,?,?)').run('/fixture', 'native', JSON.stringify({ history: [{ user: { content: { Prompt: { prompt: 'Prompt' } } }, assistant: { Response: { content: 'Answer' } }, request_metadata: { request_start_timestamp_ms: at, stream_end_timestamp_ms: at + 1000 } }] })); db.close();
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.created, at); assert.deepEqual(messages.map(m => m.time), [0, at + 1000]);
  });
});

test('event-only formats report partial coverage without manufacturing user turns', async () => {
  const cases = [
    { id: 'muse', path: 'native/session.jsonl', value: lines({ payload_type: 'runtime.session.metadata', stream: { id: 'native' }, payload: { record: { workspace_root: '/fixture' } } }, { stream: { id: 'native' }, recorded_at: at * 1000, sequence: 2, payload: { event: { kind: 'model_completed' } } }) },
    { id: 'junie', path: 'native/events.jsonl', value: lines({ timestampMs: at, event: { agentEvent: { kind: 'LlmUsageEvent' } } }) },
    { id: 'augment', path: 'native.json', value: JSON.stringify({ sessionId: 'native', created: iso, chatHistory: [{ sequenceId: 1, completed: true, finishedAt: iso, exchange: {} }] }) },
    { id: 'opencodereview', path: 'native.jsonl', value: lines({ type: 'session_start', session_id: 'native', timestamp: iso }, { type: 'llm_response', timestamp: iso, content: 'Review' }) },
  ];
  for (const c of cases) await fixture(c.id, async (root, adapter) => {
    await put(root, c.path, c.value); const { candidate, messages } = await only(adapter);
    assert.equal(candidate.session.nativeID, 'native'); assert.equal(messages.length, 1); assert.equal(messages[0].role, 'system'); assert.equal(messages[0].time, at); assert.equal((await adapter.read(candidate)).partial, true);
  });
});

test('Fx and Antigravity metadata never become conversation messages', async () => {
  await fixture('fx', async (root, adapter) => {
    await put(root, 'native/usage-v2.json', JSON.stringify({ session_id: 'native', snapshot: {} })); await put(root, 'native/session.json', JSON.stringify({ id: 'native', created_at_ms: at }));
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.created, at); assert.equal(messages.length, 0); assert.equal(adapter.capabilities.history, false);
  });
  await fixture('antigravity', async (root, adapter) => {
    await put(root, 'native.jsonl', lines({ type: 'session_meta', sessionId: 'native' }, { type: 'usage', sessionId: 'native', timestamp: at, input: 1234 }));
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.created, at); assert.equal(messages.length, 0);
  });
  const varint = (n: bigint): number[] => { const b: number[] = []; while (n >= 128n) { b.push(Number(n & 127n) | 128); n >>= 7n; } return [...b, Number(n)]; };
  const timestamp = [8, ...varint(BigInt(at / 1000))];
  for (const id of ['antigravity-cli', 'antigravity-extension']) await fixture(id, async (root, adapter) => {
    const db = new DatabaseSync(join(root, 'native.db')); db.exec('CREATE TABLE trajectory_metadata_blob(id TEXT, data BLOB)'); db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?,?)').run('main', Buffer.from([18, timestamp.length, ...timestamp])); db.close();
    const { candidate, messages } = await only(adapter); assert.equal(candidate.session.nativeID, 'native'); assert.equal(candidate.session.created, at); assert.equal(messages.length, 0);
  });
});

test('MiniMax imports only captured messages with an explicit session identity', async () => fixture('minimax-code', async (root, adapter) => {
  await put(root, 'native.jsonl', lines({ type: 'message', sessionId: 'native', message: { id: 'a', role: 'assistant', content: 'Captured answer', timestamp: at } }));
  const { messages } = await only(adapter); assert.equal(messages[0].fragments[0].text, 'Captured answer');
  await put(root, 'unidentified.jsonl', lines({ type: 'message', message: { role: 'assistant', content: 'No identity' } })); assert.equal((await adapter.discover()).sessions.length, 1);
}));
