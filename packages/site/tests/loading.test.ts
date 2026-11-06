import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('page skeletons and their styles are present before JavaScript loads', async () => {
  for (const [page, id] of [['explore', 'gallery-loading'], ['profile', 'profile-loading'], ['account', 'account-loading']]) {
    const html = await source(`${page}.html`);
    assert.ok(html.includes(`href="/${page}.css"`), `${page} loads its layout without waiting for JavaScript`);
    assert.match(html, new RegExp(`id="${id}"[^>]*>`));
    assert.doesNotMatch(html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))![0], /\shidden(?:\s|>)/);
    assert.match(html, /class="sr-only" role="status">Loading/);
  }
  const gallery = await source('explore.html');
  assert.equal((gallery.match(/graph-card graph-card-skeleton/g) || []).length, 6);
  assert.match(gallery, /id="gallery-loading"[^>]*aria-hidden="true"/);
  assert.match(await source('profile.html'), /class="graph-skeleton" aria-hidden="true"/);
  assert.match(await source('account.html'), /id="account-loading"[^>]*aria-hidden="true"/);
});

test('shared skeletons respect reduced motion', async () => {
  assert.match(await source('style.css'), /@import '\.\/skeleton.css'/);
  assert.match(await source('skeleton.css'), /@media\s*\(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
});
