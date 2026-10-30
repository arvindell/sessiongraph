import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AtlasStore } from '../server/store';
import { Importer } from '../server/importer';
import { blankSession, blankMessage } from '../server/adapters/common';
import { readJSONL } from '../server/adapters/jsonl';
import { codexRecord, codexUserText } from '../server/adapters/codex';
import { claudeMessages } from '../server/adapters/claude';
import { contentVersion, type CachedContent } from '../src/search/persistence';
import type { Candidate, SessionAdapter } from '../server/adapters/types';

test('SQLite imports deduplicate native identities and messages; changed history replaces atomically and survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-store-')), path = join(directory, 'atlas.sqlite');
  let store = new AtlasStore(path), readCount = 0, revision = 'v1', fail = false;
  const candidate = (): Candidate => ({ session: { ...blankSession('test', 'native'), updated: revision === 'v1' ? 1 : 2 }, revision, locator: {} });
  const adapter: SessionAdapter = { id: 'test', name: 'Test', description: '', capabilities: { history: true, files: false, forks: true, children: true }, async detect() { return true; },
    async discover() { return { sessions: [candidate(), candidate()], projects: [], warnings: [] }; },
    async read() { readCount++; if (fail) throw new Error('Interrupted'); const m = { ...blankMessage('message', 1, 'user'), fragments: [{ kind: 'You' as const, text: revision, time: 1 }] }; return { messages: [m, m] }; },
  };
  try {
    let importer = new Importer(store, [adapter]); importer.start(['test']); await importer.settled();
    assert.equal(importer.status.imported, 1); assert.equal(readCount, 1);
    assert.equal(store.content('test:native').messages, 1);
    importer.start(); await importer.settled(); assert.equal(importer.status.unchanged, 1); assert.equal(readCount, 1);
    revision = 'v2'; fail = true; importer.start(); await importer.settled();
    assert.equal(importer.status.failed, 1); assert.equal(store.content('test:native').fragments[0].text, 'v1'); assert.equal(store.revision('test:native'), 'v1');
    fail = false; importer.start(); await importer.settled(); assert.equal(store.content('test:native').messages, 1); assert.equal(store.content('test:native').fragments[0].text, 'v2');
    store.failed('test:native', 'Interrupted update');
    const beforeRetry = readCount;
    importer.start(); await importer.settled();
    assert.equal(readCount, beforeRetry + 1); assert.equal(importer.status.imported, 1);
    assert.equal(store.getSession('test:native')?.coverage?.history, 'complete');
    assert.equal(store.getSession('test:native')?.coverage?.note, undefined);
    const second = { ...candidate(), session: { ...blankSession('other', 'native'), title: 'Same transcript, different harness' } };
    store.upsert(second); store.replace(second, [], false);
    const fork = { ...candidate(), session: { ...blankSession('test', 'fork'), forkID: 'test:native' } };
    store.upsert(fork); store.replace(fork, [], false);
    assert.equal(store.atlas([], false).sessions.length, 3);
    store.close(); store = new AtlasStore(path); importer = new Importer(store, []);
    assert.equal(store.content('test:native').fragments[0].text, 'v2');
    assert.deepEqual(store.selected(), ['test']);
    assert.equal(store.getSession('test:fork')?.forkID, 'test:native');
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('SQLite index persists checkpoints, rejects stale versions, and clear prevents older tabs resurrecting it', () => {
  const store = new AtlasStore(':memory:');
  try {
    const c = { session: blankSession('test', 'id'), revision: 'r1', locator: {} }; store.upsert(c); store.replace(c, [], false);
    const record: CachedContent = { id: c.session.id, version: contentVersion(store.getSession(c.session.id)!), fragments: [], characters: 0, pages: 1, complete: true, partial: false, capped: false };
    assert.equal(store.saveCheckpoint(record, 0), true); assert.equal(store.checkpoints().records.length, 1);
    store.clearIndex(); assert.equal(store.saveCheckpoint(record, 0), false); assert.equal(store.checkpoints().records.length, 0);
    assert.equal(store.saveCheckpoint(record, 1), true);
    store.replace({ ...c, revision: 'r2' }, [], false); assert.equal(store.saveCheckpoint(record, 1), false);
    assert.equal(store.checkpoints().records.length, 0);
  } finally { store.close(); }
});

test('JSONL byte cursors do not skip or duplicate Unicode records and disclose malformed lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-jsonl-')), path = join(dir, 'history.jsonl');
  try {
    await writeFile(path, Array.from({ length: 500 }, (_, i) => JSON.stringify({ i, text: '星🌌é' })).join('\n') + '\n{broken');
    let cursor: number | undefined, partial = false; const values: number[] = [];
    do { const page = await readJSONL(path, cursor, 5000, 17); values.push(...page.rows.map((r) => r.value.i)); partial ||= page.partial; cursor = page.cursor; } while (cursor !== undefined);
    assert.deepEqual(values, Array.from({ length: 500 }, (_, i) => i)); assert.equal(partial, true);
  } finally { await rm(dir, { recursive: true }); }
});

