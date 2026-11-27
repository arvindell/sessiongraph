import { validatePublicGraph } from '@sessiongraph/core/public-graph';
import type { createPublicViewer } from '@sessiongraph/core/public-viewer';
import { publicGraphStats, publicSummary } from '@sessiongraph/core/public-stats';

const usernamePattern = '[a-z\\d](?:[a-z\\d-]{0,37}[a-z\\d])?';
const name = location.pathname.match(new RegExp(`^/@(${usernamePattern})/?$`, 'i'))?.[1];
const validUsername = new RegExp(`^${usernamePattern}$`, 'i');
const count = new Intl.NumberFormat();
const cardTemplate = document.querySelector<HTMLTemplateElement>('#profile-card-template')!;
const summary = document.querySelector<HTMLElement>('#profile-summary')!;
const loading = document.querySelector<HTMLElement>('#profile-loading')!;
const host = document.querySelector<HTMLElement>('#public-graph')!;
const back = document.querySelector<HTMLElement>('#profile-back')!;
const retry = document.querySelector<HTMLAnchorElement>('#profile-retry')!;
const preview = document.querySelector<HTMLImageElement>('#profile-preview')!;
const notice = document.querySelector<HTMLElement>('#profile-notice')!;
let viewer: ReturnType<typeof createPublicViewer> | undefined;
function showError(message: string, canRetry = true) {
  host.hidden = true; loading.hidden = false; loading.dataset.state = 'error';
  summary.classList.remove('sr-only'); summary.textContent = message; back.hidden = false; retry.hidden = !canRetry;
}
async function load() {
  viewer?.dispose(); viewer = undefined;
  host.hidden = true; loading.hidden = false; loading.dataset.state = 'loading'; loading.setAttribute('aria-busy', 'true');
  summary.classList.add('sr-only'); summary.textContent = 'Loading public graph…'; back.hidden = true;
  preview.hidden = true; preview.removeAttribute('src'); notice.hidden = true; retry.hidden = true;
  document.querySelector('#profile-info')!.textContent = '';
  try {
    if (!name) { showError('Profile not found.', false); return; }
    document.title = `@${name} — SessionGraph`;
    // Download the renderer concurrently with the snapshot, not after the API.
    const renderer = import('@sessiongraph/core/public-viewer');
    void renderer.catch(() => {});
    const response = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { credentials: 'omit' });
    if (response.status === 404) { showError('This graph isn’t published.', false); return; }
    if (!response.ok) { showError('Graph unavailable. Please try again shortly.'); return; }
    const result = await response.json();
    const graph = validatePublicGraph(result.graph);
    const username = typeof result.username === 'string' && validUsername.test(result.username) ? result.username : name;
    const card = cardTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
    const heading = card.querySelector<HTMLElement>('#profile-name')!;
    const tokens = card.querySelector<HTMLElement>('#profile-tokens')!;
    const github = card.querySelector<HTMLAnchorElement>('#profile-github')!;
    heading.textContent = `@${username}`;
    heading.title = `@${username}`;
    summary.textContent = publicSummary(graph);
    const { tokenCount, tokensPartial } = publicGraphStats(graph);
    if (tokenCount !== null) {
      tokens.querySelector('strong')!.textContent = count.format(tokenCount);
      tokens.querySelector('span')!.textContent = tokensPartial ? 'recorded tokens' : 'tokens';
      tokens.hidden = false;
    }
    github.href = `https://github.com/${username}`;
    github.setAttribute('aria-label', `@${username} on GitHub (opens in a new tab)`);
    const updated = new Date(result.updatedAt);
    if (Number.isFinite(updated.getTime())) document.querySelector('#profile-info')!.textContent = `Updated ${updated.toLocaleString()}`;
    try {
      const { createPublicViewer } = await renderer;
      loading.hidden = true; host.hidden = false;
      viewer = createPublicViewer(host, graph, { fullscreen: true, sourceIconBase: '/assets/sources', profileCard: card });
    } catch {
      // A failed renderer download or unavailable WebGL need not hide the snapshot.
      host.replaceChildren();
      showError(publicSummary(graph)); notice.hidden = false;
      preview.onerror = () => { preview.hidden = true; };
      preview.src = `/api/profiles/${encodeURIComponent(name)}/thumbnail.svg`;
      preview.hidden = false;
    }
  } catch { showError('Graph unavailable. Please try again shortly.'); }
  finally { loading.setAttribute('aria-busy', 'false'); }
}
void load();
retry.onclick = event => { event.preventDefault(); location.reload(); };
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
if (import.meta.hot) import.meta.hot.dispose(() => viewer?.dispose());
