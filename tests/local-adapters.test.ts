import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { geminiAdapter, geminiConversation } from '../server/adapters/gemini';
import { qwenAdapter } from '../server/adapters/qwen';
import { piAdapter } from '../server/adapters/pi';
import { copilotAdapter } from '../server/adapters/copilot';
import { clineAdapter, rooAdapter, kiloAdapter, continueAdapter } from '../server/adapters/extensions';
import { adapters } from '../server/adapters';
import type { ImportedMessage, SessionAdapter } from '../server/adapters/types';
import { Importer } from '../server/importer';
import { SessionGraphStore } from '../server/store';
import { prepareLaunch } from '../server/launch';

const date = '2026-10-01T12:00:00.000Z';
const milliseconds = Date.parse(date);
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
async function put(root: string, path: string, value: unknown, raw = false) {
  const file = join(root, path); await mkdir(dirname(file), { recursive: true });
  await writeFile(file, raw ? String(value) : JSON.stringify(value)); return file;
}
async function fixture(env: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-agent-')), previous = process.env[env]; process.env[env] = root;
  try { await run(root); } finally { if (previous === undefined) delete process.env[env]; else process.env[env] = previous; await rm(root, { recursive: true, force: true }); }
}
async function only(adapter: SessionAdapter) {
  const discovery = await adapter.discover(); assert.equal(discovery.sessions.length, 1, JSON.stringify(discovery.warnings));
  const candidate = discovery.sessions[0], messages: ImportedMessage[] = []; let cursor: string | undefined;
  do { const page = await adapter.read(candidate, cursor); messages.push(...page.messages); cursor = page.cursor; } while (cursor);
  return { candidate, messages };
}

test('Gemini reconstructs patches, removals, order and rewinds without inventing completed edits', async () => fixture('SESSIONGRAPH_GEMINI_HOME', async root => {
  const rows = [
    { sessionId: 'gemini-session', projectHash: 'hash', startTime: date },
    { id: 'u1', type: 'user', timestamp: date, content: 'Same prompt' },
    { id: 'a1', type: 'gemini', content: 'Before patch', model: 'gemini-test', toolCalls: [{ id: 'edit', name: 'write_file', args: { file_path: '/synthetic/ok.ts' }, status: 'success', result: 'Saved' }, { id: 'failed', name: 'write_file', args: { file_path: '/synthetic/no.ts' }, status: 'error', result: 'Denied' }] },
    { id: 'discard', type: 'user', content: 'Discard this' },
    { $rewindTo: 'discard' },
    { $patch: { updates: [{ id: 'a1', content: [{ text: 'After patch' }], toolCalls: [{ id: 'edit', result: 'Committed' }] }] } },
    { id: 'u2', type: 'user', timestamp: date, content: 'Same prompt' },
  ];
  const file = await put(root, 'tmp/project/chats/session-test.jsonl', lines(rows), true);
  await put(root, 'tmp/project/.project_root', '/synthetic/project', true);
  const before = await readFile(file);
  const { candidate, messages } = await only(geminiAdapter);
  assert.equal(candidate.session.directory, '/synthetic/project'); assert.equal(candidate.session.model, 'gemini-test');
  assert.deepEqual(messages.map(m => m.id), ['u1', 'a1', 'u2']);
  assert.equal(messages[1].time, 0); assert.equal(messages[1].fragments[0].text, 'After patch');
  assert.deepEqual(messages.flatMap(m => m.files.map(f => f.path)), ['/synthetic/ok.ts']);
  assert.deepEqual(await readFile(file), before);
  const patched = geminiConversation(lines([...rows, { $patch: { orderIds: ['u2', 'u1'], removeIds: ['a1'] } }]), true);
  assert.deepEqual(patched.records.map(m => m.id), ['u2', 'u1']);
  assert.equal(geminiConversation(lines([...rows, { $rewindTo: 'unknown' }]), true).records.length, 0);
}));

