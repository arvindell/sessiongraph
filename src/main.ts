import { createIcons, Search, GitFork, GitBranch, Folder, ArrowUpRight, ArrowRight, X, Box, RotateCcw, RefreshCw, Play, Pause, ChevronDown, FileCode2, Terminal, Copy, Crosshair, CircleHelp, SlidersHorizontal, LoaderCircle, Network, Clock, Sparkles, Grip, PanelRight } from 'lucide';
import type { TimelineScene } from './scene';
import { directoryLabel, makeGraph } from './layout';
import { setupPanelDragging } from './panels';
import { createSessionSearch } from './search/ui';
import { createSessionLauncher } from './launcher';
import { createImports } from './imports';
import { sourceName, sourceIcon } from './sources';
import type { AtlasData, Graph, Session, SessionDetail } from './types';
import './style.css';

const icons = { Search, GitFork, GitBranch, Folder, ArrowUpRight, ArrowRight, X, Box, RotateCcw, RefreshCw, Play, Pause, ChevronDown, FileCode2, Terminal, Copy, Crosshair, CircleHelp, SlidersHorizontal, LoaderCircle, Network, Clock, Sparkles, Grip, PanelRight };
const refreshIcons = () => createIcons({ icons, attrs: { 'stroke-width': 1.5 } });
const icon = (name: string, cls = '') => `<i data-lucide="${name}" class="${cls}" aria-hidden="true"></i>`;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const compact = (value: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const count = (value: number) => value.toLocaleString('en');
const date = (value: number, year = false) => new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
const timestamp = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const inputDate = (value: number) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let data: AtlasData | undefined;
let graph: Graph = { nodes: [], edges: [], lanes: [], start: 0, end: 0 };
let filtered: Session[] = [];
let scene: TimelineScene | undefined;
let selectedID: string | null = new URLSearchParams(location.search).get('session');
let selectedDetail: SessionDetail | undefined;
let projectID = '';
let sourceID = '';
let directory = '';
let days = 90;
let fromDate = '';
let toDate = '';
let includeChildren = true;
let includeArchived = true;
let listLimit = 60;
let detailRequest = 0;
let playFrame = 0;
let playing = false;
let playback = 1;
let lastPlayTime = 0;
const PLAYBACK_DURATION = 30_000;

$('#app').innerHTML = `
  <main class="map" aria-label="Session map">
    <h1 class="sr-only">Atlas · your LLM sessions</h1>
    <div id="scene"></div>
    <div class="canvas-vignette"></div>
    <div id="graph-message" class="graph-message"><div class="loading-orbit"><span></span><span></span><span></span></div><h3>Loading sessions…</h3></div>
    <div id="tooltip" class="node-tooltip" hidden></div>
  </main>
  <header class="app-header glass">
    <a class="brand" href="/" aria-label="Atlas home"><img src="/favicon.svg" alt=""/><span>atlas<span class="brand-dot">.</span></span></a>
    <span class="connection" role="status" title="Connecting"><span class="status-dot"></span><span id="connection-label" class="sr-only">Connecting</span></span>
    <span class="toolbar-divider"></span>
    <button class="toolbar-button" id="toggle-explorer" aria-label="Toggle sessions" aria-controls="explorer" aria-expanded="true" title="Sessions">${icon('search')}<span>Sessions</span></button>
  </header>
  <nav class="map-controls glass" aria-label="Map controls">
    <div class="view-switch" role="group" aria-label="View mode"><button id="view-3d" class="active" aria-pressed="true">3D</button><button id="view-2d" aria-pressed="false">2D</button></div>
    <span class="toolbar-divider"></span>
    <button class="icon-button" id="reset-camera" aria-label="Fit view" title="Fit view (F)">${icon('crosshair')}</button>
    <button class="icon-button" id="toggle-timeline" aria-label="Toggle timeline" aria-controls="timeline" aria-expanded="true" title="Timeline">${icon('clock')}</button>
    <button class="icon-button" id="toggle-inspector" aria-label="Toggle session details" aria-controls="inspector" aria-expanded="false" title="Session details" hidden>${icon('panel-right')}</button>
    <button class="icon-button" id="help" aria-label="Help" title="Help">${icon('circle-help')}</button>
  </nav>
  <aside class="sidebar floating-panel glass" id="explorer" aria-label="Sessions">
      <div class="panel-heading"><button class="panel-handle" data-drag-panel="explorer" aria-label="Move sessions panel" title="Drag to move · Arrow keys to reposition">${icon('grip')}<span>Sessions</span><span class="small-badge" id="list-count">—</span></button><button class="icon-button" id="refresh" aria-label="Refresh sessions" title="Refresh sessions">${icon('refresh-cw')}</button><button class="icon-button" id="close-explorer" aria-label="Close sessions">${icon('x')}</button></div>
      <button class="search-box search-trigger" id="search" aria-label="Search all sessions">${icon('search')}<span>Search everything…</span><kbd>/</kbd></button>
      <div class="filters">
        <div class="select-wrap"><span id="source-filter-icon">${sourceIcon()}</span><select id="source" aria-label="Session source"><option value="">All sources</option></select><button class="icon-button" id="manage-sources" aria-label="Manage sources" title="Import sources">${icon('sliders-horizontal')}</button></div>
        <div class="select-wrap">${icon('folder')}<select id="project" aria-label="Project"><option value="">All projects</option></select>${icon('chevron-down')}</div>
        <div class="select-wrap">${icon('git-branch')}<select id="directory" aria-label="Worktree or directory"><option value="">All directories</option></select>${icon('chevron-down')}</div>
        <div class="filter-toggles"><label><input type="checkbox" id="children" checked/><span>Child sessions</span></label><label><input type="checkbox" id="archived" checked/><span>Archived</span></label></div>
      </div>
      <nav class="session-list" id="session-list" aria-label="Sessions"><div class="list-loading">${[0, 1, 2, 3, 4].map(() => '<div class="skeleton"></div>').join('')}</div></nav>
  </aside>
  <aside class="inspector floating-panel glass" id="inspector" aria-label="Session details" hidden></aside>
  <section class="timeline-panel floating-panel glass" id="timeline" aria-label="Timeline controls">
    <div class="timeline-top"><button class="panel-handle" data-drag-panel="timeline" aria-label="Move timeline panel" title="Drag to move · Arrow keys to reposition">${icon('grip')}<span id="date-label">Timeline</span></button><div class="range-buttons" role="group" aria-label="Date range"><button data-days="7">7D</button><button data-days="30">30D</button><button data-days="90" class="active">90D</button><button data-days="0">All</button></div><details class="custom-dates"><summary class="icon-button" aria-label="Custom date range" title="Custom date range">${icon('sliders-horizontal')}</summary><div class="date-popover"><label>From<input type="date" id="from-date" aria-label="From date"/></label><label>To<input type="date" id="to-date" aria-label="To date"/></label><button id="apply-dates" class="secondary-button">Apply ${icon('arrow-right')}</button></div></details><button class="icon-button" id="close-timeline" aria-label="Close timeline">${icon('x')}</button></div>
    <div class="timeline-track"><button id="play" class="play-button" aria-label="Play timeline">${icon('play')}</button><div class="histogram-wrap"><div id="histogram" class="histogram"></div><input id="scrubber" type="range" min="0" max="1000" value="1000" aria-label="Timeline playback position"/><div class="timeline-cursor" id="timeline-cursor"></div></div><div class="playback-date" id="playback-date">—</div></div>
  </section>
  <dialog id="help-dialog" aria-labelledby="help-title"><button class="icon-button dialog-close" id="close-help" aria-label="Close help">${icon('x')}</button><h2 id="help-title">Explore the map</h2><div class="help-rows"><div><span>Orbit</span><kbd>Drag</kbd></div><div><span>Zoom</span><kbd>Scroll / pinch</kbd></div><div><span>Pan</span><kbd>Right-drag</kbd></div><div><span>Fit view</span><kbd>F</kbd></div><div><span>Search everything</span><kbd>/ · ⌘/Ctrl K</kbd></div><div><span>Hide / restore panels</span><kbd>H</kbd></div><div><span>Clear selection</span><kbd>Esc</kbd></div></div><div class="graph-legend"><span><i class="legend-node"></i>Session</span><span><i class="legend-line fork"></i>Fork</span><span><i class="legend-line child"></i>Child</span><span><i class="legend-line lane"></i>Directory timeline</span><span id="file-legend" hidden><i class="legend-file"></i>File</span></div><p>Time runs left to right. Directory streams group sessions; only fork and child links represent ancestry.</p><button class="secondary-button motion-button" id="motion" aria-pressed="true">${icon('sparkles')}Animate map</button></dialog>
  <div id="toast" class="toast" role="status" hidden></div>
`;
refreshIcons();
const disposePanelDragging = setupPanelDragging();
const modalVisibility = () => { const open = Boolean(document.querySelector('dialog[open]')); if (open && playing) stopPlayback(); scene?.setSuspended(open); };
const launcher = createSessionLauncher(modalVisibility);
const imports = createImports(load, modalVisibility);
$('#manage-sources').addEventListener('click', () => void imports.open());
document.addEventListener('atlas-import-status', (event) => {
  const status = (event as CustomEvent<import('./types').ImportStatus>).detail;
  $('#refresh').classList.toggle('spinning', status.running);
  $('.connection').title = status.running ? `Importing ${sourceName(status.source)} · ${status.imported} sessions saved` : 'Local library · SQLite';
});
const sessionSearch = createSessionSearch((id) => { selectSession(id); scene?.focus(id); }, modalVisibility, (session) => void launcher.open(session));
$('#search').addEventListener('click', sessionSearch.open);

type PanelID = 'explorer' | 'timeline' | 'inspector';
function setPanel(id: PanelID, visible: boolean) {
  const panel = $(`#${id}`);
  panel.hidden = !visible;
  if (id === 'timeline' && !visible && playing) stopPlayback();
  $(`#toggle-${id}`).setAttribute('aria-expanded', String(visible));
  if (visible && innerWidth < 760 && id !== 'timeline') {
    const other = id === 'explorer' ? 'inspector' : 'explorer';
    setPanel(other, false);
  }
}
setPanel('explorer', innerWidth >= 760);
let hiddenPanels: PanelID[] = [];
for (const id of ['explorer', 'timeline', 'inspector'] as const) {
  $(`#toggle-${id}`).addEventListener('click', () => setPanel(id, $(`#${id}`).hidden));
}
$('#close-explorer').addEventListener('click', () => { setPanel('explorer', false); $('#toggle-explorer').focus(); });
$('#close-timeline').addEventListener('click', () => { stopPlayback(); setPanel('timeline', false); $('#toggle-timeline').focus(); });
const customDates = $<HTMLDetailsElement>('.custom-dates');
customDates.addEventListener('toggle', () => {
  if (customDates.open) customDates.classList.toggle('open-below', customDates.getBoundingClientRect().top < 280);
});

function showToast(text: string) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  window.setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

function emptyInspector() {
  setPanel('inspector', false);
  $('#inspector').replaceChildren();
  $('#toggle-inspector').hidden = true;
}
emptyInspector();

try {
  const { TimelineScene } = await import('./scene');
  scene = new TimelineScene($('#scene'), {
    onSelect: (id) => selectSession(id),
    onPlaybackInterrupt: stopPlayback,
    onHover: (node, x, y) => {
      const tooltip = $('#tooltip');
      tooltip.hidden = !node;
      if (!node) return;
      tooltip.innerHTML = `<strong>${escape(node.session.title)}</strong><span>${escape(sourceName(node.session.source))} · ${date(node.session.created)} · ${escape(node.session.model)}</span>`;
      tooltip.style.left = `${Math.min(x + 18, $('#scene').clientWidth - 280)}px`;
      tooltip.style.top = `${Math.max(8, Math.min(y - 32, $('#scene').clientHeight - 110))}px`;
    },
  });
} catch (error) {
  console.error('[atlas] Graphics initialization failed', error);
  showToast('3D requires WebGL. You can still browse sessions in the list.');
}
$('#scene').addEventListener('scene-error', (event) => showToast((event as CustomEvent<string>).detail));

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result as T;
}

