import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { anthropicUsage, googleUsage, IMPORT_METADATA_VERSION, messageMetadata, messageUsage, openAIUsage, openCodeUsage, piUsage, recordedUsage, sessionUsage, summarizeUsage, sumTokens } from '../server/usage';
import { blankMessage, blankSession } from '../server/adapters/common';
import { adapters } from '../server/adapters';
import { closeSqliteSnapshots } from '../server/adapters/sqlite-snapshot';
import { openCodeMessage } from '../server/adapters/opencode';
import { codexRecord } from '../server/adapters/codex';
import { SessionGraphStore } from '../server/store';
import { Importer } from '../server/importer';
import type { ImportedMessage, SessionAdapter } from '../server/adapters/types';
import { playbackTokens } from '@sessiongraph/core/playback-tokens';
import { publishableGraph, DEFAULT_PUBLISHING } from '@sessiongraph/core/public-graph';
import { makeGraph } from '@sessiongraph/core/layout';
import { shareGraph } from '../src/share-graph';
import { contentVersion } from '../src/search/persistence';

// Native schemas: docs/import-coverage.md, "Recorded usage and metadata audit".
const at = Date.parse('2026-11-01T12:00:00Z'), iso = new Date(at).toISOString();
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const apiUsage = { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 };
const piTokens = { input: 50, output: 20, cacheRead: 100, cacheWrite: 10, totalTokens: 180, reasoning: 5 };
const assistant = (id: string, usage?: ImportedMessage['usage']): ImportedMessage => ({ ...blankMessage(id, at + 10, 'assistant'), usage });

async function put(root: string, path: string, data: unknown, raw = false) {
  const file = join(root, path); await mkdir(dirname(file), { recursive: true });
  await writeFile(file, raw ? String(data) : JSON.stringify(data)); return file;
}
async function fixture(source: string, run: (root: string, store: SessionGraphStore, sync: () => Promise<ReturnType<SessionGraphStore['getSession']>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-usage-')), store = new SessionGraphStore(':memory:');
  store.setting('sourcePaths', { [source]: root });
  const importer = new Importer(store, [adapters.find(adapter => adapter.id === source)!]);
  const sync = async () => {
    importer.start([source]); await importer.settled();
    assert.equal(importer.status.failed, 0, JSON.stringify(importer.status));
    const sessions = store.library([], false).sessions;
    assert.equal(sessions.length, 1, JSON.stringify(importer.status));
    return sessions[0];
  };
  try { await run(root, store, sync); }
  finally { store.close(); closeSqliteSnapshots(); await rm(root, { recursive: true, force: true }); }
}

test('native usage totals count overlapping cache/reasoning once and retain missing fields as unknown', () => {
  assert.equal(anthropicUsage(apiUsage)!.total, 180);
  assert.equal(anthropicUsage({ input_tokens: 50, output_tokens: 20 })!.total, 70);
  assert.equal(anthropicUsage({ ...apiUsage, cache_creation_input_tokens: undefined })!.total, null);
  const openai = openAIUsage({ input_tokens: 150, output_tokens: 20, total_tokens: 170, cached_input_tokens: 100, reasoning_output_tokens: 5 })!;
  assert.equal(openai.total, 170); assert.equal(openai.cacheRead, 100); assert.equal(openai.reasoning, 5);
  assert.equal(openai.inputIncludesCache, true);
  assert.equal(piUsage(piTokens)!.total, 180);
  assert.equal(openCodeUsage({ input: 50, output: 20, reasoning: 5, cache: { read: 100, write: 10 } })!.total, 180);
  assert.equal(googleUsage({ input: 150, output: 20, cached: 100, thoughts: 5, total: 175 })!.total, 175);
  assert.equal(googleUsage({ promptTokenCount: 150, candidatesTokenCount: 20, cachedContentTokenCount: 100, thoughtsTokenCount: 5, totalTokenCount: 170 })!.outputIncludesReasoning, true);
  assert.equal(googleUsage({ input: 150, output: 20, thoughts: 5 })!.total, null, 'provider-dependent reasoning is not guessed');
  assert.equal(googleUsage({ input: 150, output: 20, thoughts: 5, total: 0 })!.total, null, 'a native missing-total sentinel is not reported as zero usage');
  assert.equal(googleUsage({ input: 150, output: 20, thoughts: 5, total: 0 })!.outputIncludesReasoning, null);
  assert.equal(googleUsage({ input: 150, output: 20, thoughts: 5, total: 999 })!.outputIncludesReasoning, null, 'inconsistent totals do not establish overlap');
  assert.equal(openAIUsage({ input_tokens: 0, output_tokens: 0 })!.total, 0);
  for (const invalid of [undefined, null, -1, NaN, Infinity, 1.5, '123']) assert.equal(recordedUsage({ total: invalid as number }), undefined);
  assert.equal(sumTokens([Number.MAX_SAFE_INTEGER, 1]), null);
  assert.equal(sumTokens([0, null]), null);
  assert.equal(messageUsage({ usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170, reasoningTokens: 5 } })!.total, 170);
  assert.equal(messageUsage({ usage: { total_tokens: 170 } })!.total, 170);
  assert.equal(messageUsage({ usage: { outputTokens: 20 } })!.total, null);
  for (const usage of [null, [], 'invalid', { input_tokens: '100', output_tokens: -1 }]) assert.equal(messageUsage({ usage }), undefined);
});

