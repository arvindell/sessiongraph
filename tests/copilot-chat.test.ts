import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copilotChatAdapter, copilotChatRoots, vscodeChatPath } from '../server/adapters/copilot-chat';
import { vscodeChatLog } from '../server/adapters/vscode-chat-log';
import { Importer } from '../server/importer';
import { SessionGraphStore } from '../server/store';
import { adapters } from '../server/adapters';
import { sourceName, sourceIcon } from '../src/sources';
import { prepareLaunch } from '../server/launch';

// Synthetic fixtures follow VS Code's ISerializableChatData[1-3],
// ChatSessionOperationLog and IChatToolInvocationSerialized wire formats.
const date = Date.parse('2026-10-01T12:00:00.000Z');
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const chat = (id = 'session', requests: unknown[] = [{ requestId: 'u1', message: 'Hello', timestamp: date, responseId: 'a1', response: [{ value: 'Answer' }] }]) => ({ version: 3, sessionId: id, creationDate: date - 1000, requests });
const location = (id = 'session', ext = 'json') => `User/workspaceStorage/workspace/chatSessions/${id}.${ext}`;
async function put(root: string, path: string, value: unknown, raw = false) {
  const file = join(root, path); await mkdir(dirname(file), { recursive: true });
  await writeFile(file, raw ? String(value) : JSON.stringify(value)); return file;
}
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-copilot-chat-')), env = 'SESSIONGRAPH_COPILOT_CHAT_USER_DATA_DIR', previous = process.env[env];
  process.env[env] = root;
  try { await run(root); } finally { if (previous === undefined) delete process.env[env]; else process.env[env] = previous; await rm(root, { recursive: true, force: true }); }
}
async function only() {
  const discovery = await copilotChatAdapter.discover();
  assert.deepEqual(discovery.warnings, []); assert.equal(discovery.sessions.length, 1);
  const candidate = discovery.sessions[0], page = await copilotChatAdapter.read(candidate);
  return { candidate, page, messages: page.messages };
}

test('Copilot Chat discovers Windows, Insiders, Unix and custom application-data roots', () => {
  const windows = copilotChatRoots('win32', 'C:\\Users\\Test', { APPDATA: 'D:\\Roaming' });
  assert.ok(windows.includes('D:\\Roaming\\Code\\User\\workspaceStorage'));
  assert.ok(windows.includes('D:\\Roaming\\Code - Insiders\\User\\globalStorage\\emptyWindowChatSessions'));
  assert.ok(windows.includes('C:\\Users\\Test\\.vscode-server\\data\\User\\workspaceStorage'));
  assert.ok(copilotChatRoots('win32', 'C:\\Users\\Test', {}).includes('C:\\Users\\Test\\AppData\\Roaming\\Code\\User\\workspaceStorage'));
  assert.ok(copilotChatRoots('darwin', '/Users/test', {}).includes('/Users/test/Library/Application Support/Code/User/workspaceStorage'));
  assert.ok(copilotChatRoots('linux', '/home/test', { XDG_CONFIG_HOME: '/config' }).includes('/config/Code/User/workspaceStorage'));
  assert.deepEqual(copilotChatRoots('win32', 'C:\\Users\\Test', { SESSIONGRAPH_COPILOT_CHAT_USER_DATA_DIR: 'E:\\Portable\\data\\user-data' }), ['E:\\Portable\\data\\user-data\\User\\workspaceStorage', 'E:\\Portable\\data\\user-data\\User\\globalStorage\\emptyWindowChatSessions']);
  assert.equal(vscodeChatPath('file:///c%3A/Users/Test/My%20Project'), 'c:\\Users\\Test\\My Project');
  assert.equal(vscodeChatPath('file://server/share/My%20Project'), '\\\\server\\share\\My Project');
  assert.equal(vscodeChatPath({ scheme: 'file', path: '/C:/work/100% project' }), 'C:\\work\\100% project');
  assert.equal(vscodeChatPath('file:///home/test/My%20Project'), '/home/test/My Project');
  assert.equal(vscodeChatPath('vscode-remote://wsl+Ubuntu/home/test'), 'vscode-remote://wsl+Ubuntu/home/test');
});