async function load() {
  const refresh = $<HTMLButtonElement>('#refresh');
  refresh.disabled = true;
  refresh.classList.add('spinning');
  try {
    data = await fetchJSON<AtlasData>('/api/atlas');
    $<HTMLSelectElement>('#source').innerHTML = '<option value="">All sources</option>' + (data.sources || []).map((s) => `<option value="${escape(s.id)}">${escape(s.name)} · ${s.sessions.toLocaleString()}</option>`).join('');
    $<HTMLSelectElement>('#source').value = sourceID;
    $('#source-filter-icon').innerHTML = sourceIcon(sourceID);
    sessionSearch.setData(data);
    $('#connection-label').textContent = 'Local library';
    $('.connection').classList.add('connected');
    $('.connection').title = `Connected · ${count(data.sessions.length)} sessions`;
    const projectCounts = new Map<string, number>();
    data.sessions.forEach((session) => projectCounts.set(session.projectID, (projectCounts.get(session.projectID) || 0) + 1));
    $<HTMLSelectElement>('#project').innerHTML = '<option value="">All projects</option>' + [...data.projects].filter((p) => projectCounts.has(p.id)).sort((a, b) => (projectCounts.get(b.id) || 0) - (projectCounts.get(a.id) || 0)).map((p) => `<option value="${escape(p.id)}">${escape(p.name)} · ${count(projectCounts.get(p.id) || 0)}</option>`).join('');
    $<HTMLSelectElement>('#project').value = projectID;
    updateDirectories();
    if (selectedID) {
      const selected = data.sessions.find((s) => s.id === selectedID);
      if (selected && selected.created < Date.now() - days * 86400000) days = 0;
    }
    updateFilters(true);
    if (selectedID) selectSession(selectedID);
    else emptyInspector();
    if (data.warnings.length) showToast(data.warnings.join(' '));
    if (data.onboarding) void imports.open(true);
  } catch (error) {
    $('#connection-label').textContent = 'Connection unavailable';
    $('.connection').title = 'Connection unavailable';
    $('.connection').classList.remove('connected');
    $('#graph-message').hidden = false;
    $('#graph-message').innerHTML = `${icon('terminal')}<h3>Local library unavailable</h3><p>${escape(error instanceof Error ? error.message : 'Unable to connect.')}</p><button class="primary-button" id="retry">Retry ${icon('arrow-right')}</button>`;
    $('#retry').addEventListener('click', load);
    if (!data) { $('#session-list').innerHTML = '<p class="empty-list">Your sessions will appear here once connected.</p>'; $('#list-count').textContent = 'Offline'; }
    refreshIcons();
  } finally {
    refresh.disabled = false;
    refresh.classList.remove('spinning');
  }
}