test('Gemini prefers JSONL over duplicate legacy JSON and links only explicit subagent folders', async () => fixture('SESSIONGRAPH_GEMINI_HOME', async root => {
  await put(root, 'tmp/project/chats/session-old.json', { sessionId: 'parent', projectHash: 'p', messages: [{ id: 'old', type: 'user', content: 'Old' }] });
  await put(root, 'tmp/project/chats/session-new.jsonl', lines([{ sessionId: 'parent', projectHash: 'p' }, { id: 'new', type: 'user', content: 'New' }]), true);
  await put(root, 'tmp/project/chats/parent/child.jsonl', lines([{ sessionId: 'child', projectHash: 'p', kind: 'subagent' }, { id: 'child-u', type: 'user', content: 'Investigate' }]), true);
  const { sessions } = await geminiAdapter.discover(); assert.equal(sessions.length, 2);
  assert.equal(sessions.find(c => c.session.nativeID === 'parent')?.locator.path.endsWith('.jsonl'), true);
  assert.equal(sessions.find(c => c.session.nativeID === 'child')?.session.parentID, 'gemini:parent');
  assert.equal(sessions.find(c => c.session.nativeID === 'child')?.session.forkID, undefined);
}));

test('Qwen preserves native IDs, repeated turns, explicit forks/children and correlated successful results', async () => fixture('SESSIONGRAPH_QWEN_HOME', async root => {
  const wrap = (uuid: string, value: unknown) => ({ uuid, sessionId: 'qwen-session', timestamp: date, cwd: '/synthetic', ...value as object });
  await put(root, 'projects/project/chats/session.jsonl', lines([
    wrap('u1', { type: 'user', message: { parts: [{ text: 'Again' }] }, forkedFrom: { sessionId: 'fork-origin' } }),
    wrap('u2', { type: 'user', message: { parts: [{ text: 'Again' }] } }),
    wrap('parent', { type: 'system', subtype: 'parent_session', systemPayload: { parentSessionId: 'parent' } }),
    wrap('title', { type: 'system', subtype: 'custom_title', systemPayload: { customTitle: 'Qwen title' } }),
    wrap('call', { type: 'assistant', model: 'qwen-test', message: { parts: [{ functionCall: { id: 'edit1', name: 'write_file', args: { file_path: '/synthetic/written.ts' } } }] } }),
    wrap('result', { type: 'tool_result', message: { parts: [{ functionResponse: { id: 'edit1', name: 'write_file', response: { output: 'Saved' } } }] }, toolCallResult: { status: 'success', callId: 'edit1' } }),
    wrap('notification', { type: 'user', subtype: 'agent_message', message: { parts: [{ text: 'Agent message' }] } }),
  ]), true);
  const { candidate, messages } = await only(qwenAdapter);
  assert.equal(candidate.session.title, 'Qwen title'); assert.equal(candidate.session.parentID, 'qwen-code:parent'); assert.equal(candidate.session.forkID, 'qwen-code:fork-origin');
  assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.id), ['u1', 'u2']);
  assert.equal(messages[5].events?.[0].callID, 'edit1'); assert.equal(messages[5].role, 'tool');
  assert.deepEqual(messages.flatMap(m => m.files.map(f => f.path)), ['/synthetic/written.ts']);
}));

test('Pi keeps entry-level branching distinct from session ancestry and retains reasoning and compaction', async () => fixture('SESSIONGRAPH_PI_SESSIONS_DIR', async root => {
  await put(root, 'project/session.jsonl', lines([
    { type: 'session', version: 3, id: 'pi-session', timestamp: date, cwd: '/synthetic', parentSession: '/not-read/session.jsonl' },
    { type: 'model_change', id: 'model', timestamp: date, provider: 'test', modelId: 'pi-model' },
    { type: 'message', id: 'u1', parentId: 'model', message: { role: 'user', timestamp: milliseconds, content: 'Do it' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'toolCall', id: 'call1', name: 'write', arguments: { path: '/synthetic/pi.ts', content: 'ok' } }] } },
    { type: 'message', id: 't1', parentId: 'a1', message: { role: 'toolResult', toolCallId: 'call1', toolName: 'write', isError: false, content: [{ type: 'text', text: 'Saved' }] } },
    { type: 'branch_summary', id: 'branch', parentId: 'u1', fromId: 't1', summary: 'Alternate path' },
    { type: 'session_info', id: 'name', name: 'Pi title' },
  ]), true);
  const { candidate, messages } = await only(piAdapter);
  assert.equal(candidate.session.title, 'Pi title'); assert.equal(candidate.session.parentID, undefined); assert.equal(candidate.session.forkID, undefined);
  assert.equal(messages.find(m => m.id === 'a1')?.events?.[0].kind, 'reasoning');
  assert.equal(messages.find(m => m.id === 'branch')?.events?.[0].parentID, 'u1');
  assert.deepEqual(messages.flatMap(m => m.files.map(f => f.path)), ['/synthetic/pi.ts']);
}));

