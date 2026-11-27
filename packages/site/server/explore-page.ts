import { readFile } from 'node:fs/promises';
import { galleryCard, galleryMessage, galleryParams, type GalleryQuery, type GalleryResult } from '../gallery';
import { galleryTag, publicResponse } from './public-cache';

let template: Promise<string> | undefined;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderExplorePage(html: string, result: GalleryResult, query: GalleryQuery) {
  const data = JSON.stringify({ result, query }).replace(/</g, '\\u003c');
  const next = result.nextPage === null ? '' : `/explore?${galleryParams({ ...query, page: result.nextPage })}`;
  return html
    .replace(/<div id="graph-gallery"[^>]*><\/div>/, `<div id="graph-gallery" class="graph-gallery" aria-busy="false"${result.graphs.length ? '' : ' hidden'}>${result.graphs.map(galleryCard).join('')}</div>`)
    .replace('id="gallery-loading"', 'id="gallery-loading" hidden')
    .replace(/<p id="gallery-status"[^>]*>[^<]*<\/p>/, `<p id="gallery-status" role="status">${escape(galleryMessage(result.graphs.length, query))}</p>`)
    .replace(/<a id="gallery-more"[^>]*>[^<]*<\/a>/, `<a id="gallery-more" class="button" href="${escape(next)}"${next ? '' : ' hidden'}>Show more graphs</a>`)
    .replace('id="gallery-search"', `id="gallery-search" value="${escape(query.q)}"`)
    .replace(`value="${query.sort}">`, `value="${query.sort}" selected>`)
    .replace('<template id="gallery-data"></template>', `<script type="application/json" id="gallery-data">${data}</script>`);
}

export async function explorePage(request: Request, result: GalleryResult, query: GalleryQuery, source?: string) {
  // Vite emits the HTML with hashed asset URLs; use that exact template on the
  // server. Vercel caches the completed page, including its first twelve cards.
  if (source === undefined) {
    template ??= readFile(new URL('../dist-api/explore.html', import.meta.url), 'utf8').catch(error => { template = undefined; throw error; });
    source = await template;
  }
  return publicResponse(request, renderExplorePage(source, result, query), 'text/html; charset=utf-8', [galleryTag]);
}