function updateDirectories() {
  const sessions = data?.sessions.filter((s) => !projectID || s.projectID === projectID) || [];
  const dirs = [...new Set(sessions.map((s) => s.directory))].sort((a, b) => directoryLabel(a).localeCompare(directoryLabel(b)));
  const registered = new Set(data?.projects.flatMap((p) => p.worktrees));
  $<HTMLSelectElement>('#directory').innerHTML = '<option value="">All directories</option>' + dirs.map((dir) => `<option value="${escape(dir)}">${registered.has(dir) ? '⑂ ' : ''}${escape(directoryLabel(dir))}</option>`).join('');
  if (!dirs.includes(directory)) directory = '';
  $<HTMLSelectElement>('#directory').value = directory;
}

function updateFilters(fit = false) {
  if (!data) return;
  stopPlayback();
  playback = 1;
  listLimit = 60;
  const now = Date.now();
  const min = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : days ? now - days * 86400000 : 0;
  const max = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : Infinity;
  filtered = data.sessions.filter((s) =>
    (!sourceID || s.source === sourceID) && (!projectID || s.projectID === projectID) && (!directory || s.directory === directory) &&
    (includeChildren || !s.parentID || Boolean(s.forkID)) && (includeArchived || !s.archived) &&
    s.created >= min && s.created <= max,
  );
  sessionSearch.setScope(filtered.map((s) => s.id));
  graph = makeGraph(filtered, data.projects);
  scene?.setCutoff(1);
  scene?.setGraph(graph, fit);
  const message = $('#graph-message');
  message.hidden = Boolean(filtered.length && scene);
  if (!filtered.length) message.innerHTML = `${icon('search')}<h3>No matching sessions</h3><button class="text-button" id="clear-filters">Reset filters ${icon('rotate-ccw')}</button>`;
  else if (!scene) message.innerHTML = `${icon('box')}<h3>WebGL is unavailable.</h3><p>You can explore every session and its file details in the list.</p>`;
  $('#clear-filters')?.addEventListener('click', resetFilters);
  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => button.classList.toggle('active', !fromDate && !toDate && Number(button.dataset.days) === days));
  renderList();
  renderHistogram();
  if (selectedID && !filtered.some((s) => s.id === selectedID)) clearSelection();
  else if (selectedID && selectedDetail) scene?.setFiles(selectedDetail.files);
  refreshIcons();
}

