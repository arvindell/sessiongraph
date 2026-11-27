import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Read-only browser measurements. Local runs should use synthetic public API fixtures.
const base = process.env.SITE_BASE || 'https://sessiongraph.ai';
const paths = (process.env.SITE_PATHS || '/,/explore').split(',');
const runs = Number(process.env.PERF_RUNS || 3);
const output = resolve(process.env.PERF_OUTPUT || 'tmp/performance/public/browser.json');
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=metal'] });
const results = [];
try {
  for (const path of paths) for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__perf = { lcp: 0, longTasks: [] };
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__perf.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
    });
    await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded' });
    if (path.startsWith('/explore')) {
      await page.waitForFunction(() => document.querySelector('#graph-gallery')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 60000 });
    } else if (path.startsWith('/@')) {
      await page.waitForSelector('#public-graph canvas', { timeout: 60000 });
    }
    const readyMs = await page.evaluate(() => performance.now());
    if (path.startsWith('/explore')) await page.waitForFunction(() => [...document.querySelectorAll('#graph-gallery .graph-card img')].every(image => image.complete), undefined, { timeout: 60000 });
    await page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
    const result = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');
      return {
        ttfbMs: nav.responseStart, domContentLoadedMs: nav.domContentLoadedEventEnd,
        fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
        lcpMs: window.__perf.lcp, settledMs: performance.now(),
        cards: document.querySelectorAll('#graph-gallery .graph-card').length,
        brokenImages: [...document.querySelectorAll('#graph-gallery .graph-card img')].filter(image => !image.naturalWidth).length,
        transferBytes: resources.reduce((sum, r) => sum + r.transferSize, nav.transferSize),
        scriptBytes: resources.filter(r => r.initiatorType === 'script').reduce((sum, r) => sum + r.encodedBodySize, 0),
        longTasks: window.__perf.longTasks,
        resources: resources.map(r => ({ path: new URL(r.name).pathname, startMs: r.startTime, durationMs: r.duration, transferBytes: r.transferSize })),
      };
    });
    results.push({ path, run, readyMs, ...result, errors });
    console.log(JSON.stringify({ path, run, readyMs, ...result, resources: undefined, errors }));
    await context.close();
  }
} finally { await browser.close(); }
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ base, measuredAt: new Date().toISOString(), results }, null, 2));