test('Codex ignores mirrored conversation events and preserves explicit successful file evidence', () => {
  const c = { session: blankSession('codex', 'test'), revision: 'r', locator: {} };
  assert.equal(codexRecord({ type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } }, 1, c), undefined);
  const m = codexRecord({ type: 'response_item', ordinal: 3, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Local only' }] } }, 3, c)!;
  assert.equal(m.fragments[0].text, 'Local only');
  assert.equal(codexRecord({ type: 'event_msg', payload: { type: 'patch_apply_end', success: false, changes: { 'fail.ts': {} } } }, 4, c)!.files.length, 0);
  assert.deepEqual(codexRecord({ type: 'event_msg', payload: { type: 'patch_apply_end', success: true, changes: { 'old.ts': { move_path: 'new.ts' } } } }, 5, c)!.files.map((f) => f.path), ['old.ts', 'new.ts']);
  const item = codexRecord({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'file-event', status: 'completed', changes: { '/work/file.ts': { type: 'add', content: 'text' } } } } }, 6, c)!;
  assert.deepEqual(item.files.map((f) => f.path), ['/work/file.ts']);
});

test('Codex desktop scaffolding is excluded from human prompts and titles without dropping real HTML prompts', () => {
  assert.equal(codexUserText('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'), '');
  assert.equal(codexUserText('<environment_context><cwd>/work</cwd></environment_context>\nFix the app'), 'Fix the app');
  assert.equal(codexUserText('# AGENTS.md instructions for /work\nBuild notes'), '');
  assert.equal(codexUserText('Explain <div>hello</div>'), 'Explain <div>hello</div>');
  const c = { session: blankSession('codex', 'test'), revision: 'r', locator: {} };
  assert.equal(codexRecord({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<external_codex_apps_open_page>{}</external_codex_apps_open_page>' }] } }, 0, c), undefined);
});

test('JSONL skips an oversized record without returning a repeated cursor or losing the next line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-long-jsonl-')), path = join(dir, 'history.jsonl');
  try {
    await writeFile(path, JSON.stringify({ text: 'x'.repeat(2_500_000) }) + '\n' + JSON.stringify({ id: 'after' }) + '\n');
    let cursor: number | undefined, partial = false; const rows: unknown[] = [];
    do { const page = await readJSONL(path, cursor, 100_000, 10); assert.notEqual(page.cursor, cursor === undefined ? 0 : cursor); rows.push(...page.rows.map((r) => r.value)); partial ||= page.partial; cursor = page.cursor; } while (cursor !== undefined);
    assert.equal(partial, true); assert.deepEqual(rows, [{ id: 'after' }]);
  } finally { await rm(dir, { recursive: true }); }
});

test('Claude tool requests only become file evidence on a successful matching result', () => {
  const c = { session: blankSession('claude-code', 'test'), revision: 'r', locator: {} };
  const common = { session_id: 'test', parent_agent_id: null, parent_tool_use_id: null };
  const rows = claudeMessages([
    { ...common, type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/work/test.ts' } }] } },
    { ...common, type: 'user', uuid: 'b', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    { ...common, type: 'user', uuid: 'c', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'failed' }] } },
  ], c);
  assert.equal(rows[0].files.length, 0); assert.equal(rows[1].files[0].path, '/work/test.ts'); assert.equal(rows[2].files.length, 0);
});