test('structured metadata is bounded and no credentials, arbitrary raw fields, or text token estimates are imported', () => {
  const raw = { id: 'native', role: 'assistant', model: 'm', provider: 'p', agent: 'a', stop_reason: 'end_turn', cwd: '/native/context',
    apiKey: 'secret', metadata: { password: 'secret' }, time: { created: 100, firstToken: 125, completed: 180 }, content: 'There are 999999 tokens' };
  assert.equal(messageUsage(raw), undefined);
  assert.deepEqual(messageMetadata(raw), { model: 'm', provider: 'p', agent: 'a', stopReason: 'end_turn', cwd: '/native/context', durationMs: 80, firstTokenMs: 25 });
  assert.equal(messageMetadata({ durationMs: -1, time: { created: 10, completed: 9 } }), undefined);
  assert.equal(messageMetadata({ model: 'm'.repeat(1000), cwd: '/'.repeat(5000) })!.model!.length, 256);
  assert.equal(messageMetadata({ model: 'm'.repeat(1000), cwd: '/'.repeat(5000) })!.cwd!.length, 4096);
});

test('native API identities deduplicate streaming usage without merging distinct transcript messages or sessions', () => {
  const first = assistant('envelope-1', anthropicUsage({ ...apiUsage, output_tokens: 10 }, 'api-response'));
  const second = assistant('envelope-2', anthropicUsage(apiUsage, 'api-response'));
  const distinct = assistant('envelope-3', anthropicUsage(apiUsage, 'other-api-response'));
  const summary = summarizeUsage(blankSession('claude-code', 's'), [first, second, distinct], false);
  assert.equal(summary.total, 360); assert.equal(summary.reportedMessages, 2); assert.equal(summary.partial, false);
  assert.equal(summary.cacheRead, 200);
  const partial = summarizeUsage(blankSession('claude-code', 's'), [first, assistant('unreported')], false);
  assert.equal(partial.total, 170); assert.equal(partial.partial, true); assert.equal(partial.missingMessages, 1);
  const unknown = summarizeUsage(blankSession('test', 's'), [assistant('unreported')], false);
  assert.equal(unknown.total, null); assert.equal(unknown.source, 'unavailable');
  assert.equal('scope' in unknown, false);
  assert.equal(summarizeUsage(blankSession('test', 'other'), [first], false).total, 170);
  const overflow = summarizeUsage(blankSession('test', 'overflow'), [assistant('one', recordedUsage({ total: Number.MAX_SAFE_INTEGER })), assistant('two', recordedUsage({ total: 1 }))], false);
  assert.equal(overflow.total, null); assert.equal(overflow.partial, true);
  const costOnly = { ...blankSession('test', 'cost'), usage: sessionUsage(recordedUsage({ cost: .02, costEstimated: true })) };
  const withCost = summarizeUsage(costOnly, [assistant('a', recordedUsage({ total: 10 }))], false);
  assert.equal(withCost.cost, .02); assert.equal(withCost.costEstimated, true);
});

test('Codex cumulative snapshots use source order, never sum snapshots or move the last conversation time', () => {
  const candidate = { session: { ...blankSession('codex', 'native'), created: at }, revision: 'r', locator: {} };
  const usage = (total: number, ordinal: number) => codexRecord({ type: 'event_msg', timestamp: new Date(at + ordinal * 1000).toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total, cached_input_tokens: 50, reasoning_output_tokens: 5 } } } }, ordinal, candidate)!;
  const messages = [blankMessage('u', at, 'user'), assistant('a'), usage(150, 1), usage(200, 2), usage(200, 3)];
  const store = new SessionGraphStore(':memory:');
  try {
    store.upsert(candidate); store.replace(candidate, messages, false);
    assert.equal(store.getSession(candidate.session.id)!.tokens, 200);
    assert.equal(store.getSession(candidate.session.id)!.activity!.lastMessageAt, at + 10);
    assert.equal(summarizeUsage(candidate.session, [...messages, usage(100, 4)], false).total, 100, 'a reset is not a monotonic maximum');
    assert.ok(store.messages(candidate.session.id).messages.some(message => message.usage?.scope === 'session'));
    const incomplete = blankMessage('incomplete', at + 5000, 'system');
    incomplete.usage = recordedUsage({ input: 150, reasoning: 5 }, 'session');
    const partial = summarizeUsage(candidate.session, [incomplete], false);
    assert.equal(partial.input, 150); assert.equal(partial.reasoning, 5); assert.equal(partial.total, null); assert.equal(partial.partial, true);
    const stale = summarizeUsage(candidate.session, [...messages, incomplete], false);
    assert.equal(stale.total, 200); assert.equal(stale.partial, true);
  } finally { store.close(); }
});

