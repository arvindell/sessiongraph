import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// All page and ingestion requests are intercepted; no test events reach PostHog.
const bundled = await build({
  entryPoints: [new URL('../analytics.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: {
    'import.meta.env.VITE_POSTHOG_PROJECT_TOKEN': JSON.stringify('phc_browser_fixture'),
    'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify('/ingest'),
    'import.meta.env.DEV': 'false',
  },
  plugins: [{
    name: 'allow-automated-fixture-visitor',
    setup(builder) {
      builder.onLoad({ filter: /analytics-config\.ts$/ }, async args => ({
        // SDK-recommended E2E override, applied only to this in-memory fixture bundle.
        contents: (await readFile(args.path, 'utf8')).replace('respect_dnt: true,', 'respect_dnt: true, opt_out_useragent_filter: true,'),
        loader: 'ts',
      }));
    },
  }],
});
const browser = await chromium.launch();
try {
  for (const scenario of ['public', 'profile', 'account', 'preview', 'dnt', 'gpc'] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests: string[] = [], events: Array<{ event: string; properties: Record<string, unknown> }> = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const logs: string[] = [];
    page.on('console', message => logs.push(message.text()));
    if (scenario === 'dnt' || scenario === 'gpc') {
      await page.addInitScript(({ name, value }) => Object.defineProperty(navigator, name, { value }), {
        name: scenario === 'dnt' ? 'doNotTrack' : 'globalPrivacyControl', value: scenario === 'dnt' ? '1' : true,
      });
    }
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.isNavigationRequest()) {
        await route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'" },
          body: '<!doctype html><title>Analytics fixture</title><script type="module" src="/analytics.js"></script>',
        });
      } else if (url.pathname === '/analytics.js') {
        await route.fulfill({ contentType: 'text/javascript', body: bundled.outputFiles[0].text });
      } else {
        requests.push(url.pathname);
        const body = request.postDataBuffer();
        if (url.pathname === '/ingest/e/' && body) {
          let json: string;
          if (body[0] === 0x1f && body[1] === 0x8b) json = gunzipSync(body).toString();
          else if (url.searchParams.get('compression') === 'base64') json = Buffer.from(new URLSearchParams(body.toString()).get('data')!, 'base64').toString();
          else json = body.toString();
          const parsed = JSON.parse(json);
          events.push(...(Array.isArray(parsed) ? parsed : parsed.batch || [parsed]));
        }
        await route.fulfill({ json: { status: 1 } });
      }
    });
    const host = scenario === 'preview' ? 'preview.vercel.app' : 'sessiongraph.ai';
    const path = scenario === 'account' ? '/account' : scenario === 'profile' ? '/@private-person' : '/';
    await page.goto(`https://${host}${path}?private-query=yes#private-fragment`);
    if (scenario === 'public' || scenario === 'profile') {
      await page.waitForResponse(response => new URL(response.url()).pathname === '/ingest/e/', { timeout: 10_000 })
        .catch(() => { throw new Error(JSON.stringify({ scenario, requests, errors, logs })); });
      assert.ok(events.some(event => event.event === '$pageview'), JSON.stringify({ scenario, events }));
      assert.equal(events[0].properties.distinct_id, '$posthog_cookieless');
      assert.equal(events[0].properties.$pathname, scenario === 'profile' ? '/@:username' : '/');
      assert.doesNotMatch(JSON.stringify(events), /private-query|private-fragment|private-person/);
      assert.ok(requests.every(path => path === '/ingest/e/'), JSON.stringify(requests));
    } else {
      // Await the entry module to establish that it has evaluated without SDK traffic.
      await page.evaluate(async () => { const entry = '/analytics.js'; await import(entry); });
      assert.deepEqual(requests, [], scenario);
    }
    assert.deepEqual(await context.cookies(), [], scenario);
    assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] }, scenario);
    assert.deepEqual(errors, [], scenario);
    await context.close();
    console.log(`Verified ${scenario}: privacy controls and cookieless capture`);
  }
} finally {
  await browser.close();
}
