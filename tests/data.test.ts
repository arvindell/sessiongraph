import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMessages, editedPaths, sessionFromResponse, type RawMessage, type RawSession } from '../server/opencode';
import { headPosition, makeGraph, progressX, timeX, trailPosition } from '../src/layout';
import type { Session } from '../src/types';

function session(id: string, created: number, extra: Partial<Session> = {}): Session {
  return { id, created, updated: created, title: id, projectID: 'project', directory: '/repo', model: 'test', provider: 'test', agent: 'build', cost: 0, tokens: 100, archived: false, ...extra };
}

test('OpenCode session reads unwrap the real V2 data envelope before checking its revision', () => {
  const raw: RawSession = { id: 'ses_test', projectID: 'p', location: { directory: '/work' }, time: { created: 1, updated: 2 } };
  assert.equal(sessionFromResponse({ data: raw }, raw.id).time.updated, 2);
  assert.equal(sessionFromResponse(raw, raw.id), raw);
  assert.throws(() => sessionFromResponse({ data: raw }, 'ses_other'));
});

test('graph keeps explicit forks and child links distinct; proximity is not ancestry', () => {
  const sessions = [session('root', 1000), session('nearby', 1001), session('child', 1100, { parentID: 'root' }), session('fork', 1200, { parentID: 'root', forkID: 'root' })];
  const graph = makeGraph(sessions, []);
  assert.deepEqual(graph.edges, [{ from: 'root', to: 'child', kind: 'child' }, { from: 'root', to: 'fork', kind: 'fork' }]);
  assert.equal(graph.nodes.length, 4);
  const child = graph.nodes.find((n) => n.session.id === 'child')!;
  const root = graph.nodes.find((n) => n.session.id === 'root')!;
  assert.ok(child.position[0] > root.position[0]);
  assert.ok(Math.abs(child.position[1] - root.position[1]) >= 9);
});

test('filtering out an ancestor does not invent a parent; repeated layout is deterministic', () => {
  const sessions = [session('child', 1000, { parentID: 'missing' }), session('other', 1500, { directory: '/repo-worktree' })];
  const projects = [{ id: 'project', name: 'project', directory: '/repo', worktrees: ['/repo-worktree'] }];
  const graph = makeGraph(sessions, projects);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.lanes.find((l) => l.label === 'repo-worktree')?.kind, 'worktree');
  assert.deepEqual(makeGraph([...sessions].reverse(), projects), graph);
});

test('equal timestamps and malformed relationship cycles keep finite positions', () => {
  const graph = makeGraph([session('a', 1000, { parentID: 'b' }), session('b', 1000, { parentID: 'a' })], []);
  assert.ok(graph.nodes.every((n) => n.position.every(Number.isFinite)));
  assert.equal(graph.nodes[0].position[0], graph.nodes[1].position[0]);
  assert.equal(makeGraph([], []).nodes.length, 0);
});

test('refresh preserves existing coordinates and directory colors as history and directory counts grow', () => {
  const hour = 3_600_000;
  const sessions = [session('a', 10 * hour), session('b', 11 * hour), session('branch', 12 * hour, { parentID: 'a' }), session('other', 11 * hour, { directory: '/other' })];
  const initial = makeGraph(sessions, []);
  const added = [session('older', hour, { directory: '/new' }), session('newer', 30 * hour, { directory: '/new' }), ...Array.from({ length: 5 }, (_, i) => session(`extra-${i}`, (12 + i) * hour, { directory: '/other' }))];
  const refreshed = makeGraph([...sessions, ...added], [], initial);
  for (const old of initial.nodes) {
    const node = refreshed.nodes.find((n) => n.session.id === old.session.id)!;
    assert.deepEqual(node.position, old.position);
    assert.deepEqual(node.startPosition, old.startPosition);
    assert.equal(node.color, old.color);
  }
  assert.equal(refreshed.start, hour);
  assert.equal(refreshed.end, 30 * hour);
  assert.deepEqual(refreshed.timeFrame, initial.timeFrame);
  assert.ok(progressX(0, refreshed) < -150);
  assert.ok(progressX(1, refreshed) > 150);
  assert.equal(progressX(.5, refreshed), timeX(15.5 * hour, initial));
  const fitted = makeGraph([...sessions, ...added], []);
  assert.equal(progressX(0, fitted), -150);
  assert.equal(progressX(1, fitted), 150);
});