test('Copilot excludes streaming mirrors, preserves unknown events and imports only authoritative edits', async () => fixture('SESSIONGRAPH_COPILOT_HOME', async root => {
  const row = (id: string, type: string, data: unknown, extra = {}) => ({ id, type, timestamp: date, data, ...extra });
  await put(root, 'session-state/session/events.jsonl', lines([
    row('start', 'session.start', { sessionId: 'copilot-session', startTime: date, selectedModel: 'copilot-model', context: { cwd: '/synthetic' } }),
    row('u', 'user.message', { content: 'Fix it' }),
    row('delta', 'assistant.message_delta', { deltaContent: 'Done' }),
    row('answer', 'assistant.message', { content: 'Done', messageId: 'native-answer' }),
    row('call', 'tool.execution_start', { toolCallId: 'edit', toolName: 'edit', arguments: { path: '/synthetic/not-evidence.ts' } }),
    row('result', 'tool.execution_complete', { toolCallId: 'edit', success: false, error: { message: 'Second edit failed' }, fileEdits: [{ kind: 'modify', path: '/synthetic/committed.ts' }] }),
    row('unknown', 'session.future_event', { text: 'Retain this', apiKey: 'never-store-this' }),
    row('ephemeral', 'session.transient', { text: 'Transient' }, { ephemeral: true }),
    row('injected', 'user.message', { content: 'Autopilot', isAutopilotContinuation: true }),
  ]), true);
  const { messages } = await only(copilotAdapter);
  assert.equal(messages.filter(m => m.role === 'user').length, 1);
  assert.equal(messages.filter(m => m.role === 'assistant').length, 1);
  assert.ok(!messages.some(m => ['delta', 'ephemeral'].includes(m.id)));
  assert.deepEqual(messages.flatMap(m => m.files.map(f => f.path)), ['/synthetic/committed.ts']);
  assert.match(messages.find(m => m.id === 'unknown')!.events![0].text, /Retain this/);
  assert.ok(!JSON.stringify(messages).includes('never-store-this'));
}));

test('Cline, Roo and Kilo task histories stay source-scoped and never treat requested XML edits as completed', async () => {
  for (const [adapter, env] of [[clineAdapter, 'SESSIONGRAPH_CLINE_HOME'], [rooAdapter, 'SESSIONGRAPH_ROO_HOME'], [kiloAdapter, 'SESSIONGRAPH_KILO_HOME']] as const) await fixture(env, async root => {
    const path = await put(root, 'tasks/shared-id/api_conversation_history.json', [
      { role: 'user', content: [{ type: 'text', text: 'Repeated turn' }] },
      { role: 'user', content: [{ type: 'text', text: 'Repeated turn' }] },
      { role: 'assistant', content: '<write_to_file><path>/synthetic/no.ts</path></write_to_file>' },
    ]);
    await put(root, 'tasks/shared-id/history_item.json', { id: 'shared-id', task: 'Task title', parentTaskId: 'parent', workspace: '/synthetic/work' });
    const before = await readFile(path), { candidate, messages } = await only(adapter);
    assert.equal(candidate.session.id, `${adapter.id}:shared-id`); assert.equal(candidate.session.parentID, `${adapter.id}:parent`);
    assert.equal(candidate.session.directory, '/synthetic/work'); assert.equal(candidate.session.cost, null);
    assert.equal(new Set(messages.map(m => m.id)).size, 3); assert.equal(messages.every(m => m.time === 0), true);
    assert.equal(messages.flatMap(m => m.files).length, 0); assert.deepEqual(await readFile(path), before);
  });
});

test('Cline SDK message snapshots retain recorded metadata and native fork lineage', async () => fixture('SESSIONGRAPH_CLINE_HOME', async root => {
  await put(root, 'data/sessions/sdk/sdk.messages.json', { version: 1, sessionId: 'sdk', messages: [{ id: 'native-message', role: 'user', content: 'Hello', ts: milliseconds }] });
  await put(root, 'data/sessions/sdk/session.json', { session_id: 'sdk', cwd: '/synthetic/sdk', started_at: date, metadata: { title: 'SDK session', fork: { forkedFromSessionId: 'original' } } });
  const { candidate, messages } = await only(clineAdapter);
  assert.equal(candidate.session.forkID, 'cline:original'); assert.equal(candidate.session.parentID, undefined);
  assert.equal(messages[0].id, 'native-message'); assert.equal(messages[0].time, milliseconds);
}));

