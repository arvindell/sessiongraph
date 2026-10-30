import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blankMessage, blankSession } from '../server/adapters/common';

test('local API prepares saved handoffs and timing; rejects unsupported targets, methods and cross-origin writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'session-atlas-api-'));
  const previous = process.env.SESSION_ATLAS_DATA_DIR;
  process.env.SESSION_ATLAS_DATA_DIR = dir;
  const { library, sessionAtlasMiddleware } = await import('../server/middleware');
  const { store } = library();
  const c = { session: { ...blankSession('opencode', 'ses_fixture', dir), created: 100 }, revision: 'test', locator: {} };
  store.upsert(c); store.replace(c, [{ ...blankMessage('u1', 200, 'user'), fragments: [{ kind: 'You', time: 200, text: 'Continue building the synthetic test.' }] }], false);
  const server = createServer((req, res) => { void sessionAtlasMiddleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/session-atlas/session/${encodeURIComponent(c.session.id)}`;
  const post = (value: unknown, headers = {}) => fetch(`${base}/prepare-launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Atlas-Action': 'prepare-launch', ...headers }, body: JSON.stringify(value) });
  try {
    const response = await post({ target: 'claude-code', directory: dir, command: 'untrusted command must be ignored' });
    assert.equal(response.status, 200);
    const prepared = await response.json();
    assert.equal(prepared.mode, 'handoff'); assert.ok(!prepared.command.includes('untrusted command'));
    assert.match(await readFile(prepared.context.path, 'utf8'), /synthetic test/);
    assert.equal((await post({ target: 'unsupported' })).status, 400);
    assert.equal((await post(null)).status, 400);
    assert.equal((await post({ target: 'codex', directory: false })).status, 400);
    assert.equal((await post({ target: 'codex' }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(`${base}/prepare-launch`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/prepare-launch`)).status, 405);
    const timeline = await (await fetch(`${base}/timeline`)).json();
    assert.deepEqual(timeline.userMessages, [{ id: 'u1', time: 200 }]);
    assert.equal((await fetch(`${base}/content`)).status, 200);
    const events = await (await fetch(`${base}/events`)).json();
    assert.equal(events.total, 1); assert.equal(events.selected.text, 'Continue building the synthetic test.');
    assert.equal((await fetch(`${base}/event-markers`)).status, 200);
    assert.equal((await fetch(`${base}/events?cursor=bad`)).status, 400);
    assert.equal((await fetch(`${base}/events?filter=invalid`)).status, 400);
    assert.equal((await fetch(`${base}/events?item=absent`)).status, 404);
    assert.equal((await fetch(`${base}/events?revision=old`)).status, 409);
    assert.equal((await fetch(`${base}/events`, { method: 'POST', headers: { 'X-Session-Atlas-Action': 'events' } })).status, 405);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    if (previous === undefined) delete process.env.SESSION_ATLAS_DATA_DIR; else process.env.SESSION_ATLAS_DATA_DIR = previous;
    await rm(dir, { recursive: true });
  }
});