test('metadata upgrades reimport unchanged source revisions once, retain totals on refresh, and merge paged duplicate usage', async () => {
  const store = new SessionGraphStore(':memory:');
  const candidate = () => ({ session: { ...blankSession('fixture', 'native'), created: at }, revision: 'unchanged', locator: {} });
  let reads = 0;
  const adapter: SessionAdapter = { id: 'fixture', name: 'Fixture', description: '', capabilities: { history: true, files: false, children: false, forks: false },
    async detect() { return true; }, async discover() { return { sessions: [candidate()], projects: [], warnings: [] }; },
    async read(_candidate, cursor) { reads++; return { messages: [{ ...assistant('same', openAIUsage({ input_tokens: 100, output_tokens: cursor ? 50 : 10 }, 'response')),
      metadata: cursor ? { stopReason: 'stop' } : { model: 'native-model' } }], cursor: cursor ? undefined : 'next' }; } };
  try {
    store.upsert(candidate()); store.replace(candidate(), [assistant('old')], false);
    store.db.prepare("UPDATE sessions SET metadata=json_remove(metadata,'$.importVersion','$.usage') WHERE id=?").run('fixture:native');
    const oldVersion = contentVersion(store.getSession('fixture:native')!);
    const importer = new Importer(store, [adapter]); importer.start(['fixture']); await importer.settled();
    const saved = store.getSession('fixture:native')!;
    assert.equal(reads, 2); assert.equal(saved.tokens, 150); assert.equal(saved.importVersion, IMPORT_METADATA_VERSION);
    assert.notEqual(contentVersion(saved), oldVersion);
    assert.equal(store.content(saved.id).messages, 1);
    assert.deepEqual(store.messages(saved.id).messages[0].metadata, { model: 'native-model', stopReason: 'stop' });
    importer.start(); await importer.settled();
    assert.equal(reads, 2); assert.equal(importer.status.unchanged, 1);
    assert.equal(store.getSession(saved.id)!.tokens, 150, 'blank discovery defaults must not erase derived totals');
  } finally { store.close(); }
});

