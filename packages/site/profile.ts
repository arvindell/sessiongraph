import { validatePublicGraph } from '@sessiongraph/core/public-graph';
import { createPublicViewer, publicSummary } from '@sessiongraph/core/public-viewer';
import './account.css';

const name = location.pathname.match(/^\/@([a-z\d-]{1,39})\/?$/i)?.[1];
const summary = document.querySelector<HTMLElement>('#profile-summary')!;
let viewer: ReturnType<typeof createPublicViewer> | undefined;
async function load() {
  if (!name) { summary.textContent = 'Profile not found.'; return; }
  document.querySelector('#profile-name')!.textContent = `@${name}`;
  document.title = `@${name} — SessionGraph`;
  try {
    const response = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load this graph.');
    const graph = validatePublicGraph(result.graph);
    document.querySelector('#profile-name')!.textContent = `@${result.username}`;
    summary.textContent = publicSummary(graph);
    viewer = createPublicViewer(document.querySelector('#public-graph')!, graph);
    document.querySelector('#profile-info')!.textContent = `Published snapshot · Updated ${new Date(result.updatedAt).toLocaleString()}${graph.settings.timestamps ? '' : ' · Timestamps hidden; positions show session order.'}`;
  } catch (error) { summary.textContent = (error as Error).message; }
}
void load();
if (import.meta.hot) import.meta.hot.dispose(() => viewer?.dispose());
