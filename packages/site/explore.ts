import './explore.css';

type Entry = { username: string; updatedAt: string; sessionCount: number; tokenCount: number | null; tokensPartial: boolean };
const gallery = document.querySelector<HTMLElement>('#graph-gallery')!;
const status = document.querySelector<HTMLElement>('#gallery-status')!;
const more = document.querySelector<HTMLButtonElement>('#gallery-more')!;
let page: number | null = 0, loading = false;
const seen = new Set<string>();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function card(entry: Entry) {
  const link = document.createElement('a'); link.className = 'graph-card'; link.href = `/@${encodeURIComponent(entry.username)}`;
  link.setAttribute('aria-label', `Explore @${entry.username}'s graph`);
  const image = document.createElement('img'); image.src = `/api/profiles/${encodeURIComponent(entry.username)}/thumbnail.svg`; image.width = 640; image.height = 360; image.loading = 'lazy'; image.alt = `Graph preview for @${entry.username}`;
  const preview = document.createElement('div'); preview.className = 'graph-card-preview'; preview.append(image);
  image.onerror = () => { image.hidden = true; const fallback = document.createElement('span'); fallback.textContent = 'Open graph to explore'; preview.append(fallback); };
  const body = document.createElement('div'); body.className = 'graph-card-body';
  const title = document.createElement('h2'); title.textContent = `@${entry.username}`;
  const arrow = document.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true'); title.append(arrow);
  const stats = document.createElement('p'); stats.className = 'graph-card-stats';
  const sessions = document.createElement('span'); sessions.textContent = `${entry.sessionCount.toLocaleString()} sessions`; stats.append(sessions);
  if (entry.tokenCount !== null) {
    const tokens = document.createElement('span'); tokens.textContent = `${compact.format(entry.tokenCount)} tokens${entry.tokensPartial ? ' · partial' : ''}`;
    tokens.title = `${entry.tokenCount.toLocaleString()} recorded tokens${entry.tokensPartial ? '; some sessions have unknown usage' : ''}`; stats.append(tokens);
  }
  const date = document.createElement('p'); date.className = 'graph-card-date'; date.textContent = `Updated ${new Date(entry.updatedAt).toLocaleDateString()}`;
  body.append(title, stats, date); link.append(preview, body); return link;
}

async function load() {
  if (loading || page === null) return;
  loading = true; more.disabled = true; status.textContent = 'Loading public graphs…';
  try {
    const response = await fetch(`/api/graphs?page=${page}`, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('Could not load public graphs. Please try again.');
    const result: { graphs: Entry[]; nextPage: number | null } = await response.json();
    for (const entry of result.graphs) if (!seen.has(entry.username)) { gallery.append(card(entry)); seen.add(entry.username); }
    page = result.nextPage;
    status.textContent = seen.size ? '' : page === null ? 'No graphs have been published yet. Yours could be the first.' : 'No graphs on this page. Keep exploring.';
    more.textContent = 'Show more graphs'; more.hidden = page === null;
    document.querySelector<HTMLElement>('#gallery-create')!.hidden = seen.size > 0 || page !== null;
  } catch {
    status.textContent = 'Could not load public graphs. Please try again.'; more.hidden = false; more.textContent = 'Try again';
  } finally { loading = false; more.disabled = false; }
}
more.onclick = () => void load();
window.addEventListener('pageshow', event => { if (event.persisted) { gallery.replaceChildren(); seen.clear(); page = 0; void load(); } });
void load();
