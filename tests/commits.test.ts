import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionGraphStore } from '../server/store';
import { Importer } from '../server/importer';
import { blankMessage, blankSession } from '../server/adapters/common';
import { eventFor } from '../server/events';
import { opencodeEvents } from '../server/adapters/opencode-events';
import { codexRecord } from '../server/adapters/codex';
import { claudeMessages } from '../server/adapters/claude';
import { LibraryService } from '../server/library-service';
import { runCli } from '../server/cli';
import type { Candidate, ImportedMessage, SessionAdapter } from '../server/adapters/types';

const candidate = (id = 'commits'): Candidate => ({ session: { ...blankSession('opencode', id, '/latest-not-execution-cwd'), created: 100 }, revision: 'r1', locator: {} });
function execution(command = 'git commit -m "Save"', options: { id?: string; time?: number; output?: string; cwd?: string; exit?: number; status?: 'completed' | 'failed' | 'running'; partial?: boolean } = {}) {
  const id = options.id || 'call', time = options.time ?? 200;
  const call = blankMessage(`${id}:request`, time, 'assistant');
  call.events = [eventFor(call, 'call', 'tool_call', 'shell', '', { callID: id, input: JSON.stringify({ command }), cwd: options.cwd ?? '/recorded', status: 'completed' })];
  const result = blankMessage(`${id}:response`, time, 'tool');
  result.events = [eventFor(result, 'result', 'tool_result', 'shell', '', { callID: id, output: options.output ?? '[main abc1234] Save\n 1 file changed, 1 insertion(+)', status: options.status ?? 'completed', exitCode: options.exit ?? 0, partial: options.partial })];
  return [call, result];
}
function saved(messages: ImportedMessage[], c = candidate()) {
  const store = new SessionGraphStore(':memory:'); store.upsert(c); store.replace(c, messages, false); return store;
}

test('commits correlate nonadjacent calls, retain cwd and evidence, deduplicate and read without message or event scans', () => {
  const c = candidate(), [call, result] = execution(), another = execution('git -C /other commit --amend --no-edit', { id: 'amend' });
  const gap = Array.from({ length: 125 }, (_, i) => blankMessage(`gap:${i}`, 150, 'system'));
  const store = saved([call, ...gap, result, ...another, ...execution(undefined, { id: 'mirror' })], c);
  try {
    const first = store.commits(c.session.id, { limit: 1 });
    assert.equal(first.total, 2); assert.ok(first.nextCursor);
    const rest = store.commits(c.session.id, { cursor: first.nextCursor! });
    const items = [...first.items, ...rest.items];
    assert.deepEqual(items.map(item => [item.repositoryPath, item.operation]).sort(), [['/other', 'amended'], ['/recorded', 'created']]);
    assert.ok(items.every(item => item.sha === 'abc1234'));
    for (const item of items) {
      const evidence = store.events(c.session.id, { item: item.evidenceEventID });
      assert.equal(evidence.selected?.kind, 'tool_result'); assert.equal(evidence.related.length, 1);
    }
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => {
      assert.doesNotMatch(sql, /\bmessages\b|SELECT data FROM timeline_items/i);
      return prepare(sql);
    }) as typeof store.db.prepare;
    assert.equal(store.commits(c.session.id).total, 2);
    assert.equal(store.eventMarkers(c.session.id).items.filter(item => item.kind === 'commit').length, 2);
    store.db.prepare = prepare;
    store.replace({ ...c, revision: 'r2' }, [], false);
    assert.throws(() => store.commits(c.session.id, { cursor: first.nextCursor! }), /changed/);
    assert.equal(store.commits(c.session.id).total, 0);
  } finally { store.close(); }
});

test('only confirmed operations count: reject prose, logs, dry runs, shell scripts, ambiguous output, context loss and failures', () => {
  const bad: [string, Parameters<typeof execution>[1]][] = [
    ['git log --oneline', {}], ['echo "git commit"', {}], ['git commit --dry-run', {}],
    ['git commit -m Save; echo done', {}], ['cd /wrong; git commit -m Save', {}],
    ['git commit -m "$(cat message)"', {}], ['git -c alias.commit="!echo fake" commit', {}],
    ['git commit -m Save', { exit: 1, status: 'failed' }], ['git commit -m Save', { status: 'running' }],
    ['git commit -m Save', { partial: true }], ['git commit -m Save', { cwd: '' }],
    ['git commit -m Save', { cwd: 'relative' }], ['git commit -m Save', { output: 'nothing to commit, working tree clean' }],
    ['git commit -m Save', { output: '[main abc1234] one\n[main def5678] two' }],
    ['git push origin main', {}], ['git rev-parse HEAD', {}],
    ['git commit -m Save && git log', {}], ['git commit -m Save | cat', {}],
    ['cd - && git commit -m Save', {}], ['cd /repo* && git commit -m Save', {}],
    ['git -C /repo? commit -m Save', {}], ['git commit -m Save &&', {}],
  ];
  for (const [command, options] of bad) {
    const store = saved(execution(command, options));
    try { assert.equal(store.commits(candidate().session.id).total, 0, command); } finally { store.close(); }
  }
  const speech = blankMessage('speech', 200, 'assistant'); speech.fragments = [{ kind: 'Assistant', time: 200, text: 'Created commit abc1234 using git commit.' }];
  const store = saved([speech]);
  try { assert.equal(store.commits(candidate().session.id).coverage.count, null); } finally { store.close(); }
});

