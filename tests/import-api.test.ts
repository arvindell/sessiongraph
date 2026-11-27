import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionGraphStore } from '../server/store';
import { blankMessage, blankSession } from '../server/adapters/common';
import { eventFor } from '../server/events';

test('auto-import settings API validates writes and automatic requests cannot choose sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiongraph-import-api-'));
  const previous = process.env.SESSIONGRAPH_DATA_DIR;
  process.env.SESSIONGRAPH_DATA_DIR = directory;
  const { library, sessionGraphMiddleware } = await import('../server/middleware');
  const { store, importer } = library();
  let sourceProbes = 0;
  for (const adapter of importer.adapters) adapter.detect = async () => { sourceProbes++; return true; };
  const server = createServer((req, res) => { void sessionGraphMiddleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/sessiongraph`;
  const post = (path: string, value: unknown, headers = {}) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': path, ...headers }, body: JSON.stringify(value) });
  try {
    const startup = await (await fetch(base)).json();
    assert.equal(startup.autoImport, false);
    assert.equal(startup.onboarding, true);
    assert.equal(startup.sessions.length, 0);
    assert.ok(startup.sources.every((source: { available: boolean }) => !source.available));
    assert.equal(sourceProbes, 0, 'Boot must not detect local sources');
    assert.equal((await post('settings', { autoImport: true })).status, 200);
    assert.equal((await (await fetch(base)).json()).autoImport, true);
    assert.equal((await post('settings', { autoImport: false })).status, 200);
    assert.equal((await (await fetch(base)).json()).autoImport, false);
    for (const value of [null, {}, { autoImport: 'false' }]) assert.equal((await post('settings', value)).status, 400);
    assert.equal((await post('settings', { autoImport: true }, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await fetch(`${base}/settings`, { method: 'POST', body: '{"autoImport":true}' })).status, 403);
    assert.equal((await post('import', { automatic: true, sources: ['opencode'] })).status, 400);
    assert.equal((await post('import', { automatic: 'true' })).status, 400);
    assert.equal((await post('import', null)).status, 400);
    const malformed = await fetch(`${base}/settings`, { method: 'POST', headers: { 'X-SessionGraph-Action': 'settings' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { code: 'INVALID_ARGUMENT', error: 'Invalid request JSON.' });
    importer.status.running = true;
    const running = await post('import', {});
    importer.status.running = false;
    assert.equal(running.status, 409);
    assert.equal((await running.json()).code, 'IMPORT_RUNNING');
    const other = new SessionGraphStore(store.path);
    try {
      assert.equal(other.acquireImport(), true);
      const busy = await post('import', {});
      assert.equal(busy.status, 409);
      assert.equal((await busy.json()).code, 'IMPORT_BUSY');
    } finally { other.releaseImport(); other.close(); }
    assert.equal((await (await post('import', { automatic: true })).json()).running, false);
    assert.equal(sourceProbes, 0, 'Automatic import must not detect sources during onboarding');
    const detected = await (await fetch(`${base}/sources`)).json();
    assert.equal(detected.onboarding, true);
    assert.ok(detected.sources.every((source: { available: boolean }) => source.available));
    assert.equal(sourceProbes, importer.adapters.length);
    assert.deepEqual(store.selected(), []);
    assert.equal(store.autoImportEnabled(), false);
    assert.equal((await post('settings', { preferences: { view: '2d', muted: true, panelOpacity: 75 }, viewState: { days: 30, includeChildren: false, includeArchived: false, sourceID: 'codex', projectID: 'project', directory: '/work/project', fromDate: '2026-10-01', toDate: '2026-10-20' } })).status, 200);
    for (const value of [{ preferences: [] }, { viewState: null }, { autoImport: true, viewState: false }]) assert.equal((await post('settings', value)).status, 400);
    const candidate = { session: { ...blankSession('t3-code', 'commits'), created: 100 }, revision: 'r1', locator: {} };
    const messages = ['abc1234', 'def5678'].map((sha, index) => {
      const message = blankMessage(`command:${index}`, 200 + index, 'tool');
      message.events = [eventFor(message, 'execution', 'tool_result', 'command execution', '', { nativeType: 'command_execution', input: 'git -C /recorded commit -m Save', output: `[main ${sha}] Save`, exitCode: 0, status: 'completed' })];
      return message;
    });
    store.upsert(candidate); store.replace(candidate, messages, false);
    const route = `${base}/session/${encodeURIComponent(candidate.session.id)}/commits`;
    const commits = await (await fetch(`${route}?limit=1`)).json();
    assert.equal(commits.total, 2); assert.equal(commits.items.length, 1); assert.ok(commits.nextCursor);
    const evidence = await (await fetch(`${base}/session/${encodeURIComponent(candidate.session.id)}/events?filter=tools&item=${commits.items[0].evidenceEventID}`)).json();
    assert.equal(evidence.selected.exitCode, 0);
    assert.equal((await fetch(`${route}?limit=0`)).status, 400);
    assert.equal((await fetch(`${route}?cursor=invalid`)).status, 400);
    assert.equal((await fetch(`${route}?limit=1`, { method: 'POST', headers: { 'X-SessionGraph-Action': 'commits' } })).status, 405);
    store.replace(candidate, messages.slice(0, 1), false);
    assert.equal((await fetch(`${route}?cursor=${commits.nextCursor}`)).status, 409);
    const reopened = new SessionGraphStore(store.path);
    try {
      const saved = reopened.library([], false);
      assert.equal(saved.autoImport, false);
      assert.equal('view' in saved.preferences!, false); assert.equal(saved.preferences?.muted, true); assert.equal(saved.preferences?.panelOpacity, 75);
      assert.deepEqual(saved.viewState, { days: 30, includeChildren: false, includeArchived: false, sourceID: 'codex', projectID: 'project', directory: '/work/project', fromDate: '2026-10-01', toDate: '2026-10-20' });
    } finally { reopened.close(); }
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.close();
    if (previous === undefined) delete process.env.SESSIONGRAPH_DATA_DIR; else process.env.SESSIONGRAPH_DATA_DIR = previous;
    await rm(directory, { recursive: true });
  }
});
