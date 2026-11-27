import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { DEFAULT_PUBLISHING, publishableGraph } from '@sessiongraph/core/public-graph';
import { blankSession } from '../../../server/adapters/common';
import { publicationPreview } from '../server/publication-preview';
import { handle } from '../server/handler';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('Set TEST_DATABASE_URL to the dedicated local sessiongraph_test database.');
const url = new URL(connectionString);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/sessiongraph_test');
const root = fileURLToPath(new URL('../../../', import.meta.url)), site = resolve(root, 'packages/site');
const output = resolve(root, 'tmp/performance/public');
await mkdir(output, { recursive: true });
const pool = new pg.Pool({ connectionString });
const db = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'sessiongraph' }) });
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=metal'] });
let server: ReturnType<typeof createServer> | undefined;
try {
  await pool.query('DROP SCHEMA IF EXISTS sessiongraph CASCADE');
  const migrations = new URL('../prisma/migrations/', import.meta.url);
  for (const entry of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    await pool.query((await readFile(new URL(`${entry.name}/migration.sql`, migrations), 'utf8')).replaceAll('INDEX ASYNC', 'INDEX'));
  }
  for (let i = 0; i < 18; i++) {
    const accountId = `fixture-${String(i).padStart(2, '0')}`, username = `person-${String(i).padStart(2, '0')}`;
    const updatedAt = new Date('2026-11-27T12:00:00Z');
    const graph = publishableGraph(Array.from({ length: 4000 + i * 50 }, (_, j) => ({
      ...blankSession('codex', `synthetic-${j}`), directory: `/synthetic/group-${j % 16}`, projectID: `group-${j % 16}`,
      created: 1_790_000_000_000 + j * 60_000, tokens: (i + 1) * 1000,
    })), { ...DEFAULT_PUBLISHING, tokens: i !== 17 });
    await db.account.create({ data: { id: accountId, username } });
    await db.publication.create({ data: { accountId, graph: gzipSync(JSON.stringify(graph)), publishedAt: updatedAt, updatedAt } });
    await db.publicationPreview.create({ data: { accountId, updatedAt, ...publicationPreview(graph) } });
  }
  const measurements: Record<string, number[]> = {};
  const handlers: Record<string, typeof handle> = { after: handle };
  if (process.env.PERF_BASELINE) {
    const baseline = process.env.PERF_BASELINE;
    const pkg = JSON.parse(await readFile(resolve(site, 'package.json'), 'utf8'));
    await build({
      absWorkingDir: root, entryPoints: ['packages/site/server/handler.ts'], outfile: 'packages/site/dist-api/baseline.mjs',
      bundle: true, platform: 'node', target: 'node24', format: 'esm',
      external: Object.keys(pkg.dependencies).filter(name => name !== '@sessiongraph/core'),
      plugins: [{
        name: 'baseline-public-api',
        setup(builder) {
          builder.onLoad({ filter: /packages\/site\/server\/.*\.ts$/ }, args => ({
            contents: execFileSync('git', ['show', `${baseline}:${relative(root, args.path)}`], { cwd: root, encoding: 'utf8' }), loader: 'ts',
          }));
        },
      }],
    });
    handlers.before = (await import(new URL('../dist-api/baseline.mjs', import.meta.url).href)).handle;
  }
  for (const [name, run] of Object.entries(handlers)) for (const path of ['/api/graphs', '/api/profiles/person-00/thumbnail.svg']) {
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const response = await run(new Request(`http://localhost${path}`, { headers: { 'x-real-ip': `${name}-benchmark` } }), db);
      assert.equal(response.status, 200); await response.text(); times.push(performance.now() - start);
    }
    measurements[`${name}:${path}`] = times;
    console.log(`${name} ${path}: median ${[...times].sort((a, b) => a - b)[3].toFixed(1)} ms`);
  }
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/explore') {
        const response = await handle(new Request(url, { headers: { 'x-real-ip': 'browser-fixture' } }), db);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
      }
      const path = resolve(site, 'dist', `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
      if (!path.startsWith(resolve(site, 'dist') + '/')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
    } catch { res.writeHead(500).end('Fixture server failed'); }
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const noJS = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
  const staticPage = await noJS.newPage();
  await staticPage.goto(`${origin}/explore`);
  assert.equal(await staticPage.locator('#graph-gallery .graph-card').count(), 12);
  assert.equal(await staticPage.locator('#gallery-loading').isVisible(), false);
  await staticPage.getByRole('searchbox').fill('PERSON-17');
  await staticPage.getByRole('button', { name: 'Search', exact: true }).click();
  await staticPage.waitForURL('**/explore?**');
  assert.equal(await staticPage.locator('#graph-gallery .graph-card').count(), 1);
  assert.match(await staticPage.locator('#graph-gallery').innerText(), /person-17/);
  await noJS.close();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  let releaseOld: (() => void) | undefined;
  await page.route('**/api/graphs?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') === 'person-00') {
      await new Promise<void>(done => { releaseOld = done; });
      await route.fulfill({ json: { graphs: [], nextPage: null } }).catch(() => {});
    } else await route.continue();
  });
  const start = performance.now();
  await page.goto(`${origin}/explore`);
  await page.waitForFunction(() => document.querySelector('#gallery-controls')?.classList.contains('is-enhanced'));
  const populatedMs = performance.now() - start;
  assert.equal(await page.locator('#graph-gallery .graph-card').count(), 12);
  assert.ok(!requests.includes('/api/graphs'), 'server HTML avoids a bootstrap gallery fetch');
  assert.ok(!requests.some(path => /three-|public-viewer-/.test(path)), 'Explore downloads no 3D runtime');
  await page.locator('#gallery-more').click();
  await page.waitForFunction(() => document.querySelectorAll('#graph-gallery .graph-card').length === 18);
  assert.equal(await page.locator('#gallery-more').isVisible(), false);
  await page.getByRole('searchbox').fill('@PERSON-17');
  await page.waitForFunction(() => document.querySelectorAll('#graph-gallery .graph-card').length === 1);
  assert.match(await page.locator('#graph-gallery').innerText(), /person-17/);
  await page.getByRole('searchbox').fill('does-not-exist');
  await page.waitForFunction(() => document.querySelector('#gallery-status')?.textContent?.includes('No public graphs match'));
  await page.getByRole('searchbox').fill('');
  await page.locator('#gallery-sort').selectOption('sessions');
  await page.waitForFunction(() => document.querySelector('#graph-gallery h2')?.textContent?.includes('person-17'));
  await page.locator('#gallery-sort').selectOption('tokens');
  await page.waitForFunction(() => document.querySelector('#graph-gallery h2')?.textContent?.includes('person-16'));
  await page.getByRole('searchbox').fill('person-00');
  await page.waitForRequest(request => new URL(request.url()).searchParams.get('q') === 'person-00');
  await page.getByRole('searchbox').fill('person-17');
  await page.waitForFunction(() => document.querySelectorAll('#graph-gallery .graph-card').length === 1 && document.querySelector('#graph-gallery h2')?.textContent?.includes('person-17'));
  releaseOld!();
  await page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
  assert.match(await page.locator('#graph-gallery').innerText(), /person-17/, 'superseded searches cannot overwrite current results');
  await page.getByRole('searchbox').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#graph-gallery .graph-card').length === 12);
  await page.screenshot({ path: resolve(output, 'explore-after.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'controls fit mobile');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'local.json'), JSON.stringify({ measuredAt: new Date().toISOString(), synthetic: true, publications: 18, sessionsPerPublication: '4000–4850', populatedMs, measurements }, null, 2));
  console.log(`Verified server-rendered HTML, no-JS search, pagination, global search/sorts, cancellation, and mobile layout. Local populated page: ${populatedMs.toFixed(1)} ms.`);
} finally {
  await browser.close();
  if (server) await new Promise<void>(done => { server!.closeAllConnections(); server!.close(() => done()); });
  await db.$disconnect(); await pool.query('DROP SCHEMA IF EXISTS sessiongraph CASCADE'); await pool.end();
}