test('usage replacement is atomic and failed upgrades retain previous usage and message evidence', async () => {
  const store = new SessionGraphStore(':memory:'), session = { ...blankSession('test', 'native'), created: at };
  const candidate = { session, revision: 'old', locator: { path: 'old' } };
  try {
    store.upsert(candidate); store.replace(candidate, [assistant('old', piUsage(piTokens))], false);
    const saved = store.getSession(session.id)!;
    store.db.exec("CREATE TEMP TRIGGER abort_usage BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(() => store.replace({ ...candidate, revision: 'new' }, [assistant('new', piUsage({ ...piTokens, totalTokens: 1000 }))], false), /test rollback/);
    assert.deepEqual(store.getSession(session.id), saved);
    assert.equal(store.messages(session.id).messages[0].id, 'old');
    store.db.exec('DROP TRIGGER abort_usage');
    store.db.prepare("UPDATE sessions SET metadata=json_remove(metadata,'$.importVersion') WHERE id=?").run(session.id);
    const adapter: SessionAdapter = { id: 'test', name: 'Test', description: '', capabilities: { history: true, files: false, children: false, forks: false },
      async detect() { return true; }, async discover() { return { sessions: [candidate], projects: [], warnings: [] }; }, async read() { throw new Error('Unavailable'); } };
    const importer = new Importer(store, [adapter]); importer.start(['test']); await importer.settled();
    assert.equal(importer.status.failed, 1); assert.equal(store.getSession(session.id)!.tokens, 180);
    assert.equal(store.messages(session.id).messages[0].id, 'old');
  } finally { store.close(); }
});

test('OpenCode retains native usage, model, stop reason, measured timing, and recorded directory moves', () => {
  const native = openCodeMessage({ id: 'a', type: 'assistant', time: { created: at, completed: at + 100 }, model: { id: 'm', providerID: 'p' }, agent: 'build', finish: 'stop',
    cost: 0, tokens: { input: 50, output: 20, reasoning: 5, cache: { read: 100, write: 10 } }, content: [] }, 'opencode:native');
  assert.equal(native.usage!.total, 180); assert.equal(native.usage!.cost, 0);
  assert.deepEqual(native.metadata, { model: 'm', provider: 'p', agent: 'build', stopReason: 'stop', durationMs: 100 });
  const move = openCodeMessage({ id: 'move', type: 'location-switched', time: { created: at + 200 }, location: { directory: '/recorded/worktree' } }, 'opencode:native');
  const store = new SessionGraphStore(':memory:'), c = { session: { ...blankSession('opencode', 'native'), created: at }, revision: '1', locator: {} };
  try {
    store.upsert(c); store.replace(c, [native, move], false);
    assert.deepEqual(store.detail(c.session.id).locations, [{ directory: '/recorded/worktree', time: at + 200 }]);
  } finally { store.close(); }
});

test('Claude reads usage from retained raw envelopes as well as the SDK chain, excluding subagents', async () => fixture('claude-code', async (root, store, sync) => {
  const id = randomUUID(), wrap = (uuid: string, type: string, message: unknown, parentUuid: string | null, extra = {}) => ({
    sessionId: id, uuid, type, parentUuid, message, cwd: '/fixture', timestamp: iso, ...extra,
  });
  const file = await put(root, `projects/project/${id}.jsonl`, lines(
    wrap('u', 'user', { role: 'user', content: 'Prompt' }, null),
    wrap('a1', 'assistant', { id: 'api', role: 'assistant', content: [{ type: 'text', text: 'First block' }], model: 'claude-test', usage: { ...apiUsage, output_tokens: 10 } }, 'u'),
    wrap('a2', 'assistant', { id: 'api', role: 'assistant', content: [{ type: 'text', text: 'Second block' }], model: 'claude-test', usage: apiUsage, stop_reason: 'end_turn' }, 'a1'),
    wrap('side', 'assistant', { id: 'child-api', role: 'assistant', content: 'Separate child', usage: { ...apiUsage, output_tokens: 999 } }, null, { isSidechain: true, agentId: 'child' }),
  ), true);
  const before = await readFile(file), saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.usage!.reportedMessages, 1);
  assert.equal(saved.usage!.source, 'session');
  assert.ok(store.messages(saved.id).messages.some(message => message.metadata?.model === 'claude-test'));
  assert.deepEqual(await readFile(file), before);
}));

for (const source of ['pi', 'prime-agent', 'omp', 'senpi', 'kimchi', 'gajae', 'openclaw', 'proma']) test(`${source} imports native Pi usage and metadata`, async () => fixture(source, async (root, store, sync) => {
  const file = source === 'openclaw' ? 'agent/sessions/native.jsonl' : 'project/native.jsonl';
  await put(root, file, lines({ type: 'session', id: 'native', timestamp: iso, cwd: '/fixture' },
    { type: 'message', id: 'u', message: { role: 'user', timestamp: at, content: 'Prompt' } },
    { type: 'message', id: 'a', message: { role: 'assistant', timestamp: at + 1, model: 'm', provider: 'p', stopReason: 'stop', usage: piTokens, content: 'Answer' } }), true);
  const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.usage!.cacheRead, 100);
  assert.equal(store.messages(saved.id).messages[0].metadata?.stopReason, 'stop');
}));

for (const source of ['droid', 'cherry-studio', 'command-code', 'zcode', 'codebuddy', 'workbuddy', 'aside']) test(`${source} imports native usage without merging transcript envelopes`, async () => fixture(source, async (root, store, sync) => {
  await put(root, source === 'aside' ? 'account/sessions/native/messages.jsonl' : 'project/native.jsonl', lines(
    { sessionId: 'native', uuid: 'u', type: 'user', timestamp: iso, message: { content: 'Prompt' } },
    { sessionId: 'native', uuid: 'a1', type: 'assistant', message: { id: 'same-api', role: 'assistant', content: 'One block', usage: apiUsage } },
    { sessionId: 'native', uuid: 'a2', type: 'assistant', message: { id: 'same-api', role: 'assistant', content: 'Another block', usage: apiUsage } }), true);
  const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(store.content(saved.id).messages, 3);
}));

