import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderExplorePage } from '../server/explore-page';
import { galleryCard, type GalleryEntry } from '../gallery';
import { publicResponse, purgePublicCache } from '../server/public-cache';
import { galleryQuery } from '../server/publications';

const entry: GalleryEntry = { username: 'sample', sessionCount: 25, tokenCount: 36_000_000_000, tokensPartial: false, updatedAt: '2026-11-27T12:00:00.000Z', revision: 'example-revision' };
test('Explore HTML includes usable cards, forms and paging before JavaScript runs', async () => {
  const source = await readFile(new URL('../explore.html', import.meta.url), 'utf8');
  const html = renderExplorePage(source, { graphs: [entry], nextPage: 1 }, { q: 'sample', sort: 'tokens', page: 0 });
  assert.match(html, /id="graph-gallery"[^>]*aria-busy="false"><a class="graph-card"/);
  assert.match(html, /id="gallery-loading" hidden/);
  assert.match(html, /id="gallery-search" value="sample"/);
  assert.match(html, /value="tokens" selected/);
  assert.match(html, /href="\/explore\?q=sample&amp;sort=tokens&amp;page=1"/);
  assert.match(html, /36B tokens/);
  assert.match(html, /fetchpriority="high"/);
  assert.match(html, /id="gallery-data"/);
  assert.match(galleryCard(entry, 4), /loading="lazy"/);
});

test('server-rendered content and bootstrap data cannot break out of HTML', async () => {
  const source = await readFile(new URL('../explore.html', import.meta.url), 'utf8');
  const hostile = { ...entry, username: '</script><img src=x onerror=alert(1)>' };
  const html = renderExplorePage(source, { graphs: [hostile], nextPage: null }, { q: '"><script>oops</script>', sort: 'updated', page: 0 });
  assert.doesNotMatch(html, /<img src=x|<script>oops|<\/script><img/);
  assert.match(html, /\\u003c\/script>/);
});

test('gallery inputs canonicalize usernames and reject invalid query shapes', () => {
  assert.deepEqual(galleryQuery(new URL('https://example.com/explore?q=%20%40Alice%20&sort=tokens&page=1')), { q: 'alice', sort: 'tokens', page: 1 });
  for (const query of ['q=%25', 'q=someone@example.com', 'page=-1', 'sort=garbage']) assert.throws(() => galleryQuery(new URL(`https://example.com/?${query}`)));
});

test('revocable responses revalidate at the browser and support conditional GET', async () => {
  const request = new Request('https://example.com/api/graphs');
  const response = publicResponse(request, '{"graphs":[]}', 'application/json', ['public-gallery']);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.doesNotMatch(response.headers.get('vercel-cdn-cache-control')!, /stale/);
  const conditional = new Request(request, { headers: { 'If-None-Match': `"other", W/${response.headers.get('etag')}` } });
  const unchanged = publicResponse(conditional, '{"graphs":[]}', 'application/json', ['public-gallery']);
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
  assert.equal(publicResponse(conditional, '{"graphs":[1]}', 'application/json', ['public-gallery']).status, 200);
});

test('public mutations await foreground CDN eviction of the gallery and affected usernames', async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const calls: unknown[][] = [];
    await purgePublicCache(['Old-Name', 'new-name', 'new-name'], async (...args: any[]) => { calls.push(args); });
    assert.deepEqual(calls, [[['public-gallery', 'public-profile:old-name', 'public-profile:new-name'], { revalidationDeadlineSeconds: 0 }]]);
    await assert.rejects(purgePublicCache(['sample'], async () => { throw new Error('purge unavailable'); }), /purge unavailable/);
  } finally {
    if (previous === undefined) delete process.env.VERCEL; else process.env.VERCEL = previous;
  }
});
