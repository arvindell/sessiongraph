import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { platform, cpus } from 'node:os';
import { build } from 'vite';
import { chromium } from 'playwright';
import { installDemoRoutes } from './demo-fixture.mjs';

const verify = process.argv.includes('--verify');
const output = resolve(process.argv.slice(2).find(arg => arg !== '--verify') || 'tmp/performance/navigation.json');
const runs = Number(process.env.PERF_RUNS || (verify ? 1 : 3)), frames = Number(process.env.PERF_FRAMES || 120);
const perLane = Number(process.env.PERF_PER_LANE || 400), outDir = resolve('tmp/performance/navigation-app');
const quality = process.env.PERF_QUALITY || 'balanced', view = process.env.PERF_VIEW || '3d', motion = process.env.PERF_MOTION || 'off';
const gestures = view === '2d' ? ['pan', 'zoom'] : ['orbit', 'pan', 'zoom'];
const forceZoomRedraw = Boolean(process.env.PERF_SCENE);
await build({
  configFile: false, logLevel: 'warn',
  plugins: [{
    name: 'navigation-benchmark-access', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/packages/core/src/scene.ts')) return;
      if (process.env.PERF_SCENE) code = execFileSync('git', ['show', `${process.env.PERF_SCENE}:packages/core/src/scene.ts`], { encoding: 'utf8' });
      if (verify) code = `import { verifyNavigation } from '/scripts/verify-navigation.mjs'; globalThis.__verifyNavigation = verifyNavigation;\n${code}`;
      return code.replace('setGraph(graph: Graph, fit = false, preserve = false) {', 'setGraph(graph: Graph, fit = false, preserve = false) { globalThis.__benchmarkScene = this;');
    },
  }],
  build: { outDir, emptyOutDir: true, rollupOptions: { output: { manualChunks: id => /node_modules.*three/.test(id) ? 'three' : undefined } } },
});
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(outDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(outDir + '/') || pathname.startsWith('/api/')) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const samples = [], variants = process.env.PERF_VARIANTS?.split(',') || (process.env.PERF_BREAKDOWN ? ['all', 'full-effects', 'no-bloom', 'no-smaa', 'no-postprocessing'] : ['all']);
let browserVersion, gpu;
try {
  for (let run = 0; run < runs; run++) {
    const browser = await chromium.launch({ channel: 'chromium', headless: true, args: platform() === 'darwin' ? ['--use-angle=metal'] : [] });
    browserVersion = browser.version();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await installDemoRoutes(page, { perLane, now: Date.UTC(2026, 10, 27), autoImport: false, preferences: { motion, quality, view, muted: true } });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => window.__benchmarkScene?.graph.nodes.length > 0);
      if (verify) {
        const checks = await page.evaluate(() => {
          const scene = window.__benchmarkScene; cancelAnimationFrame(scene.frame);
          return window.__verifyNavigation(scene);
        });
        console.log(`Verified navigation: ${JSON.stringify(checks)}`);
      }
      const wheel = await page.evaluate(() => {
        const scene = window.__benchmarkScene;
        cancelAnimationFrame(scene.frame);
        scene.controls.enableDamping = false; scene.reset(); scene.renderFrame(1);
        const before = scene.camera.position.clone(), render = scene.composer.render;
        let draws = 0;
        scene.composer.render = function (...args) { draws++; return render.apply(this, args); };
        scene.renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -45, bubbles: true, cancelable: true }));
        scene.renderFrame(1 / 60);
        scene.composer.render = render;
        const wheel = { cameraMoved: before.distanceTo(scene.camera.position) > 0, draws };
        scene.reset(); scene.dirty = true; scene.renderFrame(1);
        window.__navigationStart = { position: scene.camera.position.toArray(), target: scene.controls.target.toArray() };
        scene.renderer.domElement.addEventListener('pointerdown', event => { window.__navigationPointer = event.pointerId; });
        scene.composer.render = function (...args) {
          const bloom = scene.bloom.enabled, smaa = scene.smaa.enabled;
          // Diagnostic variants explicitly control effects, independent of
          // balanced mode's adaptive navigation. "all" measures the real policy.
          if (window.__navigationVariant !== 'all') {
            scene.bloom.enabled = scene.preferences.quality !== 'performance' && scene.preferences.bloom > 0 && !['no-postprocessing', 'no-bloom'].includes(window.__navigationVariant);
            scene.smaa.enabled = scene.preferences.quality !== 'performance' && !['no-postprocessing', 'no-smaa'].includes(window.__navigationVariant);
          }
          try { return render.apply(this, args); }
          finally { scene.bloom.enabled = bloom; scene.smaa.enabled = smaa; }
        };
        return wheel;
      });
      console.log(`Wheel redraw probe: ${JSON.stringify(wheel)}`);
      assert.ok(wheel.cameraMoved, 'wheel input moves the camera');
      if (!forceZoomRedraw) assert.equal(wheel.draws, 1, 'wheel movement draws without benchmark invalidation');
      for (const variant of variants) for (const gesture of gestures) {
        await page.evaluate(({ variant }) => {
          const scene = window.__benchmarkScene, start = window.__navigationStart;
          window.__navigationVariant = variant;
          scene.camera.position.fromArray(start.position); scene.controls.target.fromArray(start.target);
          scene.controls.enableDamping = false; scene.controls.update(); scene.controls.enableDamping = true;
          scene.nodeMesh.visible = variant !== 'no-nodes';
          scene.comets.group.visible = variant !== 'no-trails'; scene.links.group.visible = variant !== 'no-trails';
          const samples = variant === 'no-msaa' || scene.preferences.quality === 'performance' ? 0 : Math.min(scene.preferences.quality === 'high' ? 4 : 2, scene.renderer.capabilities.maxSamples);
          if (scene.scenePass) scene.scenePass.setSamples(samples);
          for (const target of [scene.composer.renderTarget1, scene.composer.renderTarget2]) {
            target.samples = scene.scenePass ? 0 : samples;
            target.depthBuffer = !scene.scenePass || samples === 0; target.dispose();
          }
          scene.dirty = true; scene.renderFrame(1);
        }, { variant });
        await page.mouse.move(950, 350);
        if (gesture !== 'zoom') await page.mouse.down({ button: gesture === 'pan' ? 'right' : 'left' });
        const result = await page.evaluate(async ({ gesture, frames, forceZoomRedraw }) => {
          const scene = window.__benchmarkScene, canvas = scene.renderer.domElement, gl = scene.renderer.getContext();
          const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          const pending = [], gpuMs = [], cpuMs = [], frameMs = [], triangles = [];
          let last = 0, disjoint = false;
          const collect = () => {
            if (!timer) return;
            if (gl.getParameter(timer.GPU_DISJOINT_EXT)) disjoint = true;
            while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
              const query = pending.shift();
              gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(query);
            }
          };
          scene.renderer.info.autoReset = false;
          // Warm the exact gesture/shaders, then measure real controls + CPU
          // preparation + all render passes. GPU timer queries never block frames.
          for (let i = -30; i < frames; i++) {
            const now = await new Promise(requestAnimationFrame);
            if (i > 0) frameMs.push(now - last);
            last = now; collect();
            const query = i >= 0 && timer ? gl.createQuery() : undefined;
            if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
            const start = performance.now(), phase = (i + 30) / 30;
            if (gesture === 'zoom') canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -45 * Math.cos(phase), clientX: 950, clientY: 350, bubbles: true, cancelable: true }));
            else canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: window.__navigationPointer, pointerType: 'mouse', isPrimary: true, buttons: gesture === 'pan' ? 2 : 1, clientX: 950 + Math.sin(phase) * 130, clientY: 350 + Math.cos(phase) * 60, bubbles: true }));
            // OrbitControls applies wheel zoom immediately inside the handler.
            // The old renderer misses that change, so force the same redraw in
            // the baseline when comparing the cost of rendering a zoom frame.
            if (gesture === 'zoom' && forceZoomRedraw) { scene.dirty = true; scene.revealsActive = true; }
            scene.renderer.info.reset(); scene.renderFrame(1 / 60);
            if (i >= 0) { cpuMs.push(performance.now() - start); triangles.push(scene.renderer.info.render.triangles); }
            if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); pending.push(query); }
          }
          for (let i = 0; pending.length && i < 120; i++) { await new Promise(requestAnimationFrame); collect(); }
          for (const query of pending) gl.deleteQuery(query);
          scene.renderer.info.autoReset = true;
          return { gpu, gpuMs: disjoint ? [] : gpuMs, timerSupported: Boolean(timer), disjoint, cpuMs, frameMs, triangles };
        }, { gesture, frames, forceZoomRedraw });
        if (gesture !== 'zoom') await page.mouse.up({ button: gesture === 'pan' ? 'right' : 'left' });
        gpu = result.gpu; samples.push({ run, variant, gesture, wheel, ...result });
        assert.equal(result.disjoint, false, 'discard disjoint GPU measurements');
        assert.ok(result.triangles.every(count => count > 0), 'every measured navigation frame actually renders');
        if (result.timerSupported) assert.equal(result.gpuMs.length, frames);
        console.log(`Run ${run + 1}: ${variant} ${gesture}: GPU ${median(result.gpuMs).toFixed(2)} ms, CPU ${median(result.cpuMs).toFixed(2)} ms, ${median(result.triangles).toLocaleString()} triangles`);
      }
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
} finally { await new Promise(done => server.close(done)); }
function median(values) { return values.length ? values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] : 0; }
function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: median(sorted), p95: sorted[Math.floor(sorted.length * .95)] ?? null };
}
const summary = {};
for (const variant of variants) for (const gesture of gestures) {
  const matches = samples.filter(s => s.variant === variant && s.gesture === gesture);
  summary[`${variant}:${gesture}`] = Object.fromEntries(['gpuMs', 'cpuMs', 'frameMs', 'triangles'].map(key => [key, stats(matches.flatMap(s => s[key]))]));
}
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify({
  sceneSource: process.env.PERF_SCENE || 'working-tree',
  environment: { node: process.version, browser: browserVersion, cpu: cpus()[0].model, gpu, sessions: perLane * 6, runs, frames, viewport: [1440, 1000], quality, view, motion, forceZoomRedraw },
  summary, samples,
}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2)); console.log(`Saved ${output}`);