test('Gemini imports late usage/model/thought/tool-status patches and excludes discarded messages', async () => fixture('gemini', async (root, store, sync) => {
  await put(root, 'tmp/project/chats/native.jsonl', lines({ sessionId: 'native', startTime: iso },
    { id: 'u', type: 'user', timestamp: iso, content: 'Prompt' },
    { id: 'a', type: 'gemini', timestamp: iso, content: 'Answer', toolCalls: [{ id: 'edit', name: 'write_file', args: { file_path: '/fixture/done.ts' }, status: 'running' }] },
    { id: 'discard', type: 'gemini', tokens: { total: 9999 }, content: 'Removed' }, { $rewindTo: 'discard' },
    { $patch: { updates: [{ id: 'a', model: 'gemini-test', tokens: { input: 150, output: 20, cached: 100, thoughts: 5, total: 175 },
      thoughts: [{ subject: 'Reasoning', description: 'Saved reasoning' }], toolCalls: [{ id: 'edit', status: 'success', result: 'Saved' }] }] } }), true);
  const saved = (await sync())!;
  assert.equal(saved.tokens, 175); assert.equal(saved.model, 'gemini-test');
  assert.equal(saved.usage!.reasoning, 5); assert.equal(store.detail(saved.id).files[0].path, '/fixture/done.ts');
  assert.ok(store.events(saved.id).items.some(item => item.kind === 'reasoning'));
}));

test('Codex rollouts populate session totals without summing cumulative snapshots', async () => fixture('codex', async (root, _store, sync) => {
  await put(root, 'sessions/native.jsonl', lines({ type: 'session_meta', payload: { id: 'native', timestamp: iso, cwd: '/fixture' } },
    { type: 'response_item', timestamp: iso, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Prompt' }] } },
    ...[150, 200, 200].map(total => ({ type: 'event_msg', timestamp: iso, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - 20, output_tokens: 20, total_tokens: total } } } }))), true);
  assert.equal((await sync())!.tokens, 200);
}));

test('Qwen provider-native totals disambiguate cached and reasoning subsets', async () => fixture('qwen-code', async (root, _store, sync) => {
  await put(root, 'projects/p/chats/native.jsonl', lines({ sessionId: 'native', uuid: 'u', timestamp: iso, type: 'user', message: { parts: [{ text: 'Prompt' }] } },
    { sessionId: 'native', uuid: 'a', timestamp: iso, type: 'assistant', model: 'qwen-test', message: { parts: [{ text: 'Answer' }] },
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 20, cachedContentTokenCount: 100, thoughtsTokenCount: 5, totalTokenCount: 170 } }), true);
  const saved = (await sync())!;
  assert.equal(saved.tokens, 170); assert.equal(saved.usage!.outputIncludesReasoning, true);
}));

test('Cline native UI billing rows do not become messages and trigger refresh on sidecar changes', async () => fixture('cline', async (root, store, sync) => {
  await put(root, 'tasks/native/api_conversation_history.json', [{ role: 'user', timestamp: at, content: 'Prompt' }, { role: 'assistant', content: 'Answer' }]);
  const file = await put(root, 'tasks/native/ui_messages.json', [{ type: 'say', say: 'api_req_started', ts: at + 1000,
    text: JSON.stringify({ tokensIn: 50, tokensOut: 20, cacheReads: 100, cacheWrites: 10, cost: 0 }) }]);
  const first = (await sync())!;
  assert.equal(first.tokens, 180); assert.equal(first.cost, 0); assert.equal(store.content(first.id).messages, 2);
  assert.equal(first.activity!.lastMessageAt, at, 'billing timestamps never become conversation timestamps');
  await writeFile(file, JSON.stringify([{ type: 'say', say: 'api_req_started', ts: at + 1000,
    text: JSON.stringify({ tokensIn: 50, tokensOut: 30, cacheReads: 100, cacheWrites: 10, cost: .01 }) }]));
  const next = (await sync())!; assert.equal(next.tokens, 190); assert.notEqual(next.revision, first.revision);
}));

test('Cline SDK metrics are gross input and output, not cache counted twice', async () => fixture('cline', async (root, _store, sync) => {
  await put(root, 'data/sessions/native/native.messages.json', { sessionId: 'native', messages: [
    { id: 'u', role: 'user', ts: at, content: 'Prompt' },
    { id: 'a', role: 'assistant', content: 'Answer', metrics: { inputTokens: 150, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 10, cost: .01 } },
  ] });
  assert.equal((await sync())!.tokens, 170);
}));

test('Continue retains native session usage breakdowns and zero costs', async () => fixture('continue', async (root, store, sync) => {
  await put(root, 'sessions/native.json', { sessionId: 'native', workspaceDirectory: '/fixture', history: [
    { message: { id: 'u', role: 'user', timestamp: at, content: 'Prompt' } },
    { message: { id: 'a', role: 'assistant', timestamp: at + 1, content: 'Answer' } },
  ], usage: { promptTokens: 150, completionTokens: 20, totalCost: 0 } });
  const saved = (await sync())!;
  assert.equal(saved.tokens, 170); assert.equal(saved.cost, 0); assert.equal(saved.usage!.input, 150);
  assert.equal(saved.usage!.output, 20); assert.equal(saved.usage!.inputIncludesCache, true);
  assert.equal(store.content(saved.id).messages, 2);
}));