test('Copilot Chat reads legacy and modern JSON, preserves identities, metadata, unknown times and source bytes', async () => fixture(async root => {
  assert.equal(await copilotChatAdapter.detect(), false);
  const value = { ...chat(), customTitle: 'My chat', requests: [
    { requestId: 'u1', message: { text: 'Again', parts: [] }, timestamp: date, responseId: 'a1', response: [{ value: 'First answer' }], modelId: 'copilot-test-model' },
    { requestId: 'u2', message: 'Again', responseId: 'a2', response: 'Second answer', responseTimestamp: date + 1000 },
  ] };
  const path = await put(root, location(), value);
  await put(root, 'User/workspaceStorage/workspace/workspace.json', { folder: 'file:///C%3A/Users/Test/My%20Project' });
  const before = await readFile(path), { candidate, messages, page } = await only();
  assert.equal(await copilotChatAdapter.detect(), true);
  assert.equal(candidate.session.id, 'copilot-chat:session'); assert.equal(candidate.session.directory, 'C:\\Users\\Test\\My Project');
  assert.equal(candidate.session.title, 'My chat'); assert.equal(candidate.session.model, 'copilot-test-model');
  assert.equal(candidate.session.created, date - 1000); assert.equal(candidate.session.cost, null); assert.equal(candidate.session.tokens, null);
  assert.deepEqual(messages.map(m => m.id), ['u1', 'a1', 'u2', 'a2']); assert.deepEqual(messages.map(m => m.time), [date, 0, 0, date + 1000]);
  assert.deepEqual(messages.filter(m => m.role === 'user').map(m => m.fragments[0].text), ['Again', 'Again']);
  assert.match(page.note!, /Missing message timestamps remain unknown/); assert.match(page.note!, /File snapshots are unavailable/);
  assert.deepEqual(await readFile(path), before);
  await writeFile(path, JSON.stringify({ ...value, version: 2, customTitle: undefined, computedTitle: 'Old title' }));
  assert.equal((await only()).candidate.session.title, 'Old title');
  await writeFile(path, JSON.stringify({ ...value, version: undefined, customTitle: undefined }));
  assert.equal((await only()).candidate.session.title, 'Again');
}));

test('Copilot Chat reconstructs append logs, replacements, array truncation and deletion without importing streaming mirrors', async () => fixture(async root => {
  await put(root, location(), { ...chat(), customTitle: 'Stale snapshot' });
  const value = chat('session', [{ requestId: 'u1', message: { text: 'Do it' }, responseId: 'a1', response: [{ value: 'Streaming' }] }]);
  const operations = [
    { kind: 0, v: value },
    { kind: 1, k: ['customTitle'], v: 'Log title' },
    { kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ value: 'Final answer' }] },
    { kind: 2, k: ['requests'], v: [{ requestId: 'discarded', message: 'Rewound' }] },
    { kind: 2, k: ['requests'], i: 1 },
    { kind: 1, k: ['requests', 0, 'timestamp'], v: date },
    { kind: 1, k: ['temporary'], v: true },
    { kind: 3, k: ['temporary'] },
  ];
  const path = await put(root, location('session', 'jsonl'), lines(operations), true), before = await readFile(path);
  const { candidate, messages } = await only();
  assert.ok(candidate.locator.path.endsWith('.jsonl')); assert.equal(candidate.session.title, 'Log title');
  assert.deepEqual(messages.map(m => m.id), ['u1', 'a1']); assert.equal(messages[1].fragments[0].text, 'Final answer');
  assert.equal(messages[0].time, date); assert.equal(Object.hasOwn(vscodeChatLog(lines(operations)), 'temporary'), false);
  assert.deepEqual(await readFile(path), before);
}));