test('Continue uses its session index creation time without inventing message times or invalidating unrelated sessions', async () => fixture('SESSIONGRAPH_CONTINUE_HOME', async root => {
  const index = await put(root, 'sessions/sessions.json', [{ sessionId: 'continue-session', dateCreated: String(milliseconds) }]);
  await put(root, 'sessions/continue-session.json', { sessionId: 'continue-session', title: 'Continue title', workspaceDirectory: '/synthetic', history: [{ message: { role: 'user', content: 'Hello' } }, { message: { role: 'assistant', content: 'Done', toolCalls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"/synthetic/a.ts"}' } }] } }, { message: { role: 'tool', toolCallId: 'call', content: 'Read result' } }] });
  const { candidate, messages } = await only(continueAdapter);
  assert.equal(candidate.session.created, milliseconds); assert.equal(messages.every(m => m.time === 0), true);
  assert.equal(messages[2].events?.[0].callID, 'call'); assert.equal(messages.flatMap(m => m.files).length, 0);
  await writeFile(index, JSON.stringify([{ sessionId: 'continue-session', dateCreated: String(milliseconds) }, { sessionId: 'unrelated', dateCreated: String(milliseconds + 10) }]));
  assert.equal((await only(continueAdapter)).candidate.revision, candidate.revision);
}));

test('local history snapshots reject changed cursors, symlinks, oversized files and malformed identities while preserving saved history', async () => fixture('SESSIONGRAPH_QWEN_HOME', async root => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ uuid: `u${i}`, sessionId: 'paged', type: 'user', timestamp: date, message: { parts: [{ text: 'Identical turn' }] } }));
  const path = await put(root, 'projects/project/chats/paged.jsonl', lines(rows), true);
  const { candidate, messages } = await only(qwenAdapter); assert.equal(messages.length, 205); assert.equal(new Set(messages.map(m => m.id)).size, 205);
  const first = await qwenAdapter.read(candidate); assert.ok(first.cursor);
  await writeFile(path, lines([...rows, { ...rows[0], uuid: 'new' }]));
  await assert.rejects(qwenAdapter.read(candidate, first.cursor), /changed/);
  await assert.rejects(qwenAdapter.read(candidate, 'NaN'), /cursor/);
  const linked = join(root, 'projects/project/chats/linked.jsonl'); await symlink(path, linked);
  const oversized = await put(root, 'projects/project/chats/large.jsonl', '', true); await truncate(oversized, 32_000_001);
  await put(root, 'projects/project/chats/unknown.jsonl', lines([{ type: 'unknown' }]), true);
  const discovery = await qwenAdapter.discover(); assert.equal(discovery.sessions.length, 1); assert.ok(discovery.warnings.length);
  const store = new SessionGraphStore(':memory:');
  try {
    const importer = new Importer(store, [qwenAdapter]); importer.start(['qwen-code']); await importer.settled();
    assert.equal(store.library([], false).sessions.length, 1);
    await writeFile(path, 'corrupted'); importer.start(); await importer.settled();
    assert.equal(store.library([], false).sessions.length, 1);
    assert.match(importer.status.errors.join(' '), /Saved imports are kept/);
  } finally { store.close(); }
}));

test('all twelve sources are registered and new CLI resumes fall back to handoffs for relocated or custom-root histories', async () => {
  assert.equal(adapters.length, 12); assert.equal(new Set(adapters.map(a => a.id)).size, 12);
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-new-launch-')), store = new SessionGraphStore(join(root, 'library.sqlite'));
  try {
    for (const source of ['gemini', 'qwen-code', 'pi', 'copilot'] as const) {
      const session = { id: `${source}:native-id`, source, nativeID: 'native-id', nativeResume: false, directory: root, projectID: 'project', title: 'Synthetic', created: milliseconds, updated: milliseconds, archived: false, model: 'Unknown model', provider: '', agent: source, cost: null, tokens: null };
      const candidate = { session, revision: 'r1', locator: {} }; store.upsert(candidate); store.replace(candidate, [{ id: 'u', time: milliseconds, role: 'user', fragments: [{ kind: 'You', text: 'Synthetic handoff', time: milliseconds }], files: [], tools: [] }], false);
      assert.equal((await prepareLaunch(store, session, source)).mode, 'handoff');
      const native = { ...session, nativeResume: true };
      assert.equal((await prepareLaunch(store, native, source)).mode, 'resume');
      const moved = join(root, 'moved'); await mkdir(moved, { recursive: true });
      assert.equal((await prepareLaunch(store, native, source, moved)).mode, 'handoff');
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