test('Amp retains per-response usage and model without adding overlapping ledger records', async () => fixture('amp', async (root, store, sync) => {
  await put(root, 'native.json', { id: 'native', created: at, messages: [
    { messageId: 1, role: 'user', content: 'Prompt' },
    { messageId: 2, role: 'assistant', content: 'Answer', usage: { model: 'amp-native', timestamp: iso,
      inputTokens: 50, outputTokens: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 10, credits: 1 } },
  ], usageLedger: { events: [{ tokens: { input: 50, output: 20, cacheReadInputTokens: 100, cacheCreationInputTokens: 10 }, credits: 1 }] } });
  const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.cost, null, 'credits are not USD');
  const messages = store.messages(saved.id).messages;
  assert.equal(messages.find(m => m.role === 'user')!.time, null);
  assert.equal(messages.find(m => m.role === 'assistant')!.metadata!.model, 'amp-native');
  assert.equal(messages.length, 2);
}));

test('Jcode journal corrections replace usage by identity and preserve native cache semantics', async () => fixture('jcode', async (root, store, sync) => {
  await put(root, 'session_native.json', { id: 'native', created_at: iso, messages: [
    { id: 'u', role: 'user', timestamp: iso, content: 'Prompt' },
    { id: 'a', role: 'assistant', content: 'Original', token_usage: { ...apiUsage, output_tokens: 1 } },
    { id: 'b', role: 'assistant', content: 'OpenAI-style', token_usage: { input_tokens: 150, output_tokens: 20, cache_read_input_tokens: 100, reasoning_output_tokens: 5 } },
  ] });
  await put(root, 'session_native.journal.jsonl', lines({ append_messages: [
    { id: 'a', role: 'assistant', content: 'Corrected', tool_duration_ms: 25, token_usage: apiUsage },
  ] }), true);
  const saved = (await sync())!;
  assert.equal(saved.tokens, 350); assert.equal(saved.usage!.cacheRead, 200);
  const messages = store.messages(saved.id).messages;
  assert.equal(messages.length, 3); assert.equal(messages.find(m => m.id === 'a')!.metadata!.durationMs, 25);
  assert.equal(messages.find(m => m.id === 'b')!.usage!.inputIncludesCache, true);
  assert.ok(!JSON.stringify(messages).includes('Original'));
}));

for (const source of ['roo-code', 'kilo-code']) test(`${source} retains ambiguous legacy cache breakdowns without inventing a total`, async () => fixture(source, async (root, _store, sync) => {
  await put(root, 'tasks/native/api_conversation_history.json', [{ role: 'user', timestamp: at, content: 'Prompt' }]);
  await put(root, 'tasks/native/ui_messages.json', [{ type: 'say', say: 'api_req_started', ts: at,
    text: JSON.stringify({ tokensIn: 150, tokensOut: 20, cacheReads: 100, cacheWrites: 10, cost: .01 }) }]);
  const saved = (await sync())!;
  assert.equal(saved.tokens, null); assert.equal(saved.usage!.input, 150); assert.equal(saved.usage!.inputIncludesCache, null);
  assert.equal(saved.cost, .01);
}));

test('Copilot Chat imports request usage, resolved model and zero counts', async () => fixture('copilot-chat', async (root, store, sync) => {
  await put(root, 'User/workspaceStorage/workspace/chatSessions/native.json', { version: 3, sessionId: 'native', creationDate: at, requests: [
    { requestId: 'u', timestamp: at, message: { text: 'Prompt' }, response: [{ kind: 'markdownContent', content: { value: 'Answer' } }], result: { metadata: { promptTokens: 150, outputTokens: 20, resolvedModel: 'resolved-model' } } },
  ] });
  const saved = (await sync())!; assert.equal(saved.tokens, 170);
  assert.ok(store.messages(saved.id).messages.some(message => message.metadata?.model === 'resolved-model'));
}));

test('Vibe imports session usage without treating cached input as additional tokens', async () => fixture('vibe', async (root, _store, sync) => {
  await put(root, 'native/meta.json', { session_id: 'native', start_time: iso, stats: { session_prompt_tokens: 150, session_completion_tokens: 20, session_cached_tokens: 100 } });
  await put(root, 'native/messages.jsonl', lines({ id: 'u', role: 'user', timestamp: iso, content: 'Prompt' }), true);
  const saved = (await sync())!;
  assert.equal(saved.tokens, 170); assert.equal(saved.usage!.cacheRead, 100); assert.equal(saved.usage!.source, 'session');
}));

