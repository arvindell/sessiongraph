import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAtlasStore } from '../server/store';
import { EventReadError } from '../server/event-store';
import { blockEvents, boundEventPayloads, eventFor, eventText, messageEvent } from '../server/events';
import { blankMessage, blankSession } from '../server/adapters/common';
import { opencodeEvents } from '../server/adapters/opencode-events';
import { codexRecord } from '../server/adapters/codex';
import { cursorMessage } from '../server/adapters/cursor-message';

const candidate = { session: { ...blankSession('test', 'events'), created: 100 }, revision: 'r1', locator: {} };
const message = (id: string, time: number) => {
  const msg = blankMessage(id, time, 'user'); msg.events = [messageEvent(msg, `Prompt ${id}`)]; return msg;
};

test('events page through source order, retain simultaneous and untimed items, scope correlations and reject stale snapshots', () => {
  const store = new SessionAtlasStore(':memory:');
  try {
    store.upsert(candidate);
    const messages = Array.from({ length: 125 }, (_, i) => message(`m${i}`, i === 5 ? 0 : 100 + Math.floor(i / 2)));
    messages[0].events!.push(eventFor(messages[0], 'call', 'tool_call', 'read', '', { callID: 'call-1', input: '{}' }));
    messages[1].events!.push(eventFor(messages[1], 'result', 'tool_result', 'read', '', { callID: 'call-1', output: 'content' }));
    store.replace(candidate, [...messages, messages[0]], false);
    // A duplicate native message replaces that message, never appends its events.
    const page = store.events(candidate.session.id), ids = new Set(page.items.map((i) => i.id));
    let next = page.nextCursor;
    while (next) { const p = store.events(candidate.session.id, { cursor: next }); for (const item of p.items) { assert.ok(!ids.has(item.id)); ids.add(item.id); } next = p.nextCursor; }
    assert.equal(ids.size, 127); assert.equal(page.items.length, 60); assert.equal(page.partial, false);
    const untimed = store.events(candidate.session.id, { filter: 'untimed' });
    assert.equal(untimed.total, 1); assert.equal(untimed.selected!.time, null); assert.equal(untimed.selected!.timeSource, 'unknown');
    const tools = store.events(candidate.session.id, { filter: 'tools' });
    assert.equal(tools.total, 2); assert.equal(tools.related.length, 1); assert.equal(tools.related[0].kind, 'tool_call');
    const jump = store.events(candidate.session.id, { item: tools.related[0].id }); assert.equal(jump.offset, 120); assert.equal(jump.selected!.callID, 'call-1');
    const other = { ...candidate, session: { ...candidate.session, id: 'other', nativeID: 'other' } }; store.upsert(other); store.replace(other, [messages[0]], false);
    assert.equal(store.events(candidate.session.id, { item: tools.related[0].id }).related.length, 1);
    const markers = store.eventMarkers(candidate.session.id); assert.equal(markers.untimed, 1); assert.equal(markers.items.length, 126);
    assert.throws(() => store.events(candidate.session.id, { cursor: 'garbage' }), (e) => e instanceof EventReadError && e.status === 400);
    assert.throws(() => store.events(candidate.session.id, { filter: '__proto__' }), EventReadError);
    assert.throws(() => store.events(candidate.session.id, { item: 'missing' }), (e) => e instanceof EventReadError && e.status === 404);
    store.replace(candidate, [message('new', 200)], false);
    assert.throws(() => store.events(candidate.session.id, { cursor: page.nextCursor! }), (e) => e instanceof EventReadError && e.status === 409);
    assert.throws(() => store.events(candidate.session.id, { revision: page.revision }), EventReadError);
  } finally { store.close(); }
});

test('message and event replacement rolls back together and leaves the previous snapshot readable', () => {
  const store = new SessionAtlasStore(':memory:');
  try {
    store.upsert(candidate); store.replace(candidate, [message('old', 150)], false);
    const before = store.events(candidate.session.id);
    store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON timeline_items WHEN NEW.name='explode' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    const bad = message('bad', 200); bad.events![0].name = 'explode';
    assert.throws(() => store.replace({ ...candidate, revision: 'r2' }, [bad], false));
    assert.deepEqual(store.events(candidate.session.id), before);
    assert.equal(store.handoff(candidate.session.id).messages[0].id, 'old');
    assert.equal(store.revision(candidate.session.id), 'r1');
  } finally { store.close(); }
});