test('commit before failed push, root commits, cherry-picks, quoted paths and SHA256 retain their exact semantics', () => {
  for (const [command, output, path, operation] of [
    ['cd "/repo with spaces" && git add . && git commit -m "hello && goodbye" && git push', '[main (root-commit) abc1234] hello', '/repo with spaces', 'created'],
    ['git -C ../other commit --amend --no-edit', '[detached HEAD abc1234] amend', '/other', 'amended'],
    ['git cherry-pick abcdeff', `[main ${'a'.repeat(64)}] picked`, '/recorded', 'cherry-picked'],
  ]) {
    const store = saved(execution(command, { output, exit: command.endsWith('push') ? 1 : 0, status: command.endsWith('push') ? 'failed' : 'completed' }));
    try { const page = store.commits(candidate().session.id); assert.equal(page.total, 1, command); assert.equal(page.items[0].repositoryPath, path); assert.equal(page.items[0].operation, operation); }
    finally { store.close(); }
  }
});

test('inherited, untimed, ambiguous call IDs and missing results disclose partial or unknown coverage', () => {
  const c = candidate(); c.session.forkID = 'opencode:parent';
  const store = saved([...execution(undefined, { id: 'before', time: 90 }), ...execution(undefined, { id: 'untimed', time: 0 }), ...execution(undefined, { id: 'new', time: 200, output: '[main def5678] New' })], c);
  try { assert.equal(store.commits(c.session.id).total, 1); assert.equal(store.commits(c.session.id).coverage.state, 'partial'); } finally { store.close(); }
  const untimed = saved(execution(undefined, { time: 0 }));
  try { assert.equal(untimed.commits(candidate().session.id).items[0].occurredAt, null); assert.equal(untimed.eventMarkers(candidate().session.id).items.length, 0); } finally { untimed.close(); }
  const [call, result] = execution(), duplicate = structuredClone(call); duplicate.id = 'different-request';
  const ambiguous = saved([call, duplicate, result]);
  try { assert.equal(ambiguous.commits(candidate().session.id).total, 0); assert.equal(ambiguous.commits(candidate().session.id).coverage.state, 'partial'); } finally { ambiguous.close(); }
  const missing = saved([call]);
  try { assert.equal(missing.commits(candidate().session.id).coverage.state, 'partial'); } finally { missing.close(); }
  const reverse = saved([result, call]);
  try { assert.equal(reverse.commits(candidate().session.id).total, 0); } finally { reverse.close(); }
  const conflicting = structuredClone(result); conflicting.id = 'conflicting-result'; conflicting.events![0].output = '[main def5678] Different';
  const conflict = saved([call, result, conflicting]);
  try { assert.equal(conflict.commits(candidate().session.id).total, 0); assert.equal(conflict.commits(candidate().session.id).coverage.state, 'partial'); } finally { conflict.close(); }
});

test('commit replacement rolls back with events, messages, revision and search invalidation', () => {
  const c = candidate(), store = saved(execution(), c);
  try {
    const before = store.commits(c.session.id), events = store.events(c.session.id);
    store.db.prepare('INSERT INTO search_cache VALUES (?,?,?)').run(c.session.id, '{}', 0);
    store.db.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON session_commits BEGIN SELECT RAISE(ABORT,'fail commit'); END;");
    assert.throws(() => store.replace({ ...c, revision: 'r2' }, execution(undefined, { id: 'changed' }), false), /fail commit/);
    assert.deepEqual(store.commits(c.session.id), before); assert.deepEqual(store.events(c.session.id), events);
    assert.equal(store.revision(c.session.id), 'r1'); assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_cache').get()!.n, 1);
    store.failed(c.session.id, 'Unavailable'); assert.deepEqual(store.commits(c.session.id).items, before.items);
    store.clearIndex(); assert.deepEqual(store.commits(c.session.id).items, before.items);
    store.db.prepare('DELETE FROM sessions WHERE id=?').run(c.session.id); assert.equal(store.db.prepare('SELECT count(*) AS n FROM session_commits').get()!.n, 0);
  } finally { store.close(); }
});