test('Mux imports one session snapshot, retains disjoint reasoning and refreshes on usage-only changes', async () => fixture('mux', async (root, store, sync) => {
  await put(root, 'native/chat.jsonl', lines({ id: 'u', role: 'user', metadata: { timestamp: at }, parts: [{ type: 'text', text: 'Prompt' }] }), true);
  const model = { input: { tokens: 50, cost_usd: .01 }, cached: { tokens: 100, cost_usd: .002 }, cacheCreate: { tokens: 10, cost_usd: .001 },
    output: { tokens: 20, cost_usd: .003 }, reasoning: { tokens: 5, cost_usd: .001 } };
  const file = await put(root, 'native/session-usage.json', { byModel: { m: model }, lastRequest: { timestamp: at + 9999 } });
  const first = (await sync())!;
  assert.equal(first.tokens, 185); assert.equal(store.content(first.id).messages, 1); assert.equal(first.activity!.lastMessageAt, at);
  await writeFile(file, JSON.stringify({ byModel: { m: { ...model, output: { tokens: 30, cost_usd: .004 } } } }));
  assert.equal((await sync())!.tokens, 195);
}));

test('Fx usage is imported without manufacturing any conversation history', async () => fixture('fx', async (root, store, sync) => {
  await put(root, 'native/session.json', { id: 'native', created_at_ms: at });
  await put(root, 'native/usage-v2.json', { session_id: 'native', snapshot: { input_tokens: 50, output_tokens: 20, cache_read_tokens: 100, cache_write_tokens: 10, reasoning_tokens: 5, total_cost: 0 } });
  const saved = (await sync())!;
  assert.equal(saved.tokens, 185); assert.equal(saved.cost, 0); assert.equal(store.content(saved.id).messages, 0);
  assert.equal(saved.activity!.lastMessageAt, null);
}));

test('Hermes imports session-native counts and keeps reasoning as an output subset', async () => fixture('hermes', async (root, _store, sync) => {
  const path = join(root, 'state.db'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL);
    CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)').run('native', at / 1000, 50, 20, 100, 10, 5, 0, 1);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(1, 'native', 'user', 'Prompt', at / 1000); db.close();
  const saved = (await sync())!; assert.equal(saved.tokens, 180); assert.equal(saved.cost, 0); assert.equal(saved.usage!.costEstimated, false);
}));

test('Hermes per-model usage works without a legacy session aggregate', async () => fixture('hermes', async (root, _store, sync) => {
  const db = new DatabaseSync(join(root, 'state.db'));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL); CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    CREATE TABLE session_model_usage(session_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER);`);
  db.prepare('INSERT INTO sessions VALUES (?,?)').run('native', at / 1000);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(1, 'native', 'user', 'Prompt', at / 1000);
  db.prepare('INSERT INTO session_model_usage VALUES (?,?,?,?,?,?)').run('native', 50, 20, 100, 10, 5); db.close();
  assert.equal((await sync())!.tokens, 180);
}));

test('Hermes prefers per-model tokens over a legacy zero aggregate and retains session cost provenance', async () => fixture('hermes', async (root, _store, sync) => {
  const db = new DatabaseSync(join(root, 'state.db'));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, estimated_cost_usd REAL);
    CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);
    CREATE TABLE session_model_usage(session_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER);`);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('native', at / 1000, 0, 0, 0, 0, .02);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(1, 'native', 'user', 'Prompt', at / 1000);
  db.prepare('INSERT INTO session_model_usage VALUES (?,?,?,?,?,?)').run('native', 50, 20, 100, 10, 5); db.close();
  const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.cost, .02); assert.equal(saved.usage!.costEstimated, true);
}));

