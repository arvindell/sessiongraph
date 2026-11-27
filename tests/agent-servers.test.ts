import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionGraphStore } from '../server/store';
import { blankMessage, blankSession } from '../server/adapters/common';
import { LibraryService } from '../server/library-service';
import { reportingFixture } from './fixtures/reporting';
import { agentQueries } from '../server/agent-queries';

test('agent reporting distinguishes dated evidence, provenance and same-name repositories', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ssg-reports-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  reportingFixture(dir);
  const store = new SessionGraphStore(join(dir, 'library', 'sessiongraph.sqlite'));
  t.after(() => store.close());
  const service = new LibraryService(store, []);
  const call = async (name: string, args: object): Promise<any> => agentQueries.find(q => q.name === name)!.call(service, args);
  const day = { since: '2026-05-13', until: '2026-05-13' };
  for (const [field, count] of Object.entries({ overlap: 7, created: 4, lastActivity: 4, message: 5 })) {
    const args = { ...day, dateField: field, limit: 1 };
    assert.equal((await call('get_stats', args)).totals.sessions, count);
    assert.equal((await call('list_sessions', args)).total, count);
  }
  assert.equal((await call('list_sessions', day)).total, 7);
  const args = { ...day, dateField: 'created', relationship: 'root', origin: 'unknown' };
  const { items: [root], total } = await call('list_sessions', args);
  assert.equal(total, 1); assert.equal(root.title, 'Nightly bot roadmap');
  assert.equal(root.projectLabel, 'lantern'); assert.equal(root.usage, undefined);
  assert.equal(root.created, '2026-05-13T12:00:00.000Z');
  const groups = (await call('get_stats', { ...day, dateField: 'created', groupBy: 'relationship' })).groups.items;
  assert.deepEqual(groups.find((g: any) => g.key === 'root').origins, { human: 0, automated: 1, unknown: 1 });
  assert.ok((await call('get_session', { id: root.id })).coverage);
  const repos = (await call('get_stats', { groupBy: 'repository' })).groups.items;
  assert.deepEqual(repos.map((g: any) => g.sessions).sort(), [2, 6]);
  assert.ok(repos.every((g: any) => g.label === 'lantern'));
  assert.notEqual(repos[0].key, repos[1].key);
  await assert.rejects(call('list_sessions', { since: '2026-02-30' }), /YYYY-MM-DD/);
});

function seed(store: SessionGraphStore, name: string) {
  const candidate = { session: { ...blankSession('codex', name), created: 1234 }, revision: 'one', locator: {} };
  const message = { ...blankMessage('prompt', 1234, 'user'), fragments: [{ kind: 'You' as const, text: 'Investigate moonstone', time: 1234 }] };
  store.upsert(candidate); store.replace(candidate, [message], false);
  return candidate.session.id;
}

test('long-lived search reuses content until a second connection updates the library', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ssg-index-'));
  const path = join(dir, 'test.sqlite'), reader = new SessionGraphStore(path), writer = new SessionGraphStore(path);
  t.after(async () => { reader.close(); writer.close(); await rm(dir, { recursive: true, force: true }); });
  seed(writer, 'one');
  const read = t.mock.method(reader, 'content');
  const service = new LibraryService(reader, []);
  assert.equal(service.searchSessions('moonstone').total, 1);
  const reads = read.mock.callCount();
  assert.ok(reads > 0);
  assert.equal(service.searchSessions('Investigate').total, 1);
  assert.equal(read.mock.callCount(), reads);
  seed(writer, 'two');
  assert.equal(service.searchSessions('moonstone').total, 2);
});

test('installed launcher serves authenticated REST and real MCP clients over the same saved database', { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ssg-agent-api-')), lib = join(dir, 'library'), bin = join(dir, 'bin', 'sessiongraph.mjs');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await copyFile('bin/sessiongraph.mjs', bin);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'sessiongraph', version: '1.2.3', type: 'module' }));
  await build({ entryPoints: ['server/cli.ts'], outfile: join(dir, 'dist-server', 'cli.mjs'), platform: 'node', target: 'node24', bundle: true,
    format: 'esm', banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  const store = new SessionGraphStore(join(lib, 'sessiongraph.sqlite'));
  const id = seed(store, 'alpha/child'); seed(store, 'beta'); store.close();
  const exec = promisify(execFile);
  const env = { ...process.env, SESSIONGRAPH_SERVER_PASSWORD: 'temporary-test-only', SESSIONGRAPH_SERVER_USERNAME: 'tester' };
  await assert.rejects(exec(process.execPath, [bin, 'serve', '--data-dir', lib], { env: { ...env, SESSIONGRAPH_SERVER_PASSWORD: '' } }),
    (error: any) => error.code === 2 && error.stderr.includes('SESSIONGRAPH_SERVER_PASSWORD'));
  const http = spawn(process.execPath, [bin, 'serve', '--port', '0', '--json', '--data-dir', lib], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(http, 'exit'); t.after(() => { if (http.exitCode === null) http.kill(); });
  const lines = createInterface({ input: http.stdout });
  const first = await Promise.race([once(lines, 'line'), exit.then(() => { throw new Error('API exited before listening'); })]);
  const url = JSON.parse(first[0]).data.url;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const headers = { authorization: `Basic ${Buffer.from(`tester:${env.SESSIONGRAPH_SERVER_PASSWORD}`).toString('base64')}` };
  const get = (path: string) => fetch(url + path, { headers });
  assert.equal((await fetch(url + '/api/info')).status, 401);
  assert.equal((await fetch(url + '/openapi.json', { headers: { authorization: 'Basic invalid' } })).status, 401);
  assert.equal((await fetch(url + '/v1/sessions', { headers: { ...headers, origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(url + '/v1/sessions', { headers, method: 'POST' })).status, 405);
  assert.equal((await get('/v1/sessions?limit=500')).status, 400);
  assert.equal((await get('/v1/sessions?data-dir=other')).status, 400);
  assert.equal((await get('/v1/sessions/not-found')).status, 404);
  const hits = (await (await get('/v1/search?query=moonstone&limit=1')).json()).data;
  assert.equal(hits.total, 2); assert.ok(hits.nextCursor);
  const second = (await (await get(`/v1/search?query=moonstone&limit=1&cursor=${hits.nextCursor}`)).json()).data;
  assert.notEqual(second.hits[0].id, hits.hits[0].id);
  const messages = (await (await get(`/v1/sessions/${encodeURIComponent(id)}/messages`)).json()).data;
  assert.equal(messages.messages[0].fragments[0].text, 'Investigate moonstone');
  const info = await exec(process.execPath, [bin, 'api', '/api/info', '--port', new URL(url).port], { env });
  assert.equal(JSON.parse(info.stdout).data.version, '1.2.3');
  const paths = (await (await get('/openapi.json')).json()).paths;
  http.kill('SIGTERM'); await exit;

  const client = new Client({ name: 'fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--data-dir', lib], cwd: dir });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) assert.ok(Object.values(paths).some((p: any) => p.get.operationId === tool.name));
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint));
    const read = await client.callTool({ name: 'list_messages', arguments: { id } });
    assert.deepEqual(read.structuredContent, { data: messages });
    const invalid = await client.callTool({ name: 'list_sessions', arguments: { limit: 1000 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});
