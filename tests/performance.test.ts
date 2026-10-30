import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenGrid } from '../src/screen-grid';
import { TimelineClient } from '../src/timeline-client';
import type { TimelinePage } from '../src/timeline';

const page = (revision = 'a'): TimelinePage => ({ sessionID: 'session', revision, items: [], total: 0, offset: 0, nextCursor: null, previousCursor: null, related: [], relatedPartial: false, partial: false });

test('screen broad phase retains every possible hit at tile boundaries and viewport edges', () => {
  const grid = new ScreenGrid<number>();
  const points = Array.from({ length: 300 }, (_, i) => ({ x: i * 31 % 1050 - 25, y: i * 67 % 850 - 25, radius: i % 70 + 12 }));
  points.forEach((point, i) => grid.add(i, point.x, point.y, point.radius, 1000, 800));
  for (let x = 0; x <= 1000; x += 16) for (let y = 0; y <= 800; y += 16) {
    const candidates = new Set(grid.at(x, y));
    points.forEach((point, i) => { if (Math.hypot(point.x - x, point.y - y) <= point.radius) assert.ok(candidates.has(i)); });
  }
  grid.clear(); assert.deepEqual(grid.at(20, 20), []);
});

test('event reads share in-flight work, preserve active readers when hover cancels, and isolate revisions and filters', async () => {
  let calls = 0, release!: () => void;
  const request = (async (_url, options) => {
    calls++; await new Promise<void>((resolve) => { release = resolve; });
    assert.equal(options?.signal?.aborted, false);
    return Response.json(page());
  }) as typeof fetch;
  const client = new TimelineClient(request), hover = new AbortController();
  const a = client.read('session', { item: '1', revision: 'a' }, hover.signal);
  const b = client.read('session', { item: '1', revision: 'a' });
  hover.abort(); await assert.rejects(a, { name: 'AbortError' });
  release(); assert.equal((await b).revision, 'a'); assert.equal(calls, 1);
  await client.read('session', { item: '1', revision: 'a', filter: 'all' }); assert.equal(calls, 1);
  const filtered = client.read('session', { item: '1', revision: 'a', filter: 'tools' }); release(); await filtered; assert.equal(calls, 2);
  const newer = client.read('session', { item: '1', revision: 'b' }); release(); await assert.rejects(newer, /history changed/); assert.equal(calls, 3);
});

test('event cache stays bounded, fresh opens revalidate, and invalidation discards late responses', async () => {
  let calls = 0;
  const client = new TimelineClient((async () => { calls++; return Response.json(page()); }) as typeof fetch);
  for (let i = 0; i < 22; i++) await client.read('session', { item: String(i), revision: 'a' });
  await client.read('session', { item: '21', revision: 'a' }); assert.equal(calls, 22);
  await client.read('session', { item: '0', revision: 'a' }); assert.equal(calls, 23);
  await client.read('session'); await client.read('session'); assert.equal(calls, 25);
  client.clear(); await client.read('session', { item: '21', revision: 'a' }); assert.equal(calls, 26);
  let release!: (response: Response) => void;
  const delayed = new TimelineClient((() => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch);
  const stale = delayed.read('session', { revision: 'a' }); delayed.clear(); release(Response.json(page()));
  await assert.rejects(stale, { name: 'AbortError' });
});

test('stale server revisions evict prefetched pages and abandoned requests release their network work', async () => {
  let stale = false, calls = 0;
  const client = new TimelineClient((async () => { calls++; return stale ? Response.json({ error: 'Saved history changed.' }, { status: 409 }) : Response.json(page()); }) as typeof fetch);
  await client.read('session', { item: '1', revision: 'a' });
  stale = true; await assert.rejects(client.read('session', { item: '2', revision: 'a' }), /history changed/);
  stale = false; await client.read('session', { item: '1', revision: 'a' }); assert.equal(calls, 3);
  let signal: AbortSignal | null | undefined;
  const abandoned = new TimelineClient(((_url, options) => { signal = options?.signal; return new Promise(() => {}); }) as typeof fetch);
  const controller = new AbortController(), read = abandoned.read('session', {}, controller.signal);
  controller.abort(); await assert.rejects(read, { name: 'AbortError' }); assert.equal(signal?.aborted, true);
});