function resetFilters() {
  sourceID = ''; $<HTMLSelectElement>('#source').value = '';
  $('#source-filter-icon').innerHTML = sourceIcon();
  projectID = ''; directory = ''; days = 0; fromDate = ''; toDate = ''; includeChildren = true; includeArchived = true;
  $<HTMLSelectElement>('#project').value = '';
  $<HTMLInputElement>('#children').checked = true;
  $<HTMLInputElement>('#archived').checked = true;
  $<HTMLInputElement>('#from-date').value = '';
  $<HTMLInputElement>('#to-date').value = '';
  updateDirectories();
  updateFilters(true);
}

function renderList() {
  $('#list-count').textContent = count(filtered.length);
  const sorted = [...filtered].sort((a, b) => b.created - a.created);
  const nodeColors = new Map(graph.nodes.map((n) => [n.session.id, n.color]));
  let lastDate = '';
  $('#session-list').innerHTML = sorted.slice(0, listLimit).map((session) => {
    const d = date(session.created);
    const header = d !== lastDate ? `<div class="list-date">${d}<span>${new Date(session.created).getFullYear()}</span></div>` : '';
    lastDate = d;
    return `${header}<button class="session-card ${selectedID === session.id ? 'selected' : ''}" data-session="${escape(session.id)}" aria-pressed="${selectedID === session.id}" title="${escape(session.title)}"><span class="session-dot" style="--node-color:${nodeColors.get(session.id)}"></span><span class="session-card-body"><span class="session-title">${escape(session.title)}</span><span class="session-meta">${session.forkID ? icon('git-fork') : session.parentID ? icon('network') : ''}<span class="source-badge" data-source="${escape(session.source || 'opencode')}">${sourceIcon(session.source)}${escape(sourceName(session.source))}</span><span>${new Date(session.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></span></span></button>`;
  }).join('') + (sorted.length > listLimit ? `<button id="more-sessions" class="load-more">Show more sessions ${icon('chevron-down')}</button>` : !sorted.length ? '<p class="empty-list">No sessions match your filters.</p>' : '');
  $('#more-sessions')?.addEventListener('click', () => { listLimit += 100; const scroll = $('#session-list').scrollTop; renderList(); $('#session-list').scrollTop = scroll; refreshIcons(); });
  refreshIcons();
}