test('v4 upgrade is pending, source refresh indexes unchanged revisions, and extractor changes invalidate the index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiongraph-commits-')), path = join(dir, 'library.sqlite'), c = candidate();
  let store = new SessionGraphStore(path);
  try {
    store.upsert(c); store.replace(c, execution(), false);
    store.db.exec('DROP TABLE session_commits; PRAGMA user_version=4;'); store.close(); store = new SessionGraphStore(path);
    assert.equal(store.commits(c.session.id).coverage.state, 'pending'); assert.equal(store.commits(c.session.id).coverage.count, null);
    let reads = 0;
    const adapter: SessionAdapter = { id: 'opencode', name: 'Test', description: '', capabilities: { history: true, forks: true, children: true, files: false }, async detect() { return true; }, async discover() { return { sessions: [structuredClone(c)], projects: [], warnings: [] }; }, async read() { reads++; return { messages: execution().reverse() }; } };
    const importer = new Importer(store, [adapter]); importer.start(['opencode']); await importer.settled();
    assert.equal(reads, 1); assert.equal(store.commits(c.session.id).total, 1);
    importer.start(); await importer.settled(); assert.equal(reads, 1);
    store.db.prepare("UPDATE sessions SET metadata=json_set(metadata,'$.commits.version',0)").run();
    importer.start(); await importer.settled(); assert.equal(reads, 2);
    const page = store.commits(c.session.id); store.close(); store = new SessionGraphStore(path); assert.deepEqual(store.commits(c.session.id), page);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});

test('source normalization preserves OpenCode exit/context, Codex envelopes and Claude native Git results', () => {
  const c = candidate(), msg = blankMessage('native', 200, 'assistant');
  msg.events = opencodeEvents({ type: 'assistant', content: [{ type: 'tool', id: 'shell1', name: 'shell', state: { status: 'completed', input: { command: 'git commit -m Save', workdir: '/native' }, metadata: { exit: 0 }, content: [{ type: 'text', text: '[main abc1234] Save' }] } }] }, msg);
  const store = saved([msg], c);
  try { assert.equal(store.commits(c.session.id).items[0].repositoryPath, '/native'); assert.equal(store.events(c.session.id, { filter: 'tools' }).selected?.exitCode, 0); } finally { store.close(); }
  const codex = candidate('codex'); codex.session.source = 'codex';
  codexRecord({ type: 'session_meta', payload: { cwd: '/start' } }, 0, codex);
  codexRecord({ type: 'turn_context', payload: { cwd: '/turn' } }, 1, codex);
  const call = codexRecord({ type: 'response_item', timestamp: '2026-11-08T10:00:00Z', payload: { type: 'function_call', name: 'exec_command', call_id: 'x', arguments: '{"cmd":"git commit -m Save"}' } }, 2, codex)!;
  const result = codexRecord({ type: 'response_item', timestamp: '2026-11-08T10:00:01Z', payload: { type: 'function_call_output', call_id: 'x', output: 'Chunk ID: x\nWall time: 1 seconds\nProcess exited with code 0\nFinal output:\n[main abc1234] Save' } }, 3, codex)!;
  const codexStore = saved([call, result], codex);
  try { assert.equal(codexStore.commits(codex.session.id).items[0].repositoryPath, '/turn'); } finally { codexStore.close(); }
  const claude = candidate('claude'); claude.session.source = 'claude-code';
  const native = new Map<string, any>([['request', { cwd: '/claude' }], ['result', { cwd: '/claude', tool_use_result: { gitOperation: { commit: { sha: 'b'.repeat(40), kind: 'amended' } } } }]]);
  const messages = claudeMessages([
    { type: 'assistant', uuid: 'request', message: { content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'git commit --amend --no-edit' } }] } },
    { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'Native result' }] } },
  ] as any, claude, new Map([['request', 200], ['result', 210]]), native);
  const claudeStore = saved(messages, claude);
  try { const item = claudeStore.commits(claude.session.id).items[0]; assert.equal(item.sha, 'b'.repeat(40)); assert.equal(item.operation, 'amended'); } finally { claudeStore.close(); }
});

test('CLI exposes indexed commit history and evidence with invalid paging rejected', async () => {
  const c = candidate(), store = saved(execution(), c), service = new LibraryService(store, []);
  let output = '';
  const options = { openLibrary: async () => service, stdout: (text: string) => { output += text; }, stderr: () => {} };
  // CLI owns close; keep the in-memory fixture available for both requests.
  const close = store.close.bind(store); store.close = () => {};
  try {
    assert.equal(await runCli(['commits', c.session.id, '--json'], options), 0);
    assert.equal(JSON.parse(output).data.items[0].sha, 'abc1234');
    output = ''; assert.equal(await runCli(['commits', c.session.id, '--limit', '0', '--json'], options), 2);
  } finally { close(); }
});
