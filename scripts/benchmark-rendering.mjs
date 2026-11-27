import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { platform, arch, cpus } from 'node:os';
import { build } from 'vite';
import { chromium } from 'playwright';
import { installDemoRoutes } from './demo-fixture.mjs';
import { tsImport } from 'tsx/esm/api';
import { verifySessionList, verifyScene } from './verify-rendering.mjs';

const { publishableGraph, DEFAULT_PUBLISHING } = await tsImport('../packages/core/src/public-graph.ts', import.meta.url);

// Production assets, a fresh browser context per run, and invented API responses.
// configFile:false deliberately excludes the local-history backend.
const verify = process.argv.includes('--verify');
const output = resolve(process.argv.slice(2).find(arg => arg !== '--verify') || 'tmp/performance/result.json');
const runs = Number(process.env.PERF_RUNS || (verify ? 1 : 5));
const perLane = Number(process.env.PERF_PER_LANE || 400);
const outDir = resolve('tmp/performance/app');
await build({
  configFile: false, logLevel: 'warn',
  plugins: [{
    name: 'benchmark-only-scene-access',
    enforce: 'pre',
    transform(code, id) {
      const path = relative(process.cwd(), id);
      if (process.env.PERF_BASELINE && (path.startsWith('src/') || path.startsWith('packages/core/src/'))) {
        code = execFileSync('git', ['show', `${process.env.PERF_BASELINE}:${path}`], { encoding: 'utf8' });
      }
      if (id.endsWith('/packages/core/src/scene.ts')) return code.replace(
        'setGraph(graph: Graph, fit = false, preserve = false) {',
        'setGraph(graph: Graph, fit = false, preserve = false) { globalThis.__benchmarkScene = this;',
      );
      return code;
    },
  }],
  build: { outDir, emptyOutDir: true, rollupOptions: { output: { manualChunks: id => /node_modules.*three/.test(id) ? 'three' : undefined } } },
});
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) { res.writeHead(500).end('API must be mocked'); return; }
  const file = resolve(outDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(outDir + '/')) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const samples = [];
