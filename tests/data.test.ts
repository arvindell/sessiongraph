import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMessages, editedPaths, sessionFromResponse, type RawMessage, type RawSession } from '../server/opencode';
import { makeGraph } from '../src/layout';
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