function renderHistogram() {
  const buckets = new Array<number>(70).fill(0);
  const duration = Math.max(1, graph.end - graph.start);
  for (const session of filtered) buckets[Math.min(69, Math.floor((session.created - graph.start) / duration * 70))]++;
  const peak = Math.max(...buckets, 1);
  $('#histogram').innerHTML = buckets.map((n) => `<span style="height:${Math.max(4, n / peak * 100)}%;opacity:${n ? 0.8 : 0.15}" title="${n} sessions"></span>`).join('');
  $('#date-label').textContent = graph.start ? `${date(graph.start)} — ${date(graph.end, true)}` : 'No sessions';
  if (graph.start) {
    $<HTMLInputElement>('#from-date').value = fromDate || inputDate(graph.start);
    $<HTMLInputElement>('#to-date').value = toDate || inputDate(graph.end);
  }
  updateScrubber();
}

function updateScrubber() {
  $<HTMLInputElement>('#scrubber').value = String(Math.round(playback * 1000));
  $('#timeline-cursor').style.left = `${playback * 100}%`;
  $('#histogram').style.setProperty('--progress', `${playback * 100}%`);
  $('#playback-date').textContent = graph.start ? date(graph.start + (graph.end - graph.start) * playback) : '—';
  scene?.setCutoff(playback);
}

function stopPlayback() {
  playing = false;
  scene?.setPlaying(false);
  cancelAnimationFrame(playFrame);
  $('#play').innerHTML = icon('play');
  $('#play').setAttribute('aria-label', 'Play timeline');
  refreshIcons();
}

function animatePlayback(time: number) {
  if (!playing) return;
  const delta = Math.min(time - lastPlayTime, 100);
  lastPlayTime = time;
  if (!document.hidden) playback = Math.min(1, playback + delta / PLAYBACK_DURATION);
  updateScrubber();
  if (playback >= 1) stopPlayback();
  else playFrame = requestAnimationFrame(animatePlayback);
}

function clearSelection() {
  $('#file-legend').hidden = true;
  detailRequest++;
  selectedID = null;
  selectedDetail = undefined;
  scene?.select(null);
  history.replaceState(null, '', location.pathname);
  emptyInspector();
  renderList();
}

