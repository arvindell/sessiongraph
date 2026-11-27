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
let viewer: ReturnType<typeof createPublicViewer> | undefined;
function showError(message: string) {
  host.hidden = true; loading.hidden = false; loading.dataset.state = 'error';
  summary.classList.remove('sr-only'); summary.textContent = message; back.hidden = false;
}
async function load() {
  viewer?.dispose(); viewer = undefined;
  host.hidden = true; loading.hidden = false; loading.dataset.state = 'loading'; loading.setAttribute('aria-busy', 'true');
  summary.classList.add('sr-only'); summary.textContent = 'Loading public graph…'; back.hidden = true;
  document.querySelector('#profile-info')!.textContent = '';
  try {
    if (!name) { showError('Profile not found.'); return; }
    document.title = `@${name} — SessionGraph`;
    // Download the renderer concurrently with the snapshot, not after the API.
    const renderer = import('@sessiongraph/core/public-viewer');
    void renderer.catch(() => {});
    const response = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { credentials: 'omit' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load this graph.');
    const graph = validatePublicGraph(result.graph);
    const { createPublicViewer } = await renderer;
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
    loading.hidden = true; host.hidden = false;
    viewer = createPublicViewer(host, graph, { fullscreen: true, sourceIconBase: '/assets/sources', profileCard: card });
    document.querySelector('#profile-info')!.textContent = `Updated ${new Date(result.updatedAt).toLocaleString()}`;
  } catch (error) { showError(error instanceof SyntaxError ? 'Public graphs are unavailable. Please try again later.' : (error as Error).message); }
  finally { loading.setAttribute('aria-busy', 'false'); }
}
void load();
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
if (import.meta.hot) import.meta.hot.dispose(() => viewer?.dispose());
