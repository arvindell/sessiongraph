import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installDemoRoutes } from './demo-fixture.mjs';

const fps = 30, smoke = process.env.DEMO_SMOKE === '1';
const assets = resolve(process.argv[2] || 'packages/site/assets');
await mkdir('tmp', { recursive: true });
await mkdir(assets, { recursive: true });
const capture = await mkdtemp(resolve('tmp/landing-demo-'));
// No app API plugin: even a missing browser route cannot open a real library.
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'no-preference', serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const now = new Date('2026-11-25T12:00:00Z');
  const { data } = await installDemoRoutes(page, {
    now: +now, autoImport: false, organic: true,
    preferences: { muted: true, motion: 'on', trailFlow: true, playbackSpeed: 3, grouping: 'worktree', quality: 'balanced' },
  });
  data.viewState = { days: 0 };
  await page.clock.install({ time: now });
  await page.goto(origin);
  await page.waitForFunction(count => window.sessionGraphDiagnostics?.()?.revealedNodes === count, data.sessions.length);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const badge = document.createElement('div');
    badge.textContent = 'DEMO · SYNTHETIC SESSIONS';
    badge.style.cssText = 'position:fixed;bottom:8px;right:16px;font:9px \"IBM Plex Mono\",monospace;letter-spacing:1px;color:#91aaa5;z-index:50;pointer-events:none';
    const cursor = document.createElement('div');
    cursor.style.cssText = 'position:fixed;inset:0 auto auto 0;width:11px;height:11px;border:1px solid #d8f3e8;border-radius:50%;background:#b0e9d628;box-shadow:0 0 0 3px #b0e9d616;z-index:9999;pointer-events:none;opacity:0';
    document.addEventListener('pointermove', event => {
      cursor.style.opacity = '1';
      cursor.style.transform = `translate(${event.clientX - 5}px,${event.clientY - 5}px)`;
    });
    document.body.append(badge, cursor);
  });
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 500));
  await page.screenshot({ path: `${capture}/poster.png` });
  let frame = 0, elapsed = 0, x = 638, y = 135;
  await page.mouse.move(x, y);
  const tick = async () => {
    const next = Math.round((frame + 1) * 1000 / fps);
    await page.clock.runFor(next - elapsed);
    elapsed = next;
    if (!smoke) await page.screenshot({ path: `${capture}/${String(frame).padStart(5, '0')}.jpg`, quality: 91, type: 'jpeg' });
    frame++;
  };
  const hold = async seconds => { for (let i = 0; i < Math.round(seconds * fps); i++) await tick(); };
  const move = async (toX, toY, seconds = .34) => {
    const steps = Math.round(seconds * fps);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, ease = t * t * (3 - 2 * t);
      await page.mouse.move(x + (toX - x) * ease, y + (toY - y) * ease);
      await tick();
    }
    x = toX; y = toY;
  };
  const click = async locator => {
    const box = await locator.boundingBox();
    assert.ok(box, `Control unavailable: ${locator}`);
    await move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(x, y);
  };
  const fit = async () => { await click(page.getByRole('button', { name: 'Fit view', exact: true })); await hold(1); };
  const chapter = name => console.log(`${(frame / fps).toFixed(1)}s — ${name}`);
  const verify = async locator => assert.ok(await locator.isVisible(), `Not visible: ${locator}`);

  chapter('Graph overview and orbit');
  await hold(1.4);
  await move(640, 330);
  for (let i = 0; i < 22; i++) { await page.mouse.wheel(0, -17); await tick(); }
  await page.mouse.down(); await move(718, 350, .95); await page.mouse.up();
  await hold(.6);
  chapter('Session details and messages');
  await click(page.locator('.session-card').first()); await hold(1.65);
  await click(page.getByRole('button', { name: /Explore messages/ })); await hold(.85);
  await click(page.locator('.event-browser > summary')); await hold(.45);
  await click(page.locator('.event-row').nth(2)); await hold(1.7);
  await verify(page.locator('.event-payload').first());
  await page.keyboard.press('Escape'); await hold(.25);
  await page.keyboard.press('Escape'); await hold(.35);
  await fit();
  chapter('Timeline playback and final orbit');
  await click(page.locator('#play')); await move(640, 130);
  await hold(11);
  assert.equal(await page.evaluate(() => window.sessionGraphDiagnostics().playbackFollowing), false);
  await fit();
  chapter('Sources settings');
  await click(page.getByRole('button', { name: 'Manage sources', exact: true })); await hold(2.3);
  await verify(page.locator('.settings-source').first());
  await click(page.getByRole('button', { name: 'Close settings', exact: true })); await hold(.4);
  chapter('Conversation search');
  await click(page.locator('#search')); await hold(.3);
  for (const letter of 'conversation search') { await page.keyboard.type(letter); await hold(.07); }
  await hold(1.6);
  await verify(page.locator('.search-result').first());
  await page.keyboard.press('Enter'); await hold(2);
  await page.keyboard.press('Escape'); await hold(.4);
  await fit();
  await move(638, 135); await hold(1.5);

  assert.deepEqual(errors, []);
  if (!smoke) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', `${capture}/%05d.jpg`, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${assets}/demo.mp4`], { stdio: 'inherit' });
    execFileSync('cwebp', ['-quiet', '-q', '90', `${capture}/poster.png`, '-o', `${assets}/sessiongraph.webp`], { stdio: 'inherit' });
  }
  console.log(`${smoke ? 'Verified' : 'Recorded'} ${frame} frames (${(frame / fps).toFixed(1)}s at ${fps} fps).`);
} finally {
  await browser?.close();
  await server.close();
  await rm(capture, { recursive: true, force: true });
}