function relationHTML(session: Session): string {
  const parents = session.forkID ? [{ id: session.forkID, label: 'Forked from', kind: 'git-fork' }] : session.parentID ? [{ id: session.parentID, label: 'Parent', kind: 'network' }] : [];
  const children = data!.sessions.filter((s) => s.forkID === session.id || (!s.forkID && s.parentID === session.id));
  const related = [...parents, ...children.map((s) => ({ id: s.id, label: s.forkID ? 'Fork' : 'Child', kind: s.forkID ? 'git-fork' : 'network' }))];
  return related.length ? `<section class="detail-section"><div class="section-label">Connections<span>${related.length}</span></div>${related.map((r) => {
    const relatedSession = data!.sessions.find((s) => s.id === r.id);
    return `<button class="relation" data-related="${escape(r.id)}" ${!relatedSession ? 'disabled' : ''}>${icon(r.kind)}<span><small>${r.label}</small><strong>${escape(relatedSession?.title || 'Session no longer available')}</strong></span>${icon('arrow-up-right')}</button>`;
  }).join('')}</section>` : '';
}

function renderInspector(session: Session) {
  const project = data!.projects.find((p) => p.id === session.projectID);
  const kind = session.forkID ? 'Fork' : session.parentID ? 'Child session' : 'Session';
  const isWorktree = project?.worktrees.includes(session.directory);
  $('#inspector').innerHTML = `
    <div class="panel-heading"><button class="panel-handle" data-drag-panel="inspector" aria-label="Move session details panel" title="Drag to move · Arrow keys to reposition">${icon('grip')}<span>${kind}</span></button><button id="close-inspector" class="icon-button" aria-label="Close session details">${icon('x')}</button></div>
    <div class="detail-scroll">
      <div class="detail-title"><span class="source-badge" data-source="${escape(session.source || 'opencode')}">${sourceIcon(session.source)}${escape(sourceName(session.source))}</span><h2>${escape(session.title)}</h2><span class="detail-date">${timestamp(session.created)}</span></div>
      <div class="detail-actions"><button id="open-session" class="secondary-button">${icon('arrow-up-right')}Open session</button><button id="focus-session" class="icon-button" title="Focus node" aria-label="Focus node">${icon('crosshair')}</button><button id="copy-id" class="icon-button" title="Copy session ID" aria-label="Copy session ID">${icon('copy')}</button></div>
      <div id="file-detail"><section class="detail-section"><div class="section-label">Changed files</div><div class="detail-loading">${icon('loader-circle', 'spinning')}Loading changes…</div></section></div>
      ${relationHTML(session)}
      <details class="more-details detail-section"><summary>Session info ${icon('chevron-down')}</summary><dl class="metadata"><div><dt>Project</dt><dd>${escape(project?.name || 'Unknown')}</dd></div><div><dt>Model</dt><dd>${escape(session.model)}</dd></div><div><dt>Agent</dt><dd>${escape(session.agent || 'Unknown')}</dd></div><div><dt>Tokens incl. cache</dt><dd>${session.tokens === null ? 'Not recorded' : compact(session.tokens)}</dd></div><div><dt>Recorded cost</dt><dd>${session.cost === null ? 'Not recorded' : `$${session.cost.toFixed(2)}`}</dd></div><div><dt>Updated</dt><dd>${date(session.updated)}</dd></div><div><dt>Imported</dt><dd>${session.coverage?.importedAt ? date(session.coverage.importedAt) : 'Pending'}</dd></div></dl><div class="directory-card"><span>${isWorktree ? 'Worktree' : 'Directory'}</span><code>${escape(session.directory)}</code></div></details>
    </div>
  `;
  $('#toggle-inspector').hidden = false;
  setPanel('inspector', true);
  $('#close-inspector').addEventListener('click', () => { setPanel('inspector', false); $('#toggle-inspector').focus(); });
  $('#focus-session').addEventListener('click', () => { stopPlayback(); scene?.focus(session.id); });
  $('#open-session').addEventListener('click', () => void launcher.open(session));
  $('#copy-id').addEventListener('click', async () => { try { await navigator.clipboard.writeText(session.nativeID || session.id); showToast('Session ID copied'); } catch { showToast(session.nativeID || session.id); } });
  refreshIcons();
}

