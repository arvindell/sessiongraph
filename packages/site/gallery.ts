export type GallerySort = 'updated' | 'tokens' | 'sessions';
export type GalleryQuery = { q: string; sort: GallerySort; page: number };
export type GalleryEntry = { username: string; updatedAt: string; sessionCount: number | null; tokenCount: number | null; tokensPartial: boolean; revision: string | null };
export type GalleryResult = { graphs: GalleryEntry[]; nextPage: number | null; previewsPending?: boolean };

export function galleryParams(query: GalleryQuery) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.sort !== 'updated') params.set('sort', query.sort);
  if (query.page) params.set('page', String(query.page));
  return params.toString();
}

const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export function galleryCard(entry: GalleryEntry, index: number) {
  const username = escape(entry.username), path = encodeURIComponent(entry.username);
  const tokens = entry.tokenCount === null ? '' : `<span title="${entry.tokenCount.toLocaleString('en')} recorded tokens${entry.tokensPartial ? '; some sessions have unknown usage' : ''}">${compact.format(entry.tokenCount)} tokens</span>`;
  const sessions = entry.sessionCount === null ? '' : `<span>${entry.sessionCount.toLocaleString('en')} sessions</span>`;
  const image = entry.revision === null ? '' : `<img src="/api/profiles/${path}/thumbnail.svg?v=${encodeURIComponent(entry.revision)}" width="640" height="360" loading="${index < 3 ? 'eager' : 'lazy'}" decoding="async"${index === 0 ? ' fetchpriority="high"' : ''} alt="Graph preview for @${username}">`;
  return `<a class="graph-card" href="/@${path}" aria-label="Explore @${username}'s graph">
    <div class="graph-card-preview">${image}<span class="graph-thumbnail-fallback"${image ? ' hidden' : ''}>Open graph to explore</span></div>
    <div class="graph-card-body"><h2>@${username}<span aria-hidden="true">↗</span></h2><p class="graph-card-stats">${sessions}${tokens}</p><p class="graph-card-date">Updated <time datetime="${escape(entry.updatedAt)}">${escape(entry.updatedAt.slice(0, 10))}</time></p></div>
  </a>`;
}

export function galleryMessage(count: number, query: GalleryQuery) {
  return count ? '' : query.q ? `No public graphs match “${query.q}”.` : 'No graphs have been published yet. Yours could be the first.';
}
