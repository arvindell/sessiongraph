import { galleryCard, galleryMessage, galleryParams, type GalleryEntry, type GalleryQuery, type GalleryResult } from './gallery';

const gallery = document.querySelector<HTMLElement>('#graph-gallery')!;
const skeleton = document.querySelector<HTMLElement>('#gallery-loading')!;
const status = document.querySelector<HTMLElement>('#gallery-status')!;
const more = document.querySelector<HTMLAnchorElement>('#gallery-more')!;
const create = document.querySelector<HTMLElement>('#gallery-create')!;
const form = document.querySelector<HTMLFormElement>('#gallery-controls')!;
const search = document.querySelector<HTMLInputElement>('#gallery-search')!;
const sort = document.querySelector<HTMLSelectElement>('#gallery-sort')!;
const initial = document.querySelector('#gallery-data');
const boot = initial?.tagName === 'SCRIPT' ? JSON.parse(initial.textContent!) as { query: GalleryQuery; result: GalleryResult } : undefined;
let query: GalleryQuery = boot?.query ?? fromURL();
let nextPage: number | null = boot?.result.nextPage ?? null;
let entries: GalleryEntry[] = boot?.result.graphs ?? [];
let controller: AbortController | undefined, sequence = 0, debounce = 0;

function fromURL(): GalleryQuery {
  const params = new URLSearchParams(location.search), value = params.get('sort');
  return { q: (params.get('q') || '').trim().replace(/^@/, '').toLowerCase(), sort: value === 'tokens' || value === 'sessions' ? value : 'updated', page: Number(params.get('page')) || 0 };
}
function previews() {
  for (const image of gallery.querySelectorAll<HTMLImageElement>('img')) {
    const failed = () => { image.hidden = true; image.nextElementSibling?.removeAttribute('hidden'); };
    image.onerror = failed;
    if (image.complete && !image.naturalWidth) failed();
  }
}
function finish() {
  delete more.dataset.retry;
  skeleton.hidden = true; gallery.hidden = !entries.length; gallery.setAttribute('aria-busy', 'false');
  status.classList.remove('sr-only'); status.textContent = galleryMessage(entries.length, query);
  more.hidden = nextPage === null; more.removeAttribute('aria-disabled'); more.textContent = 'Show more graphs';
  if (nextPage !== null) more.href = `/explore?${galleryParams({ ...query, page: nextPage })}`;
  create.hidden = entries.length > 0 || Boolean(query.q);
  previews();
}
async function load(append = false) {
  window.clearTimeout(debounce);
  controller?.abort(); controller = new AbortController();
  const current = ++sequence, signal = controller.signal;
  const requestQuery = append ? { ...query, page: nextPage! } : query;
  more.setAttribute('aria-disabled', 'true'); gallery.setAttribute('aria-busy', 'true');
  skeleton.hidden = entries.length > 0; create.hidden = true;
  status.classList.remove('sr-only'); status.textContent = 'Loading public graphs…';
  try {
    const response = await fetch(`/api/graphs?${galleryParams(requestQuery)}`, { credentials: 'omit', signal });
    if (!response.ok) throw new Error('Could not load public graphs. Please try again.');
    const result: GalleryResult = await response.json();
    if (current !== sequence) return;
    if (!append) { entries = []; gallery.replaceChildren(); }
    const seen = new Set(entries.map(entry => entry.username));
    const added = result.graphs.filter(entry => !seen.has(entry.username));
    gallery.insertAdjacentHTML('beforeend', added.map((entry, i) => galleryCard(entry, entries.length + i)).join(''));
    entries.push(...added); nextPage = result.nextPage; finish();
  } catch {
    if (signal.aborted || current !== sequence) return;
    skeleton.hidden = true; gallery.setAttribute('aria-busy', 'false');
    status.textContent = 'Could not load public graphs. Please try again.';
    more.hidden = false; more.removeAttribute('aria-disabled'); more.textContent = 'Try again';
    more.dataset.retry = append ? 'append' : 'replace';
  }
}
function change(delayed = false) {
  window.clearTimeout(debounce); controller?.abort(); ++sequence;
  nextPage = null; more.hidden = true;
  query = { q: search.value.trim().replace(/^@/, '').toLowerCase(), sort: sort.value as GalleryQuery['sort'], page: 0 };
  const params = galleryParams(query);
  history.replaceState(null, '', `/explore${params ? `?${params}` : ''}`);
  delete more.dataset.retry;
  if (delayed) debounce = window.setTimeout(() => void load(), 150);
  else void load();
}
form.classList.add('is-enhanced');
search.value = query.q; sort.value = query.sort;
form.onsubmit = event => { event.preventDefault(); change(); };
search.oninput = () => change(true);
sort.onchange = () => change();
more.onclick = event => {
  event.preventDefault();
  if (more.getAttribute('aria-disabled') === 'true') return;
  const retry = more.dataset.retry; delete more.dataset.retry;
  if (retry || nextPage !== null) void load(retry ? retry === 'append' : true);
};
window.addEventListener('popstate', () => { query = fromURL(); search.value = query.q; sort.value = query.sort; void load(); });
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
if (boot) finish(); else void load();