test('v3 migration reconstructs honest legacy coverage and keeps snapshots and checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-events-')), path = join(dir, 'library.sqlite');
  try {
    const old = new SessionAtlasStore(path); old.upsert(candidate);
    const msg = blankMessage('legacy', 0, 'assistant'); msg.fragments = [{ text: 'Saved reply', time: 0, kind: 'Assistant' }, { text: 'Unpaired tool text', time: 0, kind: 'Tool' }];
    old.replace(candidate, [msg], false); old.db.prepare('INSERT INTO search_cache VALUES (?,?,?)').run(candidate.session.id, '{"keep":true}', 10);
    old.db.exec('DROP TABLE timeline_items; DROP TABLE timeline_coverage; PRAGMA user_version=3;'); old.close();
    const current = new SessionAtlasStore(path);
    const page = current.events(candidate.session.id);
    assert.equal(page.total, 2); assert.equal(page.partial, true); assert.match(page.note!, /older flattened import/);
    assert.equal(page.items[1].kind, 'event'); assert.equal(page.items[1].time, null);
    assert.equal(current.db.prepare('SELECT data FROM search_cache').get()!.data, '{"keep":true}'); current.close();
    const reopened = new SessionAtlasStore(path); assert.equal(reopened.events(candidate.session.id).revision, page.revision); reopened.close();
  } finally { await rm(dir, { recursive: true }); }
});

test('native blocks preserve tool correlation, status, reasoning, unfamiliar events and bounded coverage', () => {
  const msg = blankMessage('assistant', 100, 'assistant');
  const events = blockEvents(msg, [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 't1', name: 'read', input: { path: '/a' } }, { type: 'tool_result', tool_use_id: 't1', content: 'oops', is_error: true }, { type: 'thinking', thinking: 'recorded summary' }, { type: 'new-native-kind', data: 'opaque' }]);
  assert.deepEqual(events.map((e) => e.kind), ['message', 'tool_call', 'tool_result', 'reasoning', 'event']);
  assert.equal(events[1].callID, events[2].callID); assert.equal(events[2].status, 'failed'); assert.equal(events[4].nativeType, 'new-native-kind');
  const long = blockEvents(msg, [{ type: 'text', text: 'x'.repeat(100_000) }]); assert.equal(long[0].partial, true); assert.ok(long[0].text.length <= 64_000);
  msg.events = events; assert.ok(boundEventPayloads(msg, 30) <= 30); assert.equal(msg.partial, true);
  assert.match(eventText({ data: Array.from({ length: 150 }, () => 'v'), api_key: 'hidden' }), /omitted/);
});

test('OpenCode V2 tools retain call/result identities and their own timestamps without flattening system events', () => {
  const msg = blankMessage('opencode', 100, 'assistant');
  const items = opencodeEvents({ type: 'assistant', content: [{ type: 'text', text: 'Reply' }, { type: 'tool', id: 'tool-1', name: 'read', time: { created: 120, completed: 140 }, state: { status: 'error', input: { path: '/a' }, error: { message: 'missing' } } }] }, msg);
  assert.equal(items[1].time, 120); assert.equal(items[1].timeSource, 'recorded'); assert.equal(items[2].time, 140);
  assert.equal(items[1].callID, items[2].callID); assert.notEqual(items[1].id, items[2].id); assert.equal(items[2].status, 'failed');
  assert.equal(opencodeEvents({ type: 'compaction', summary: 'saved summary', status: 'completed' }, msg)[0].kind, 'compaction');
  assert.equal(opencodeEvents({ type: 'model-switched', model: { id: 'test' } }, msg)[0].role, 'system');
});

test('Codex and Cursor keep tool results, lifecycle events, unknown times and native correlations', () => {
  const c = { ...candidate, session: blankSession('codex', 'native') };
  const call = codexRecord({ type: 'response_item', payload: { type: 'function_call', call_id: 't', name: 'read', arguments: '{"path":"a"}' } }, 1, c)!;
  const result = codexRecord({ type: 'response_item', payload: { type: 'function_call_output', call_id: 't', output: 'hello' } }, 2, c)!;
  assert.equal(call.events![0].callID, result.events![0].callID); assert.equal(result.events![0].time, null);
  assert.equal(codexRecord({ type: 'event_msg', payload: { type: 'turn_aborted' } }, 3, c)!.events![0].kind, 'event');
  const cursor = cursorMessage({ role: 'tool', tool_call_id: 't', content: 'result' }, 'cursor')!;
  assert.equal(cursor.events![0].callID, 't'); assert.equal(cursor.events![0].kind, 'tool_result'); assert.equal(cursor.events![0].timeSource, 'unknown');
});

test('marker limits disclose unplotted events and never place unknown or outside-lifetime timestamps', () => {
  const store = new SessionAtlasStore(':memory:');
  try {
    store.upsert(candidate);
    store.replace(candidate, [message('early', 50), message('untimed', 0), ...Array.from({ length: 2010 }, (_, i) => message(`m${i}`, 100 + i))], false);
    const markers = store.eventMarkers(candidate.session.id);
    assert.equal(markers.items.length, 2000); assert.equal(markers.total, 2012); assert.equal(markers.limited, true); assert.equal(markers.outsideLifetime, 1); assert.equal(markers.untimed, 1);
    assert.equal(store.events(candidate.session.id, { filter: 'untimed' }).selected!.messageID, 'untimed');
  } finally { store.close(); }
});