let browserVersion;
try {
  for (let run = 0; run < runs; run++) {
    const browser = await chromium.launch({ channel: 'chromium', headless: true, args: platform() === 'darwin' ? ['--use-angle=metal'] : [] });
    browserVersion = browser.version();
    try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') console.error('Request failed:', request.url(), request.failure()); });
    const fixture = await installDemoRoutes(page, { perLane, now: Date.UTC(2026, 10, 27), autoImport: false, preferences: { motion: 'off', muted: true } });
    await page.route('**/api/sessiongraph/publishing/**', async route => {
      const action = new URL(route.request().url()).pathname.split('/').at(-1);
      const body = action === 'settings' ? DEFAULT_PUBLISHING : action === 'status' ? { username: null, publication: null }
        : action === 'preview' ? { id: 'synthetic-preview', graph: publishableGraph(fixture.sessions, route.request().postDataJSON().settings) } : {};
      await route.fulfill({ json: body });
    });
    await page.addInitScript(() => {
      window.__listReady = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.session-card')) { observer.disconnect(); resolve(performance.now()); }
        });
        observer.observe(document, { childList: true, subtree: true });
      });
    });
    await page.goto(origin);
    try { await page.waitForFunction(() => window.__benchmarkScene?.graph.nodes.length > 0); }
    catch (error) { console.error(errors, await page.evaluate(() => document.body.innerText)); throw error; }
    await page.evaluate(() => document.fonts.ready);
    const initialListMs = await page.evaluate(() => window.__listReady);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    // Reach the oldest session. The baseline's "Show more" path rebuilds every
    // preceding card; a virtual list can jump to the same record directly.
    const deepList = await page.evaluate(async () => {
      const list = document.querySelector('#session-list');
      const start = performance.now();
      while (document.querySelector('#more-sessions')) document.querySelector('#more-sessions').click();
      list.scrollTop = list.scrollHeight;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const cards = list.querySelectorAll('.session-card');
      return { ms: performance.now() - start, cards: cards.length, last: cards[cards.length - 1]?.dataset.session };
    });
    const oldest = fixture.sessions.toSorted((a, b) => b.activity.lastMessageAt - a.activity.lastMessageAt)[fixture.sessions.length - 1].id;
    assert.equal(deepList.last, oldest, 'oldest session is reachable');
    // Tiny scrolls are intentional: virtualization should reuse the existing
    // visible rows until a boundary is crossed.
    await page.click('#search');
    await page.waitForSelector('.search-result');
    await page.click('#search-conversations');
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
    const beforeSearch = await metrics();
    const search = await page.evaluate(async () => {
      const list = document.querySelector('#search-results'), inner = list.firstElementChild;
      let added = 0;
      const observer = new MutationObserver(records => { for (const record of records) added += record.addedNodes.length; });
      observer.observe(inner, { childList: true });
      const frames = [];
      let last = performance.now();
      for (let i = 1; i <= 60; i++) {
        list.scrollTop = i * 2;
        await new Promise(requestAnimationFrame);
        const now = performance.now(); frames.push(now - last); last = now;
      }
      await new Promise(requestAnimationFrame);
      observer.disconnect();
      return { added, rows: inner.children.length, frames };
    });
    const afterSearch = await metrics();
    await page.click('.search-close');
    // Isolate scene CPU work from GPU submission and DOM list work.
    const scene = await page.evaluate(() => {
      const scene = window.__benchmarkScene;
      cancelAnimationFrame(scene.frame);
      // Avoid queuing GPU work in a CPU microbenchmark. Full rendering, shaders,
      // and layout have already run through the real app above.
      scene.renderer.getContext().finish();
      scene.composer.render = () => {};
      const measure = (action, count) => {
        const values = [];
        for (let i = 0; i < count + 3; i++) { const start = performance.now(); action(i); if (i >= 3) values.push(performance.now() - start); }
        return values;
      };
      const setup = measure(() => scene.setGraph(scene.graph), 5);
      const fit = measure(() => document.querySelector('#reset-camera').click(), 5);
      scene.renderFrame(0);
      const nodes = measure(i => { scene.cutoff = (i % 100) / 100; scene.revealsActive = true; scene.animateNodes(); }, 100);
      scene.setCutoff(1); scene.renderFrame(0);
      const picking = measure(() => { scene.pickingDirty = true; scene.updatePicking(); }, 50);
      // Hover changes focus uniforms; it should not recompute every node matrix.
      const original = scene.animateNodes.bind(scene);
      let nodeUpdates = 0;
      scene.animateNodes = () => { if (scene.revealsActive) nodeUpdates++; original(); };
      const hover = measure(() => { scene.dirty = true; scene.renderFrame(0); }, 20);
      scene.animateNodes = original;
      const context = scene.renderer.getContext();
      const ext = context.getExtension('WEBGL_debug_renderer_info');
      return { setup, fit, nodes, picking, hover, nodeUpdates, gpu: ext ? context.getParameter(ext.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER) };
    });
    if (verify) { await verifySessionList(page, fixture.sessions); await verifyScene(page); }
    const previewStart = performance.now();
    await page.click('#open-publishing');
    await page.waitForFunction(() => document.querySelector('.publishing-dialog [data-json]')?.disabled === false);
    const previewOpenMs = performance.now() - previewStart;
    const previewChangesMs = [];
    const previewCanvas = await page.locator('.publishing-preview canvas').elementHandle();
    await page.click('.publishing-settings summary');
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await page.click('[data-field="model"]');
      await page.waitForFunction(() => document.querySelector('.publishing-dialog [data-json]')?.disabled === false);
      previewChangesMs.push(performance.now() - start);
      if (verify) assert.ok(await page.evaluate(canvas => canvas === document.querySelector('.publishing-preview canvas'), previewCanvas), 'preview refresh reuses its WebGL context');
    }
    await page.click('.publishing-dialog [aria-label="Close sharing"]');
    if (verify) await page.waitForSelector('.publishing-preview canvas', { state: 'detached' });
    assert.deepEqual(errors, []);
    const sample = { initialListMs, deepList, previewOpenMs, previewChangesMs, search: { ...search, taskMs: (afterSearch.TaskDuration - beforeSearch.TaskDuration) * 1000, layoutMs: (afterSearch.LayoutDuration - beforeSearch.LayoutDuration) * 1000 }, scene };
    samples.push(sample);
    console.log(`Run ${run + 1}/${runs}: first list ${initialListMs.toFixed(1)} ms; oldest ${deepList.ms.toFixed(1)} ms / ${deepList.cards} cards; search ${sample.search.taskMs.toFixed(1)} ms / ${search.added} added rows`);
    await context.close();
    } finally { await browser.close(); }
  }
} finally { await new Promise(done => server.close(done)); }
const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] };
};
const summary = {
  initialListMs: stats(samples.map(s => s.initialListMs)),
  oldestSessionMs: stats(samples.map(s => s.deepList.ms)),
  mountedSessionCards: stats(samples.map(s => s.deepList.cards)),
  searchScrollTaskMs: stats(samples.map(s => s.search.taskMs)),
  searchScrollLayoutMs: stats(samples.map(s => s.search.layoutMs)),
  searchAddedRows: stats(samples.map(s => s.search.added)),
  previewOpenMs: stats(samples.map(s => s.previewOpenMs)),
  previewChangesMs: stats(samples.flatMap(s => s.previewChangesMs)),
  nodeUpdatesOnHover: stats(samples.map(s => s.scene.nodeUpdates)),
  ...Object.fromEntries(['setup', 'fit', 'nodes', 'picking', 'hover'].map(key => [`scene${key[0].toUpperCase()}${key.slice(1)}Ms`, stats(samples.flatMap(s => s.scene[key]))])),
};
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify({
  source: process.env.PERF_BASELINE ? 'git' : 'working-tree',
  revision: execFileSync('git', ['rev-parse', process.env.PERF_BASELINE || 'HEAD'], { encoding: 'utf8' }).trim(),
  environment: { node: process.version, browser: browserVersion, platform: platform(), arch: arch(), cpu: cpus()[0].model, gpu: samples[0].scene.gpu, viewport: [1440, 1000], perLane, sessions: perLane * 6, runs, motion: 'off', quality: 'balanced' },
  summary, samples,
}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
console.log(`Saved ${output}`);
