import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionAtlasStore } from '../server/store';
import { blankMessage, blankSession } from '../server/adapters/common';
import { connectionPositions, makeGraph, sessionEnd, timeX, trailPosition } from '../src/layout';
import type { ImportedMessage } from '../server/adapters/types';

const user = (id: string, time: number): ImportedMessage => ({ ...blankMessage(id, time, 'user'), fragments: [{ kind: 'You', text: id, time }] });
const candidate = { session: { ...blankSession('test', 'session'), created: 100, updated: 999_999 }, revision: 'r1', locator: {} };

test('activity follows saved message time, excludes tool-result user envelopes, and preserves simultaneous turns', () => {
  const store = new SessionAtlasStore(':memory:');
  try {
    store.upsert(candidate);
    const messages = [user('earlier', 80), user('first', 100), user('same-time', 100), user('unknown', 0), { ...blankMessage('tool-result', 110, 'user'), fragments: [{ kind: 'Tool' as const, text: 'ok', time: 110 }] }, blankMessage('reply', 400, 'assistant')];
    store.replace(candidate, [...messages, messages[1]], false);
    const saved = store.getSession(candidate.session.id)!;
    assert.deepEqual(saved.activity, { firstMessageAt: 80, lastMessageAt: 400, userMessages: 4, untimedUserMessages: 1 });
    assert.equal(sessionEnd(saved), 400);
    const timeline = store.timeline(saved.id);
    assert.equal(timeline.totalUserMessages, 4);
    assert.equal(timeline.earlierUserMessages, 1);
    assert.equal(timeline.untimedUserMessages, 1);
    assert.deepEqual(timeline.userMessages.map((m) => m.id).sort(), ['first', 'same-time']);
    assert.equal(timeline.partial, true);
    store.upsert({ ...candidate, session: { ...candidate.session, updated: 2_000_000 } });
    assert.deepEqual(store.getSession(saved.id)!.activity, saved.activity);
    store.failed(saved.id, 'Source offline');
    assert.equal(store.timeline(saved.id).userMessages.length, 2);
    store.replace({ ...candidate, revision: 'r2' }, [user('replacement', 700)], false);
    assert.equal(store.getSession(saved.id)!.activity!.lastMessageAt, 700);
    assert.deepEqual(store.timeline(saved.id).userMessages, [{ id: 'replacement', time: 700 }]);
  } finally { store.close(); }
});

test('message markers are bounded, chronological and do not collapse identical timestamps', () => {
  const store = new SessionAtlasStore(':memory:');
  try {
    store.upsert(candidate);
    store.replace(candidate, Array.from({ length: 2105 }, (_, i) => user(`m${i}`, 100 + Math.floor(i / 2))), false);
    const timeline = store.timeline(candidate.session.id);
    assert.equal(timeline.userMessages.length, 2000);
    assert.equal(timeline.totalUserMessages, 2105);
    assert.equal(timeline.userMessages[0].id, 'm105');
    assert.equal(timeline.userMessages.at(-1)!.id, 'm2104');
    assert.equal(timeline.partial, true);
  } finally { store.close(); }
});

test('v2 libraries gain activity from saved history without losing checkpoints or rereading sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-migration-')), path = join(dir, 'library.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, native_id TEXT NOT NULL, metadata TEXT NOT NULL, imported_revision TEXT, locator TEXT NOT NULL, UNIQUE(source,native_id));
    CREATE TABLE messages (session_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,id));
    CREATE TABLE search_cache (id TEXT PRIMARY KEY, data TEXT NOT NULL, characters INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=2;`);
  legacy.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(candidate.session.id, 'test', 'session', JSON.stringify(candidate.session), 'r1', '{}');
  legacy.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(candidate.session.id, 'm1', 0, JSON.stringify(user('m1', 800)));
  legacy.prepare('INSERT INTO search_cache VALUES (?,?,?)').run(candidate.session.id, '{"saved":true}', 10);
  legacy.close();
  try {
    const store = new SessionAtlasStore(path);
    try {
      assert.equal(store.getSession(candidate.session.id)!.activity!.lastMessageAt, 800);
      assert.deepEqual(store.timeline(candidate.session.id).userMessages, [{ id: 'm1', time: 800 }]);
      assert.equal(store.db.prepare('SELECT data FROM search_cache').get()!.data, '{"saved":true}');
      assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
    } finally { store.close(); }
    const reopened = new SessionAtlasStore(path);
    try { assert.equal(reopened.getSession(candidate.session.id)!.activity!.userMessages, 1); } finally { reopened.close(); }
  } finally { await rm(dir, { recursive: true }); }
});

test('lifetime trails and explicit branches attach to exact node coordinates at the right times', () => {
  const activity = (lastMessageAt: number) => ({ firstMessageAt: 100, lastMessageAt, userMessages: 1, untimedUserMessages: 0 });
  const root = { ...candidate.session, activity: activity(8_000_000) };
  const child = { ...root, id: 'child', created: 2_000_000, parentID: root.id, activity: activity(4_000_000) };
  const unknown = { ...candidate.session, id: 'unknown' };
  const graph = makeGraph([root, child, unknown], []);
  assert.equal(graph.end, 8_000_000);
  for (const node of graph.nodes) {
    assert.equal(node.startPosition[0], timeX(node.session.created, graph));
    assert.equal(node.position[0], timeX(sessionEnd(node.session), graph));
    assert.deepEqual(trailPosition(node, node.position[0]), node.position);
    assert.deepEqual(node.startPosition.slice(1), node.position.slice(1));
  }
  const rootNode = graph.nodes.find((n) => n.session.id === root.id)!;
  const childNode = graph.nodes.find((n) => n.session.id === child.id)!;
  const [from, to] = connectionPositions(rootNode, childNode);
  assert.equal(from[0], timeX(child.created, graph));
  assert.deepEqual(from.slice(1), rootNode.position.slice(1));
  assert.deepEqual(to, childNode.startPosition);
  assert.equal(sessionEnd(unknown), unknown.created); // updated is not a message timestamp
});