function mergeDetail(previous: SessionDetail, next: SessionDetail): SessionDetail {
  const files = new Map(previous.files.map((file) => [file.path, { ...file }]));
  for (const file of next.files) {
    const existing = files.get(file.path);
    files.set(file.path, { ...file, steps: (existing?.steps || 0) + file.steps, source: existing?.source === 'snapshot' ? 'snapshot' : file.source });
  }
  const tools = new Map(previous.tools.map((tool) => [tool.name, tool.count]));
  next.tools.forEach((tool) => tools.set(tool.name, (tools.get(tool.name) || 0) + tool.count));
  return { ...next, files: [...files.values()].sort((a, b) => b.steps - a.steps || a.path.localeCompare(b.path)), tools: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), locations: [...previous.locations, ...next.locations], messagesScanned: previous.messagesScanned + next.messagesScanned, snapshotSteps: previous.snapshotSteps + next.snapshotSteps };
}

function renderDetail(detail: SessionDetail) {
  const files = detail.files;
  $('#file-legend').hidden = !files.length;
  $('#file-detail').innerHTML = `
    <section class="detail-section"><div class="section-label">Changed files<span>${count(files.length)}${detail.partial ? '+' : ''}</span></div>
    ${files.length ? `<ul class="file-list">${files.map((file) => `<li title="${escape(file.path)} · ${file.source}">${icon('file-code-2')}<div><strong>${escape(directoryLabel(file.path))}</strong>${file.path.includes('/') ? `<span>${escape(file.path.slice(0, file.path.lastIndexOf('/')))}</span>` : ''}</div><small>${file.steps}×</small></li>`).join('')}</ul>` : `<div class="no-files"><p>No file changes found.</p></div>`}
     <p class="coverage-note">${count(detail.messagesScanned)} messages · ${detail.partial ? 'Partial history' : 'Imported history'}${!detail.snapshotSteps ? '<br>No snapshots; recorded tool/file-change evidence only.' : ''}${files.length > 80 ? '<br>80 files shown on the map.' : ''}</p>
    ${detail.note ? `<p class="coverage-note">${escape(detail.note)}</p>` : ''}
    ${detail.nextCursor ? `<button id="load-earlier" class="load-more">Load earlier messages ${icon('arrow-right')}</button>` : ''}</section>
    ${detail.locations.length ? `<details class="more-details detail-section"><summary>Directory moves ${icon('chevron-down')}</summary>${detail.locations.map((l) => `<div class="location-entry"><span>${timestamp(l.time)}</span><code>${escape(l.directory)}</code></div>`).join('')}</details>` : ''}
    ${detail.tools.length ? `<details class="more-details detail-section"><summary>Tools used <span>${count(detail.tools.reduce((sum, t) => sum + t.count, 0))}</span>${icon('chevron-down')}</summary><div class="tools-list">${detail.tools.slice(0, 12).map((tool) => `<div><span>${escape(tool.name)}</span><strong>${tool.count}</strong></div>`).join('')}</div></details>` : ''}
  `;
  $('#load-earlier')?.addEventListener('click', () => loadFiles(detail.id, detail.nextCursor || undefined));
  scene?.setFiles(files);
  refreshIcons();
}