test('OpenClaw SQLite preserves non-message events and native usage without shifting conversation endpoints', async () => fixture('openclaw', async (root, store, sync) => {
  const path = join(root, 'agent/agent/openclaw-agent.sqlite'); await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT);`);
  db.prepare('INSERT INTO session_windows VALUES (?,?)').run('native', at);
  const insert = db.prepare('INSERT INTO transcript_events VALUES (?,?,?)');
  insert.run('native', 1, JSON.stringify({ type: 'message', id: 'u', timestamp: at, message: { role: 'user', content: 'Prompt' } }));
  insert.run('native', 2, JSON.stringify({ type: 'message', id: 'a', timestamp: at + 1, message: { role: 'assistant', content: 'Answer', usage: piTokens } }));
  insert.run('native', 3, JSON.stringify({ type: 'compaction', id: 'c', parentId: 'a', timestamp: at + 100, summary: 'Retained context' }));
  db.close();
  const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.activity!.lastMessageAt, at + 1);
  const summary = store.events(saved.id).items.find(item => item.kind === 'compaction')!;
  const compaction = store.events(saved.id, { item: summary.id }).selected!;
  assert.equal(compaction.parentID, 'a'); assert.equal(compaction.time, at + 100); assert.equal(compaction.text, 'Retained context');
}));

for (const source of ['kilo-cli', 'mimo-code', 'mimo-desktop']) test(`${source} imports native SQLite message counters and timing`, async () => fixture(source, async (root, store, sync) => {
  const db = new DatabaseSync(join(root, 'history.db'));
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, time_created INTEGER, version TEXT);
    CREATE TABLE message(id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part(id TEXT, message_id TEXT, data TEXT);`);
  db.prepare('INSERT INTO session VALUES (?,?,?)').run('native', at, source === 'mimo-desktop' ? 'desktop-1' : '1');
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('a', 'native', JSON.stringify({ role: 'assistant', modelID: 'native-model', providerID: 'native-provider',
    time: { created: at, completed: at + 25 }, cost: 0, tokens: { input: 50, output: 20, reasoning: 5, cache: { read: 100, write: 10 } } }), at);
  db.prepare('INSERT INTO part VALUES (?,?,?)').run('part', 'a', JSON.stringify({ type: 'text', text: 'Answer' }));
  db.close();
  const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.cost, 0); assert.equal(saved.usage!.reasoning, 5);
  assert.deepEqual(store.messages(saved.id).messages[0].metadata, { model: 'native-model', provider: 'native-provider', durationMs: 25 });
}));

test('Goose prefers lifetime accumulated totals rather than adding current context totals', async () => fixture('goose', async (root, _store, sync) => {
  const db = new DatabaseSync(join(root, 'sessions.db'));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, created_at TEXT, total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER);
    CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content_json TEXT, created_timestamp REAL);`);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('native', iso, 10, 8, 2, 200, 150, 50);
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run(1, 'native', 'user', JSON.stringify('Prompt'), at); db.close();
  const saved = (await sync())!; assert.equal(saved.tokens, 200); assert.equal(saved.usage!.partial, false);
}));

test('Zed imports usage independently of unavailable message timestamps', async () => fixture('zed', async (root, store, sync) => {
  const db = new DatabaseSync(join(root, 'threads.db'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, created_at INTEGER, data_type TEXT, data TEXT)');
  db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run('native', at, 'json', JSON.stringify({ messages: [{ User: { id: 'u', content: [{ Text: 'Prompt' }] } }],
    cumulative_token_usage: apiUsage, request_token_usage: { same: apiUsage } }));
  db.close(); const saved = (await sync())!;
  assert.equal(saved.tokens, 180); assert.equal(saved.activity!.lastMessageAt, null); assert.equal(store.messages(saved.id).messages[0].time, null);
}));

test('Unsloth retains recorded usage and response-specific model/provider metadata', async () => fixture('unsloth', async (root, store, sync) => {
  const db = new DatabaseSync(join(root, 'studio.db'));
  db.exec(`CREATE TABLE chat_threads(id TEXT PRIMARY KEY, created_at REAL); CREATE TABLE chat_messages(id TEXT, thread_id TEXT, role TEXT, content_json TEXT, created_at REAL, metadata_json TEXT);`);
  db.prepare('INSERT INTO chat_threads VALUES (?,?)').run('native', at / 1000);
  db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?)').run('a', 'native', 'assistant', JSON.stringify('Answer'), at / 1000,
    JSON.stringify({ contextUsage: { promptTokens: 150, completionTokens: 20, totalTokens: 170, cachedTokens: 100, reasoningTokens: 5 }, responseDetails: { responseModelId: 'actual-model', providerType: 'provider' }, secret: 'not-imported' }));
  db.close(); const saved = (await sync())!;
  assert.equal(saved.tokens, 170); assert.deepEqual(store.messages(saved.id).messages[0].metadata, { model: 'actual-model', provider: 'provider' });
  assert.ok(!JSON.stringify(store.messages(saved.id)).includes('not-imported'));
}));

test('new private metadata stays out of anonymous graph/video payloads and all native totals reach playback', () => {
  const session = { ...blankSession('codex', 'native'), created: at, tokens: 170, usage: sessionUsage(openAIUsage({ input_tokens: 150, output_tokens: 20 }))!, importVersion: IMPORT_METADATA_VERSION };
  const published = publishableGraph([session], DEFAULT_PUBLISHING), video = shareGraph(makeGraph([session], []));
  for (const value of [published, video]) {
    assert.ok(!JSON.stringify(value).includes('inputIncludesCache'));
    assert.ok(!JSON.stringify(value).includes('importVersion'));
    assert.ok(!JSON.stringify(value).includes('reportedMessages'));
  }
  assert.equal(playbackTokens([session]).at(0, true).tokens, 170);
});
