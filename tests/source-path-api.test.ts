import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionGraphStore } from '../server/store';

test('per-harness location API persists isolated overrides without selecting, importing, or erasing history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiongraph-source-path-api-'));
  const before = { data: process.env.SESSIONGRAPH_DATA_DIR, codex: process.env.CODEX_HOME };
  process.env.SESSIONGRAPH_DATA_DIR = join(directory, 'library');
  process.env.CODEX_HOME = join(directory, 'missing-default');
  const { library, sessionGraphMiddleware } = await import('../server/middleware');
  const { store, importer } = library();
  // Never discover histories on the machine running this synthetic fixture.
  for (const adapter of importer.adapters) if (!['codex', 'claude-code'].includes(adapter.id)) adapter.detect = async () => false;
  const server = createServer((req, res) => { void sessionGraphMiddleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessiongraph`;
  const post = (value: unknown, headers = {}) => fetch(`${base}/sources/path`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'source-path', ...headers }, body: JSON.stringify(value) });
  const home = join(directory, 'Codex Home & Archive'), otherHome = join(directory, 'missing-claude-home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const transcript = [
    { type: 'session_meta', timestamp: '2026-11-01T10:00:00Z', payload: { id: 'native-fixture', cwd: directory } },
    { type: 'response_item', timestamp: '2026-11-01T10:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic custom history request' }] } },
  ].map(row => JSON.stringify(row)).join('\n');
  const file = join(home, 'sessions', 'fixture.jsonl'); await writeFile(file, transcript);
  try {
    for (const invalid of [null, [], {}, { source: 'codex' }, { source: 'codex', path: 1 }, { source: 'unknown', path: home }, { source: 'codex', path: '' }, { source: 'codex', path: ' ' }, { source: 'codex', path: 'relative/path' }, { source: 'codex', path: '/bad\0path' }]) assert.equal((await post(invalid)).status, 400, JSON.stringify(invalid));
    assert.equal(store.setting('sourcePaths'), undefined);
    assert.equal((await post({ source: 'codex', path: home }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(`${base}/sources/path`, { method: 'POST', body: JSON.stringify({ source: 'codex', path: home }) })).status, 403);
    assert.equal((await fetch(`${base}/sources/path`)).status, 405);
    const saved = await (await post({ source: 'codex', path: home })).json();
    assert.equal(saved.saved, true); assert.equal(saved.source.path, home);
    assert.equal(saved.source.pathSupported, true); assert.match(saved.source.pathHint, /sessions/);
    assert.equal(saved.source.available, true); assert.equal(saved.source.selected, false);
    assert.equal(store.setting('selected'), undefined, 'location edits must not end onboarding');
    assert.equal(store.library([], false).sessions.length, 0, 'saving a path must not import history');
    const unavailable = await (await post({ source: 'claude-code', path: otherHome })).json();
    assert.equal(unavailable.saved, true); assert.equal(unavailable.source.available, false);
    assert.deepEqual(store.setting('sourcePaths'), { codex: home, 'claude-code': otherHome });
    const detected = await (await fetch(`${base}/sources`)).json();
    assert.equal(detected.onboarding, true);
    assert.equal(detected.sources.find((s: { id: string }) => s.id === 'codex').path, home);
    const imported = await fetch(`${base}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'import' }, body: JSON.stringify({ sources: ['codex'] }) });
    assert.equal(imported.status, 202); await importer.settled();
    assert.equal(importer.status.imported, 1); assert.equal(importer.status.failed, 0);
    assert.equal(store.content('codex:native-fixture').messages, 1);
    assert.equal(await readFile(file, 'utf8'), transcript);
    importer.status.running = true;
    assert.equal((await post({ source: 'codex', path: null })).status, 409);
    importer.status.running = false;
    const reopened = new SessionGraphStore(store.path);
    try {
      assert.equal(reopened.setting<Record<string, string>>('sourcePaths')?.codex, home);
      assert.equal(reopened.acquireImport(), true);
      const locked = await post({ source: 'codex', path: null });
      assert.equal(locked.status, 409); assert.equal((await locked.json()).code, 'IMPORT_BUSY');
      reopened.releaseImport();
    } finally { reopened.close(); }
    store.setting('autoImport', true);
    const automatic = await (await post({ source: 'codex', path: null })).json();
    assert.equal(automatic.source.path, null); assert.equal(automatic.source.available, false);
    assert.deepEqual(store.setting('sourcePaths'), { 'claude-code': otherHome });
    assert.deepEqual(store.selected(), ['codex']); assert.equal(store.autoImportEnabled(), true);
    assert.equal(store.content('codex:native-fixture').messages, 1, 'resetting a path must retain saved history');
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    if (before.data === undefined) delete process.env.SESSIONGRAPH_DATA_DIR; else process.env.SESSIONGRAPH_DATA_DIR = before.data;
    if (before.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before.codex;
    await rm(directory, { recursive: true, force: true });
  }
});
