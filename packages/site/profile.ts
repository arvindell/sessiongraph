import { validatePublicGraph } from '@sessiongraph/core/public-graph';
import type { createPublicViewer } from '@sessiongraph/core/public-viewer';
import { publicSummary } from '@sessiongraph/core/public-stats';

const name = location.pathname.match(/^\/@([a-z\d-]{1,39})\/?$/i)?.[1];
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
    document.querySelector('#profile-name')!.textContent = `@${name}`;
    document.title = `@${name} — SessionGraph`;
    const response = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { cache: 'no-store', credentials: 'omit' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load this graph.');
    const graph = validatePublicGraph(result.graph);
    const { createPublicViewer } = await import('@sessiongraph/core/public-viewer');
    document.querySelector('#profile-name')!.textContent = `@${result.username}`;
    summary.textContent = publicSummary(graph);
    loading.hidden = true; host.hidden = false;
    viewer = createPublicViewer(host, graph, { fullscreen: true });
    document.querySelector('#profile-info')!.textContent = `Published snapshot · Updated ${new Date(result.updatedAt).toLocaleString()}${graph.settings.timestamps ? '' : ' · Timestamps hidden; positions show session order.'}`;
  } catch (error) { showError(error instanceof SyntaxError ? 'Public graphs are unavailable. Please try again later.' : (error as Error).message); }
  finally { loading.setAttribute('aria-busy', 'false'); }
}
void load();
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
if (import.meta.hot) import.meta.hot.dispose(() => viewer?.dispose());