test('refresh extends active endpoints accurately without moving their trails or existing events', () => {
  const hour = 3_600_000;
  const active = session('active', hour, { activity: { firstMessageAt: hour, lastMessageAt: 2 * hour, userMessages: 2, untimedUserMessages: 0 } });
  const initial = makeGraph([active, session('sibling', 3 * hour)], []);
  const updated = { ...active, activity: { ...active.activity!, lastMessageAt: 5 * hour } };
  const refreshed = makeGraph([updated, session('sibling', 3 * hour)], [], initial);
  const before = initial.nodes.find((n) => n.session.id === active.id)!;
  const after = refreshed.nodes.find((n) => n.session.id === active.id)!;
  assert.deepEqual(after.startPosition, before.startPosition);
  assert.deepEqual(after.position.slice(1), before.position.slice(1));
  assert.equal(after.position[0], timeX(5 * hour, initial));
  assert.deepEqual(trailPosition(after, timeX(1.5 * hour, refreshed)), trailPosition(before, timeX(1.5 * hour, initial)));
  assert.equal(progressX(1, refreshed), after.position[0]);
});

test('long sessions travel with time from creation and leave a trail, then rest at their true endpoint', () => {
  const hour = 3_600_000;
  const graph = makeGraph([session('long', hour, { activity: { firstMessageAt: hour, lastMessageAt: 10 * hour, userMessages: 2, untimedUserMessages: 0 } }), session('later', 12 * hour)], []);
  const node = graph.nodes.find(n => n.session.id === 'long')!;
  const endpoint = [...node.position];
  for (const time of [0, hour, 2 * hour, 5 * hour, 9 * hour, 10 * hour, 12 * hour]) {
    const position = headPosition(node, timeX(time, graph));
    assert.equal(position[0], timeX(Math.max(hour, Math.min(time, 10 * hour)), graph));
    assert.deepEqual(position.slice(1), node.startPosition.slice(1));
    assert.deepEqual(trailPosition(node, position[0]), position);
  }
  assert.deepEqual(node.position, endpoint, 'Playback must not rewrite saved message coordinates');
  assert.deepEqual(headPosition(node, timeX(5 * hour, graph)), headPosition(node, progressX(4 / 11, graph)), 'Scrubbing and playback share one time position');
});

test('refresh can discover an ancestor without shifting an existing child and starts cleanly from an empty graph', () => {
  const child = session('child', 3_600_000, { parentID: 'parent' });
  const initial = makeGraph([child], [], makeGraph([], []));
  const refreshed = makeGraph([session('parent', 1), child], [], initial);
  assert.deepEqual(refreshed.nodes.find((n) => n.session.id === child.id)?.position, initial.nodes[0].position);
  assert.deepEqual(refreshed.edges, [{ from: 'parent', to: 'child', kind: 'child' }]);
  assert.ok(refreshed.nodes.every((n) => n.position.every(Number.isFinite)));
});

test('file summaries prefer authoritative snapshots and exclude failed edits or reads', () => {
  const messages: RawMessage[] = [
    { id: '1', type: 'assistant', time: { created: 1 }, snapshot: { start: 'a', end: 'b', files: ['src/real.ts'] }, content: [{ type: 'tool', name: 'patch', state: { status: 'completed', input: { patchText: '*** Update File: src/not-in-snapshot.ts' } } }] },
    { id: '2', type: 'assistant', time: { created: 2 }, content: [{ type: 'tool', name: 'write', state: { status: 'error', input: { filePath: 'failed.ts' } } }, { type: 'tool', name: 'read', state: { status: 'completed', input: { filePath: 'read-only.ts' } } }] },
    { id: '3', type: 'assistant', time: { created: 3 }, content: [{ type: 'tool', name: 'functions.patch', state: { status: 'completed', input: { patchText: '*** Update File: src/real.ts\n*** Add File: src/new.ts' } } }] },
    { id: '4', type: 'assistant', time: { created: 4 }, snapshot: { start: 'b', end: 'c', files: [] }, content: [{ type: 'tool', name: 'write', state: { status: 'completed', input: { filePath: 'no-net-change.ts' } } }] },
  ];
  const result = summarizeMessages('session', messages, 'next-page');
  assert.deepEqual(result.files, [{ path: 'src/real.ts', source: 'snapshot', steps: 2 }, { path: 'src/new.ts', source: 'edit tool', steps: 1 }]);
  assert.equal(result.snapshotSteps, 2);
  assert.equal(result.partial, true);
  assert.equal(result.nextCursor, 'next-page');
  assert.equal(result.messagesScanned, 4);
});

test('rename patches retain both source and destination and location events remain separate', () => {
  assert.deepEqual(editedPaths({ type: 'tool', name: 'apply_patch', state: { status: 'completed', input: { patch: '*** Update File: old.ts\n*** Move to: new.ts' } } }), ['old.ts', 'new.ts']);
  const result = summarizeMessages('session', [{ id: '1', type: 'location-switched', time: { created: 42 }, location: { directory: '/new-worktree' } }], null);
  assert.deepEqual(result.locations, [{ directory: '/new-worktree', time: 42 }]);
  assert.deepEqual(result.files, []);
  assert.equal(result.partial, false);
});