async function loadFiles(id: string, cursor?: string) {
  const request = ++detailRequest;
  const earlier = $<HTMLButtonElement>('#load-earlier');
  if (earlier) { earlier.disabled = true; earlier.textContent = 'Scanning earlier messages…'; }
  try {
    const result = await fetchJSON<SessionDetail>(`/api/atlas/session/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (request !== detailRequest || selectedID !== id) return;
    selectedDetail = cursor && selectedDetail ? mergeDetail(selectedDetail, result) : result;
    renderDetail(selectedDetail);
  } catch (error) {
    if (request !== detailRequest || selectedID !== id) return;
    if (selectedDetail) { renderDetail(selectedDetail); showToast('Could not load earlier history. Try again.'); }
    else {
      $('#file-detail').innerHTML = `<section class="detail-section"><div class="section-label">Changed files</div><p class="coverage-note">${escape(error instanceof Error ? error.message : 'Details unavailable.')}</p><button class="load-more" id="retry-detail">Retry file details</button></section>`;
      $('#retry-detail').addEventListener('click', () => loadFiles(id));
    }
  }
}

function selectSession(id: string) {
  const session = data?.sessions.find((s) => s.id === id);
  if (!session) return;
  if (!filtered.some((s) => s.id === id)) resetFilters();
  stopPlayback();
  playback = 1;
  updateScrubber();
  selectedID = id;
  selectedDetail = undefined;
  $('#file-legend').hidden = true;
  history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
  scene?.select(id);
  renderInspector(session);
  renderList();
  void loadFiles(id);
}

$('#session-list').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-session]');
  if (button?.dataset.session) selectSession(button.dataset.session);
});
$('#inspector').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-related]');
  if (button?.dataset.related) { selectSession(button.dataset.related); scene?.focus(button.dataset.related); }
});
$('#project').addEventListener('change', (event) => { projectID = (event.target as HTMLSelectElement).value; directory = ''; updateDirectories(); updateFilters(true); });
$('#source').addEventListener('change', (event) => { sourceID = (event.target as HTMLSelectElement).value; $('#source-filter-icon').innerHTML = sourceIcon(sourceID); updateFilters(true); });
$('#directory').addEventListener('change', (event) => { directory = (event.target as HTMLSelectElement).value; updateFilters(true); });
$('#children').addEventListener('change', (event) => { includeChildren = (event.target as HTMLInputElement).checked; updateFilters(); });
$('#archived').addEventListener('change', (event) => { includeArchived = (event.target as HTMLInputElement).checked; updateFilters(); });
document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => button.addEventListener('click', () => { days = Number(button.dataset.days); fromDate = ''; toDate = ''; updateFilters(true); }));
$('#apply-dates').addEventListener('click', () => {
  const from = $<HTMLInputElement>('#from-date').value, to = $<HTMLInputElement>('#to-date').value;
  if (!from || !to || from > to) return showToast('Choose a valid date range, with From before To.');
  fromDate = from; toDate = to; updateFilters(true);
  $<HTMLDetailsElement>('.custom-dates').open = false;
});
$('#reset-camera').addEventListener('click', () => { stopPlayback(); scene?.reset(); });
$('#refresh').addEventListener('click', () => { if (data?.onboarding) void imports.open(true); else void imports.refresh(); });
$('#scrubber').addEventListener('input', (event) => { stopPlayback(); playback = Number((event.target as HTMLInputElement).value) / 1000; updateScrubber(); });
$('#play').addEventListener('click', () => {
  if (!filtered.length) return;
  if (playing) return stopPlayback();
  if (playback >= 1) playback = 0;
  updateScrubber();
  playing = true;
  scene?.setPlaying(true);
  lastPlayTime = performance.now();
  $('#play').innerHTML = icon('pause');
  $('#play').setAttribute('aria-label', 'Pause timeline');
  refreshIcons();
  playFrame = requestAnimationFrame(animatePlayback);
});
for (const flat of [false, true]) $(`#view-${flat ? '2d' : '3d'}`).addEventListener('click', () => {
  scene?.setFlat(flat);
  for (const value of [false, true]) { const button = $(`#view-${value ? '2d' : '3d'}`); button.classList.toggle('active', value === flat); button.setAttribute('aria-pressed', String(value === flat)); }
});
let motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
$('#motion').setAttribute('aria-pressed', String(motion));
$('#motion').addEventListener('click', () => { motion = !motion; scene?.setMotion(motion); $('#motion').setAttribute('aria-pressed', String(motion)); });
$('#help').addEventListener('click', () => { $<HTMLDialogElement>('#help-dialog').showModal(); modalVisibility(); });
$('#help-dialog').addEventListener('close', modalVisibility);
$('#close-help').addEventListener('click', () => $<HTMLDialogElement>('#help-dialog').close());
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') {
    if (selectedID) clearSelection();
    else setPanel('explorer', false);
    return;
  }
  if ((event.target as HTMLElement).matches('input, select, textarea') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === 'f') { stopPlayback(); scene?.reset(); }
  if (event.key.toLowerCase() === 'h') {
    const visible = (['explorer', 'timeline', 'inspector'] as const).filter((id) => !$(`#${id}`).hidden);
    if (visible.length) { hiddenPanels = visible; visible.forEach((id) => setPanel(id, false)); }
    else { (hiddenPanels.length ? hiddenPanels : ['explorer', 'timeline'] as PanelID[]).forEach((id) => { if (id !== 'inspector' || selectedID) setPanel(id, true); }); }
  }
});

void load().then(() => { if (data?.importing) imports.resume(); });
if (import.meta.env.DEV) Object.assign(window, { atlasDiagnostics: () => scene?.diagnostics(), atlasSearchDiagnostics: sessionSearch.diagnostics });
if (import.meta.hot) import.meta.hot.dispose(() => { scene?.dispose(); sessionSearch.dispose(); launcher.dispose(); imports.dispose(); disposePanelDragging(); cancelAnimationFrame(playFrame); });