test('Copilot Chat retains tool results and reasoning, and never promotes references or requested edits into file evidence', async () => fixture(async root => {
  await put(root, location(), chat('session', [{ requestId: 'u1', message: 'Fix', timestamp: date, responseId: 'a1', response: [
    { kind: 'thinking', value: ['Plan', 'Inspect'], reasoningStartedAt: date + 10 },
    { kind: 'toolInvocationSerialized', toolId: 'edit_file', toolCallId: 'call', isComplete: true, startedAt: date + 20, completedAt: date + 30, invocationMessage: { value: 'Editing' }, pastTenseMessage: 'Edited', toolSpecificData: { kind: 'input', rawInput: { path: 'not-evidence.ts', apiKey: 'never-store' } }, resultDetails: { input: 'edit', output: 'Saved' }, subAgentInvocationId: 'tool-parent' },
    { kind: 'toolInvocationSerialized', toolId: 'write_file', toolCallId: 'denied', isComplete: true, isConfirmed: { type: 0 }, toolSpecificData: { rawInput: { path: 'denied.ts' } } },
    { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 'failed', isComplete: true, resultError: { message: 'Failed' }, toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' } } },
    { kind: 'toolInvocationSerialized', toolId: 'pending', toolCallId: 'pending', isComplete: false },
    { kind: 'inlineReference', inlineReference: { scheme: 'file', path: '/reference.ts' } },
    { kind: 'textEditGroup', uri: { scheme: 'file', path: '/proposed.ts' }, edits: [] },
    { value: 'Done' },
  ], editedFileEvents: [{ eventKind: 1, uri: { scheme: 'file', path: '/C:/work/accepted.ts' } }, { eventKind: 2, uri: { scheme: 'file', path: '/undone.ts' } }, { eventKind: 3, uri: { scheme: 'file', path: '/user.ts' } }], variableData: { variables: [{ name: 'attachment' }] } }]));
  const { candidate, messages, page } = await only(), events = messages[1].events!;
  assert.deepEqual(messages.flatMap(m => m.files.map(f => f.path)), ['C:\\work\\accepted.ts']);
  assert.equal(candidate.session.parentID, undefined); assert.equal(candidate.session.forkID, undefined);
  assert.equal(events[0].kind, 'reasoning'); assert.equal(events[0].text, 'Plan\nInspect'); assert.equal(events[0].time, date + 10);
  const result = events.find(e => e.callID === 'call' && e.kind === 'tool_result')!;
  assert.equal(result.output, 'Saved'); assert.equal(result.status, 'completed'); assert.equal(result.time, date + 30); assert.equal(result.parentID, 'tool-parent');
  assert.equal(events.find(e => e.callID === 'denied' && e.kind === 'tool_result')?.status, 'failed');
  assert.equal(events.find(e => e.callID === 'failed' && e.kind === 'tool_result')?.status, 'failed');
  assert.equal(events.find(e => e.callID === 'pending' && e.kind === 'tool_result'), undefined);
  assert.equal(events.find(e => e.callID === 'denied')?.time, null);
  assert.ok(!JSON.stringify(messages).includes('never-store')); assert.equal(page.partial, true);
}));

test('Copilot Chat imports empty-window history, ignores drafts, and avoids guessing multi-root or remote directories', async () => fixture(async root => {
  await put(root, 'User/globalStorage/emptyWindowChatSessions/window.json', chat('window'));
  await put(root, 'User/globalStorage/emptyWindowChatSessions/draft.json', { ...chat('draft', []), inputState: { inputText: 'Unsent prompt' } });
  assert.equal((await only()).candidate.session.directory, '');
  await put(root, location('multi'), chat('multi'));
  await put(root, 'User/workspaceStorage/workspace/workspace.json', { workspace: 'file:///C:/projects/multi.code-workspace' });
  let sessions = (await copilotChatAdapter.discover()).sessions;
  assert.equal(sessions.length, 2); assert.equal(sessions.find(c => c.session.nativeID === 'multi')!.session.directory, '');
  await put(root, location('multi'), { ...chat('multi'), workingDirectory: 'vscode-remote://wsl+Ubuntu/home/project' });
  sessions = (await copilotChatAdapter.discover()).sessions;
  assert.equal(sessions.find(c => c.session.nativeID === 'multi')!.session.directory, 'vscode-remote://wsl+Ubuntu/home/project');
}));

test('Copilot Chat preserves saved imports when authoritative logs are corrupt, incomplete or oversized, including migrated duplicates', async () => fixture(async root => {
  const store = new SessionGraphStore(':memory:');
  try {
    const current = { ...chat(), customTitle: 'Current log' };
    const path = await put(root, location('session', 'jsonl'), lines([{ kind: 0, v: current }]), true);
    await put(root, location(), { ...chat(), customTitle: 'Stale JSON' });
    await put(root, 'User/globalStorage/emptyWindowChatSessions/session.json', { ...chat(), customTitle: 'Migrated stale copy' });
    const importer = new Importer(store, [copilotChatAdapter]); importer.start(['copilot-chat']); await importer.settled();
    assert.equal(importer.status.imported, 1); assert.equal(store.getSession('copilot-chat:session')!.title, 'Current log');
    const before = store.content('copilot-chat:session');
    for (const broken of [lines([{ kind: 0, v: current }]) + '{"kind":1', lines([{ kind: 1, k: ['customTitle'], v: 'No initial' }])]) {
      await writeFile(path, broken); importer.start(); await importer.settled();
      assert.match(importer.status.errors.join(' '), /Saved imports are kept/);
      assert.equal(store.getSession('copilot-chat:session')!.title, 'Current log');
      assert.deepEqual(store.content('copilot-chat:session'), before);
    }
    await truncate(path, 32_000_001); importer.start(); await importer.settled();
    assert.equal(importer.status.imported, 0); assert.equal(store.getSession('copilot-chat:session')!.title, 'Current log');
    await writeFile(path, lines([{ kind: 0, v: { ...current, customTitle: 'Recovered' } }]));
    importer.start(); await importer.settled(); assert.equal(store.getSession('copilot-chat:session')!.title, 'Recovered');
    await rm(join(root, 'User'), { recursive: true }); importer.start(); await importer.settled();
    assert.equal(store.library([], false).sessions.length, 1);
  } finally { store.close(); }
}));

test('VS Code log replay rejects unsafe, invalid and unbounded mutation paths', () => {
  const initial = { kind: 0, v: chat() };
  for (const operation of [
    { kind: 1, k: ['__proto__', 'polluted'], v: true },
    { kind: 1, k: ['constructor', 'prototype', 'polluted'], v: true },
    { kind: 1, k: ['requests', 'length'], v: 1_000_000_000 },
    { kind: 1, k: ['requests', 1_000_000_000], v: {} },
    { kind: 1, k: ['missing', 'text'], v: 'invalid' },
    { kind: 2, k: ['requests'], i: 1_000_000_000 },
    { kind: 2, k: ['requests'], v: {} },
    { kind: 4, k: ['requests'] },
  ]) assert.throws(() => vscodeChatLog(lines([initial, operation])));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('Copilot Chat paging, search, timeline and CLI handoffs use the separate registered source', async () => fixture(async root => {
  assert.ok(adapters.some(a => a.id === 'copilot-chat'));
  assert.match(sourceName('copilot-chat'), /VS Code/); assert.match(sourceIcon('copilot-chat'), /copilot.svg/);
  const path = await put(root, location(), { ...chat('session', Array.from({ length: 105 }, (_, i) => ({ requestId: `u${i}`, message: `Prompt ${i}`, timestamp: date + i * 1000, responseId: `a${i}`, response: [{ value: `Answer ${i}` }], responseTimestamp: date + i * 1000 + 500 }))), workingDirectory: root });
  const { candidate, page } = await only(); assert.equal(page.messages.length, 100); assert.ok(page.cursor);
  const next = await copilotChatAdapter.read(candidate, page.cursor); assert.equal(next.messages.length, 100);
  const last = await copilotChatAdapter.read(candidate, next.cursor); assert.equal(last.messages.length, 10); assert.equal(last.cursor, undefined);
  const store = new SessionGraphStore(join(root, 'library.sqlite'));
  try {
    const importer = new Importer(store, [copilotChatAdapter]); importer.start(['copilot-chat']); await importer.settled();
    assert.equal(importer.status.imported, 1); assert.equal(store.handoff(candidate.session.id).totalMessages, 210);
    assert.ok(store.content(candidate.session.id).fragments.some(f => f.text === 'Answer 104'));
    assert.equal(store.events(candidate.session.id).total, 210);
    assert.equal((await prepareLaunch(store, candidate.session, 'copilot')).mode, 'handoff');
    importer.start(); await importer.settled(); assert.equal(importer.status.unchanged, 1);
    await writeFile(path, JSON.stringify(chat()));
    await assert.rejects(copilotChatAdapter.read(candidate, page.cursor), /changed/);
  } finally { store.close(); }
}));
