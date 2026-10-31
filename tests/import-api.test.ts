import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('auto-import settings API validates writes and automatic requests cannot choose sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiongraph-import-api-'));
  const previous = process.env.SESSIONGRAPH_DATA_DIR;
  process.env.SESSIONGRAPH_DATA_DIR = directory;
  const { library, sessionGraphMiddleware } = await import('../server/middleware');
  const { store } = library();
  const server = createServer((req, res) => { void sessionGraphMiddleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessiongraph`;
  const post = (path: string, value: unknown, headers = {}) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': path, ...headers }, body: JSON.stringify(value) });
  try {
    assert.equal((await (await fetch(base)).json()).autoImport, true);
    assert.equal((await post('settings', { autoImport: false })).status, 200);
    assert.equal((await (await fetch(base)).json()).autoImport, false);
    for (const value of [null, {}, { autoImport: 'false' }]) assert.equal((await post('settings', value)).status, 400);
    assert.equal((await post('settings', { autoImport: true }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(`${base}/settings`, { method: 'POST', body: '{"autoImport":true}' })).status, 403);
    assert.equal((await post('import', { automatic: true, sources: ['opencode'] })).status, 400);
    assert.equal((await post('import', { automatic: 'true' })).status, 400);
    assert.equal((await post('import', null)).status, 400);
    assert.equal((await (await post('import', { automatic: true })).json()).running, false);
    assert.deepEqual(store.selected(), []);
    assert.equal(store.autoImportEnabled(), false);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.close();
    if (previous === undefined) delete process.env.SESSIONGRAPH_DATA_DIR; else process.env.SESSIONGRAPH_DATA_DIR = previous;
    await rm(directory, { recursive: true });
  }
});
