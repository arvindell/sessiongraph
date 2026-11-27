import { icon, type IconName } from '@sessiongraph/core/icons';
import { graphButton, graphHelp, sessionInfo, shortcutHints, soundButton } from '@sessiongraph/core/graph-ui';
import type { TimelineScene } from '@sessiongraph/core/scene';
import { directoryLabel, makeGraph, sessionEnd } from '@sessiongraph/core/layout';
import { createSessionSearch } from './search/ui';
import { VirtualList } from '@sessiongraph/core/virtual-list';
import { createSessionLauncher } from './launcher';
import { createImports } from './imports';
import { AutoImportScheduler, AUTO_IMPORT_INTERVAL } from './auto-import';
import { LibrarySettingsSaver, type LibrarySettingsPatch } from './library-settings';
import { DEFAULT_VIEW_STATE, normalizeViewState, viewDateBounds, type ViewState } from '@sessiongraph/core/view-state';
import { playbackTokens } from './playback-tokens';
import { PLAYBACK_DURATION, PLAYBACK_ORBIT_DURATION, PLAYBACK_END_HOLD, playbackDate, playbackSessions, timelineBuckets } from '@sessiongraph/core/playback';
import { playbackControls } from '@sessiongraph/core/playback-controls';
import { sourceName, sourceIcon } from '@sessiongraph/core/sources';
import { sessionMatchesSource } from './session-links';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences, normalizePreferences, motionEnabled, PREFERENCES_KEY, type Preferences } from '@sessiongraph/core/preferences';
import { createSettings } from './settings';
import { InteractionAudio } from '@sessiongraph/core/audio';
import { createEventExplorer } from './event-explorer';
import { createEventHover } from './event-hover';
import { showCommitHistory } from './commit-history';
import { isTauri } from '@tauri-apps/api/core';
import { openDesktopUrl } from './external-links';
import { TimelineClient } from './timeline-client';
import { createDesktopUpdater } from './updater';
import { createDateRange } from './date-range';
import { observeSelects, refreshSelects } from './controls';
import { createPublishing } from './publishing';
import { preloadPublishingAccount } from './publishing-account';
import type { TimelineMarkers } from '@sessiongraph/core/timeline';
import type { SessionGraphData, Graph, Session, SessionDetail } from '@sessiongraph/core/types';
import './style.css';
import './publishing.css';

const publishingAccount = preloadPublishingAccount();
const refreshIcons = () => refreshSelects();
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const compact = (value: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const count = (value: number) => value.toLocaleString('en');
const dates = [new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }), new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' })];
const timestamps = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const date = (value: number, year = false) => dates[Number(year)].format(value);
const timestamp = (value: number) => timestamps.format(value);
const inputDate = (value: number) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let data: SessionGraphData | undefined;
let graph: Graph = { nodes: [], edges: [], lanes: [], start: 0, end: 0 };
let filtered: Session[] = [];
let sortedSessions: Session[] = [], filteredIDs = new Set<string>(), sessionsByID = new Map<string, Session>();
let sessionRows = new Map<string, number>(), nodeColors = new Map<string, string>();
let scene: TimelineScene | undefined;
let sceneLoading = true;
let tooltipSession: Session | undefined;
let selectedID: string | null = new URLSearchParams(location.search).get('session');
let selectedDetail: SessionDetail | undefined;
let selectedTimeline: TimelineMarkers | undefined;
let timelineRequest = 0;
let projectID = '';
let sourceID = '';
let directory = '';
let days: ViewState['days'] = DEFAULT_VIEW_STATE.days;
let fromDate = '';
let toDate = '';
let includeChildren = true;
let includeArchived = false;
let detailRequest = 0;
let detailController: AbortController | undefined, timelineController: AbortController | undefined;
let playFrame = 0;
let playing = false;
let playback = 1;
let lastPlayTime = 0;
let playbackOutroTime = 0;
let tokenPlayback = playbackTokens([]), tokenDisplay = '';
let sessionPlayback = playbackSessions([]);
let playbackPanels: { explorer: boolean; inspector: boolean } | undefined;
let playbackShare: ReturnType<typeof import('./share').createPlaybackShare> | undefined;
let publishingDialog: ReturnType<typeof createPublishing> | undefined;
let shareRevealTimer = 0, shareReady = false;
let preferences: Preferences = { ...DEFAULT_PREFERENCES }, preferencesSaved = true;
let autoImport: AutoImportScheduler | undefined;
let settingsSaver: LibrarySettingsSaver | undefined;
let settingsHydrated = false, viewFingerprint = '';
try { preferences = loadPreferences(localStorage); } catch { preferencesSaved = false; }
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

$('#app').innerHTML = `
  <main class="map" aria-label="Session map">
    <h1 class="sr-only">SessionGraph — Explore &amp; visualize all your LLM sessions</h1>
    <div id="scene"></div>
    <div class="canvas-vignette"></div>
    <div id="graph-message" class="graph-message"><div class="loading-orbit"><span></span><span></span><span></span></div><h3>Loading sessions…</h3></div>
    <div id="tooltip" class="node-tooltip" hidden></div>
  </main>
  <header class="app-header glass">
    <a class="brand" href="/" aria-label="SessionGraph home" title="Explore &amp; visualize all your LLM sessions"><img src="/brand/mark.svg" alt=""/><span>SessionGraph</span></a>
    <span class="connection" role="status" title="Connecting"><span class="status-dot"></span><span id="connection-label" class="sr-only">Connecting</span></span>
    <span class="toolbar-divider"></span>
    ${graphButton('search', 'Toggle sessions', { id: 'toggle-explorer', 'aria-controls': 'explorer', 'aria-expanded': 'true' }, 'Sessions', 'Sessions')}
  </header>
  <nav class="map-controls glass" aria-label="Map controls">
    ${graphButton('center-focus', 'Fit view', { id: 'reset-camera' }, 'Fit view (F)')}
    ${graphButton('clock', 'Toggle timeline', { id: 'toggle-timeline', 'aria-controls': 'timeline', 'aria-expanded': 'true' }, 'Timeline')}
    ${graphButton('panel-right', 'Toggle session details', { id: 'toggle-inspector', 'aria-controls': 'inspector', 'aria-expanded': 'false', hidden: true }, 'Session details')}
    ${graphButton('circle-help', 'Help', { id: 'help', 'aria-haspopup': 'dialog' })}
    ${graphButton('volume-2', 'Mute sound', { id: 'mute-audio', 'aria-pressed': 'false', 'data-sound': 'none' })}
    ${graphButton('settings-2', 'Settings', { id: 'open-settings', 'aria-haspopup': 'dialog' })}
    ${graphButton('share-2', 'Share SessionGraph', { id: 'open-publishing', 'aria-haspopup': 'dialog' })}
  </nav>
  <aside class="sidebar floating-panel glass" id="explorer" aria-label="Sessions">
      <div class="panel-heading"><h2 class="panel-title">Sessions <span class="small-badge" id="list-count">—</span></h2><button class="icon-button" id="refresh" aria-label="Refresh sessions" title="Refresh sessions">${icon('refresh-cw')}</button><button class="icon-button" id="close-explorer" aria-label="Close sessions">${icon('x')}</button></div>
      <button class="search-box search-trigger" id="search" aria-label="Search all sessions">${icon('search')}<span>Search everything…</span><kbd>/</kbd></button>
      <div class="filters">
        <div class="filter-row"><div class="select-wrap"><select id="source" data-source-icons="/sources" aria-label="Session source"><option value="">All sources</option></select>${icon('chevron-down')}</div><button class="icon-button" id="manage-sources" aria-label="Manage sources" title="Import sources">${icon('sliders-horizontal')}</button></div>
        <div class="select-wrap">${icon('folder')}<select id="project" aria-label="Project"><option value="">All projects</option></select>${icon('chevron-down')}</div>
        <div class="select-wrap">${icon('git-branch')}<select id="directory" aria-label="Worktree or directory"><option value="">All directories</option></select>${icon('chevron-down')}</div>
        <div class="filter-toggles"><label><input type="checkbox" id="children" checked/><span>Subagent sessions</span></label></div>
      </div>
      <nav class="session-list" id="session-list" aria-label="Sessions"><div class="list-loading">${[0, 1, 2, 3, 4].map(() => '<div class="skeleton"></div>').join('')}</div></nav>
  </aside>
  <div class="inspector-stack floating-panel" id="inspector" hidden><aside class="inspector glass" id="session-inspector" aria-label="Session details"></aside></div>
  <div class="timeline-dock floating-panel" id="timeline">
    <div class="playback-share"><button id="share-playback" class="primary-button" disabled>${icon('share-2')}Share SessionGraph</button></div>
    <section class="timeline-panel glass timeline-controls" aria-label="Timeline controls">
    ${playbackControls(`<span class="panel-title" id="date-label">Timeline</span><div class="range-buttons" role="group" aria-label="Date range"><button data-days="7">7D</button><button data-days="30">30D</button><button data-days="90">90D</button><button data-days="ytd" class="active" title="Year to date" aria-pressed="true">YTD</button><button data-days="0">All</button></div><div class="custom-dates"></div><button class="icon-button" id="close-timeline" aria-label="Close timeline">${icon('x')}</button>`, { play: 'play', histogram: 'histogram', scrubber: 'scrubber', cursor: 'timeline-cursor', date: 'playback-date', period: 'playback-period', summary: 'playback-summary', sessions: 'playback-sessions', tokens: 'playback-tokens' }, { showCoverage: false })}
    </section>
  </div>
  ${graphHelp('help-dialog', ['search', 'fit', 'panels', 'clear'], `
    <div class="graph-legend"><span><i class="legend-node"></i>Session orb</span><span><i class="legend-node message"></i>Message</span><span><i class="legend-line lane"></i>Session lifetime</span><span><i class="legend-line fork"></i>Fork</span><span><i class="legend-line child"></i>Child</span><span id="file-legend" hidden><i class="legend-file"></i>File</span></div>
    <p>Search also opens with ⌘/Ctrl K. Each trail follows a session to its latest saved message. Only fork and child links represent ancestry.</p>`)}
  <div id="toast" class="toast" role="status" hidden></div>
  ${shortcutHints(['search', 'fit', 'panels', 'clear'], 'shortcut-hints')}
`;
refreshIcons();
type SessionRow = { session: Session } | { label: string; year: number };
const sessionList = new VirtualList<SessionRow>($('#session-list'), {
  key: row => 'session' in row ? `session:${row.session.id}` : `date:${row.year}:${row.label}`,
  estimate: row => 'session' in row ? preferences.density === 'compact' ? 66 : 76 : 42,
  render: row => {
    const element = document.createElement('template');
    if ('session' in row) {
      const session = row.session, end = sessionEnd(session);
      element.innerHTML = `<button class="session-card ${selectedID === session.id ? 'selected' : ''}" data-session="${escape(session.id)}" aria-pressed="${selectedID === session.id}" title="${escape(session.title)}"><span class="session-dot" style="--node-color:${nodeColors.get(session.id)}"></span><span class="session-card-body"><span class="session-title">${escape(session.title)}</span><span class="session-meta">${session.forkID ? icon('git-fork') : session.parentID ? icon('network') : ''}<span class="source-badge" data-source="${escape(session.source || 'opencode')}">${sourceIcon(session.source)}${escape(sourceName(session.source))}</span><span title="${session.activity?.lastMessageAt ? 'Latest saved message' : 'Session created; message time unavailable'}">${clock.format(end)}</span></span></span></button>`;
    } else element.innerHTML = `<div class="list-date">${row.label}<span>${row.year}</span></div>`;
    return element.content.firstElementChild as HTMLElement;
  },
});
const desktopUpdater = createDesktopUpdater();
const disposeSelects = observeSelects();
const dateRange = createDateRange($('.custom-dates'), (from, to) => { days = 0; fromDate = from; toDate = to; updateFilters(true); }, stopPlayback);
const modalVisibility = () => { const open = Boolean(document.querySelector('dialog[open]')); if (open && playing) stopPlayback(); scene?.setSuspended(open); };
const timelineClient = new TimelineClient();
const eventHover = createEventHover($('#tooltip'), $('#scene'), timelineClient);
let disposeCommitHistory: (() => void) | undefined;
const eventExplorer = createEventExplorer($('#inspector'), timelineClient, { select: (item) => {
  const onMap = item?.sessionID === selectedID ? item : null;
  eventHover.clear(); scene?.selectEvent(onMap?.id || null);
  // A message request started before playback may finish while its panel is hidden.
  if (onMap && !playing) { playback = 1; updateScrubber(); scene?.focusEvent(selectedTimeline?.items.find(marker => marker.id === onMap.id) || onMap); }
} });
function openEvents(item?: string) {
  const session = data?.sessions.find((s) => s.id === selectedID);
  if (session) { eventHover.clear(); stopPlayback(); setPanel('inspector', true); eventExplorer.open(session, item, item ? selectedTimeline?.revision : undefined, selectedTimeline?.items.find(marker => marker.id === item)?.kind === 'commit' ? 'tools' : 'messages'); }
}
const settings = createSettings({ publishing: openPublishing, change: changePreferences, getArchived: () => includeArchived, changeArchived: (value) => { includeArchived = value; updateFilters(); }, visibility: modalVisibility, previewSound: () => { void audio.play('select'); }, getSources: () => imports.sources(), importSources: (ids) => imports.select(ids) });
const audio = new InteractionAudio(preferences, settings.audioStatus);
function applyPreferences() {
  scene?.applyPreferences(preferences); audio.configure(preferences);
  const densityChanged = document.documentElement.dataset.density !== preferences.density;
  document.documentElement.dataset.density = preferences.density;
  if (densityChanged) sessionList.resetHeights();
  document.documentElement.dataset.motion = String(motionEnabled(preferences, reducedMotion.matches));
  document.documentElement.style.setProperty('--panel-opacity', `${preferences.panelOpacity}%`);
  const mute = $('#mute-audio'), sound = soundButton(preferences.muted); mute.setAttribute('aria-pressed', String(preferences.muted)); mute.setAttribute('aria-label', sound.label); mute.title = sound.label; mute.innerHTML = icon(sound.glyph);
  settings.render(preferences, preferencesSaved || settingsHydrated, settingsSaver?.state || 'saved'); refreshIcons();
}
function changePreferences(patch: Partial<Preferences>) {
  const changedImport = patch.autoImport !== undefined && patch.autoImport !== preferences.autoImport;
  preferences = normalizePreferences({ ...preferences, ...patch });
  try { preferencesSaved = savePreferences(localStorage, preferences); } catch { preferencesSaved = false; }
  applyPreferences();
  if (data && preferences.grouping !== graphGrouping) updateFilters(true);
  saveLibrarySettings({ preferences: { ...preferences }, ...(changedImport ? { autoImport: preferences.autoImport } : {}) });
}
function saveLibrarySettings(patch: LibrarySettingsPatch) { settingsSaver?.save(patch); }
function currentView(): ViewState { return { sourceID, projectID, directory, days, fromDate, toDate, includeChildren, includeArchived }; }
$('#open-settings').addEventListener('click', () => settings.open());
$('#mute-audio').addEventListener('click', () => changePreferences({ muted: !preferences.muted }));
const onSystemMotion = () => applyPreferences(); reducedMotion.addEventListener('change', onSystemMotion);
const onPreferencesStorage = (event: StorageEvent) => { if (event.key === PREFERENCES_KEY) { try { preferences = { ...loadPreferences(localStorage), autoImport: preferences.autoImport }; applyPreferences(); if (data && preferences.grouping !== graphGrouping) updateFilters(true); } catch {} } };
window.addEventListener('storage', onPreferencesStorage);
applyPreferences();
settingsSaver = new LibrarySettingsSaver(async (patch) => {
  const response = await fetch('/api/sessiongraph/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'settings' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(15_000), keepalive: true });
  if (!response.ok) throw new Error('Could not save library settings.');
}, (state) => {
  settings.render(preferences, preferencesSaved || settingsHydrated, state);
  if (state === 'error') showToast('Changes applied, but could not save to the local library. Retrying when you return.');
  if (state === 'saved') void autoImport?.check();
});
const launcher = createSessionLauncher(modalVisibility);
const imports = createImports((background) => load(background), modalVisibility, showToast);
autoImport = new AutoImportScheduler({
  eligible: () => preferences.autoImport && !settingsSaver?.pending && document.visibilityState === 'visible' && Boolean(data && !data.onboarding && data.sources?.some((source) => source.selected)),
  busy: () => imports.busy || Boolean(document.querySelector('dialog[open]')),
  refresh: () => imports.refresh(true),
});
const autoImportEvents = new AbortController();
const checkAutoImport = () => { if (document.visibilityState === 'visible') { if (settingsSaver?.state === 'error') void settingsSaver.flush(); void autoImport?.check(); } };
window.addEventListener('focus', checkAutoImport, { signal: autoImportEvents.signal });
document.addEventListener('visibilitychange', checkAutoImport, { signal: autoImportEvents.signal });
const autoImportTimer = window.setInterval(checkAutoImport, AUTO_IMPORT_INTERVAL);
$('#manage-sources').addEventListener('click', () => settings.open('sources'));
document.addEventListener('sessiongraph-import-status', (event) => {
  const status = (event as CustomEvent<import('@sessiongraph/core/types').ImportStatus>).detail;
  autoImport?.activity();
  settings.importStatus(status);
  if (data) data.importing = status.running;
  if (!filtered.length) renderGraphMessage();
  $('#refresh').classList.toggle('spinning', status.running);
  $('.connection').title = status.running ? `Importing ${sourceName(status.source)} · ${status.imported} sessions saved` : status.failed ? 'Import unavailable · open Manage sources for details' : 'Local library · SQLite';
}, { signal: autoImportEvents.signal });
const sessionSearch = createSessionSearch(selectSession, modalVisibility, (session) => void launcher.open(session));
$('#search').addEventListener('click', sessionSearch.open);

type PanelID = 'explorer' | 'timeline' | 'inspector';
function setPanel(id: PanelID, visible: boolean) {
  if (playing && (id === 'timeline' ? !visible : visible)) stopPlayback();
  const panel = $(`#${id}`);
  panel.hidden = !visible;
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

function showToast(text: string) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  window.setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

function emptyInspector() {
  disposeCommitHistory?.();
  setPanel('inspector', false);
  eventExplorer.close(); eventHover.clear(); $('#session-inspector').replaceChildren();
  $('#toggle-inspector').hidden = true;
}
emptyInspector();

async function initializeScene() { try {
  const { TimelineScene } = await import('@sessiongraph/core/scene');
  scene = new TimelineScene($('#scene'), {
    onSelect: (id) => { if (id) { void audio.play('select'); selectSession(id); } else clearSelection(); },
    onPlaybackInterrupt: stopPlayback,
    onEvent: (id) => { void audio.play('select'); openEvents(id); },
    onEventHover: (item, overlapping, x, y) => {
      tooltipSession = undefined;
      if (item && selectedID && selectedTimeline) eventHover.show(item, selectedID, selectedTimeline.revision, overlapping, x, y);
      else eventHover.clear();
    },
    onHover: (node, x, y) => {
      const tooltip = $('#tooltip');
      if (tooltip.classList.contains('message-tooltip')) { eventHover.clear(); tooltipSession = undefined; }
      if (tooltip.hidden !== !node) tooltip.hidden = !node;
      if (!node) return;
      if (tooltipSession !== node.session) {
        tooltipSession = node.session;
        tooltip.innerHTML = `<strong>${escape(node.session.title)}</strong><span>${escape(sourceName(node.session.source))} · ${node.session.activity?.lastMessageAt ? `Last message ${timestamp(node.session.activity.lastMessageAt)}` : 'Message time unavailable'}<br>Started ${timestamp(node.session.created)}</span>`;
      }
      tooltip.style.left = `${Math.min(x + 18, $('#scene').clientWidth - 280)}px`;
      tooltip.style.top = `${Math.max(8, Math.min(y - 32, $('#scene').clientHeight - 110))}px`;
    },
  }, { panels: [$('#explorer'), $('#inspector'), $('#timeline')] });
  scene.applyPreferences(preferences);
  scene.setSuspended(Boolean(document.querySelector('dialog[open]')));
  if (data) {
    scene.setGraph(graph, true);
    if (selectedID) { scene.select(selectedID); scene.focus(selectedID); }
    if (selectedDetail) scene.setFiles(selectedDetail.files);
    if (selectedTimeline) scene.setEvents(selectedTimeline.items);
  }
} catch (error) {
  console.error('[sessiongraph] Graphics initialization failed', error);
  showToast('3D requires WebGL. You can still browse sessions in the list.');
} finally { sceneLoading = false; if (data) renderGraphMessage(); } }
$('#scene').addEventListener('scene-error', (event) => showToast((event as CustomEvent<string>).detail));

async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(180_000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result as T;
}

async function load(background = false) {
  const refresh = $<HTMLButtonElement>('#refresh');
  refresh.disabled = true;
  refresh.classList.add('spinning');
  try {
    const preferenceRevision = settingsSaver?.revision;
    const next = await fetchJSON<SessionGraphData>('/api/sessiongraph');
    const previous = data, previousSelected = selectedID ? sessionsByID.get(selectedID) : undefined;
    const preserve = Boolean(previous && graph.nodes.length);
    data = next;
    if (!settingsSaver?.pending && preferenceRevision === settingsSaver?.revision) {
      preferences = { ...normalizePreferences(next.preferences || preferences), autoImport: next.autoImport === true };
      try { preferencesSaved = savePreferences(localStorage, preferences); } catch { preferencesSaved = false; }
      if (!settingsHydrated) {
        const view = normalizeViewState(next.viewState);
        ({ sourceID, projectID, directory, days, fromDate, toDate, includeChildren, includeArchived } = view);
        $<HTMLInputElement>('#children').checked = includeChildren;
        viewFingerprint = JSON.stringify(view);
        if (!next.preferences) saveLibrarySettings({ preferences: { ...preferences } });
      }
      applyPreferences();
    }
    settingsHydrated = true;
    // Status and source timestamps can change without changing the visible graph.
    $('#connection-label').textContent = 'Local library';
    $('.connection').classList.add('connected');
    $('.connection').title = `Connected · ${count(data.sessions.length)} sessions`;
    if (previous && preferences.grouping === graphGrouping && JSON.stringify(previous.sessions) === JSON.stringify(next.sessions) && JSON.stringify(previous.projects) === JSON.stringify(next.projects)) { renderGraphMessage(); return; }
    timelineClient.clear();
    sessionsByID = new Map(data.sessions.map((session) => [session.id, session]));
    $<HTMLSelectElement>('#source').innerHTML = '<option value="">All sources</option>' + (data.sources || []).map((s) => `<option value="${escape(s.id)}">${escape(s.name)} · ${s.sessions.toLocaleString()}</option>`).join('');
    $<HTMLSelectElement>('#source').value = sourceID;
    sessionSearch.setData(data);
    const projectCounts = new Map<string, number>();
    data.sessions.forEach((session) => projectCounts.set(session.projectID, (projectCounts.get(session.projectID) || 0) + 1));
    $<HTMLSelectElement>('#project').innerHTML = '<option value="">All projects</option>' + [...data.projects].filter((p) => projectCounts.has(p.id)).sort((a, b) => (projectCounts.get(b.id) || 0) - (projectCounts.get(a.id) || 0)).map((p) => `<option value="${escape(p.id)}">${escape(p.name)} · ${count(projectCounts.get(p.id) || 0)}</option>`).join('');
    $<HTMLSelectElement>('#project').value = projectID;
    updateDirectories();
    if (selectedID && !previous) {
      const selected = data.sessions.find((s) => s.id === selectedID);
      const { min, max } = viewDateBounds(currentView());
      if (selected && (selected.created < min || selected.created > max)) { days = 0; fromDate = ''; toDate = ''; }
      if (selected?.archived) includeArchived = true;
    }
    updateFilters(!preserve, preserve);
    if (selectedID && !previous) selectSession(selectedID);
    else if (selectedID) {
      const selected = sessionsByID.get(selectedID);
      if (selected && JSON.stringify(previousSelected) !== JSON.stringify(selected)) {
        const scroll = $('.detail-scroll')?.scrollTop || 0;
        selectedDetail = undefined; selectedTimeline = undefined;
        renderInspector(selected, false); $('.detail-scroll').scrollTop = scroll;
        void loadFiles(selected.id); void loadTimeline(selected);
      }
    }
    else emptyInspector();
    if (!background && data.warnings.length) showToast(data.warnings.join(' '));
    if (!background && data.onboarding) void imports.open(true);
  } catch (error) {
    if (background && data) { $('.connection').title = 'Library refresh unavailable · retry with Refresh sessions'; return; }
    $('#connection-label').textContent = 'Connection unavailable';
    $('.connection').title = 'Connection unavailable';
    $('.connection').classList.remove('connected');
    $('#graph-message').hidden = false;
    $('#graph-message').innerHTML = `${icon('terminal')}<h3>Local library unavailable</h3><p>${escape(error instanceof Error ? error.message : 'Unable to connect.')}</p><button class="primary-button" id="retry">Retry ${icon('arrow-right')}</button>`;
    $('#retry').addEventListener('click', () => { void load().then(checkAutoImport); });
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

let graphGrouping: Preferences['grouping'] | undefined;
function updateFilters(fit = false, preserve = false) {
  if (!data) return;
  if (graphGrouping !== preferences.grouping) { fit = true; preserve = false; }
  graphGrouping = preferences.grouping;
  if (!preserve) { stopPlayback(); playback = 1; }
  const focused = document.activeElement?.closest<HTMLElement>('[data-session]')?.dataset.session;
  const { min, max } = viewDateBounds(currentView());
  filtered = data.sessions.filter((s) =>
    sessionMatchesSource(s, sourceID) && (!projectID || s.projectID === projectID) && (!directory || s.directory === directory) &&
    (includeChildren || !s.parentID || Boolean(s.forkID)) && (includeArchived || !s.archived) &&
    s.created >= min && s.created <= max,
  );
  sortedSessions = [...filtered].sort((a, b) => sessionEnd(b) - sessionEnd(a));
  filteredIDs = new Set(filtered.map((s) => s.id));
  sessionSearch.setScope(filtered.map((s) => s.id));
  graph = makeGraph(filtered, data.projects, preserve ? graph : undefined, graphGrouping);
  nodeColors = new Map(graph.nodes.map((n) => [n.session.id, n.color]));
  scene?.setCutoff(playback);
  scene?.setGraph(graph, fit, preserve);
  renderGraphMessage();
  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => {
    const active = !fromDate && !toDate && button.dataset.days === String(days);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderList(preserve);
  if (preserve && focused) sessionList.getElement(sessionRows.get(focused)!)?.focus({ preventScroll: true });
  renderHistogram();
  if (selectedID && !filtered.some((s) => s.id === selectedID)) clearSelection();
  else if (selectedID && selectedDetail) scene?.setFiles(selectedDetail.files);
  if (selectedID && selectedTimeline) scene?.setEvents(selectedTimeline.items);
  refreshIcons();
  const view = currentView(), fingerprint = JSON.stringify(view);
  if (settingsHydrated && fingerprint !== viewFingerprint) { viewFingerprint = fingerprint; saveLibrarySettings({ viewState: view }); }
}

function renderGraphMessage() {
  updateShareButton();
  const message = $('#graph-message');
  message.hidden = Boolean(filtered.length && scene);
  if (!filtered.length) message.innerHTML = data?.importing
    ? '<div class="loading-orbit"><span></span><span></span><span></span></div><h3>Importing your sessions…</h3><p>Your map will appear when the import finishes.</p>'
    : data && !data.sessions.length ? `${icon('folder')}<h3>Your map starts here</h3><p>Choose a source with saved conversations to get started.</p><button class="primary-button" id="empty-sources">Choose sources ${icon('arrow-right')}</button>`
    : `${icon('search')}<h3>No matching sessions</h3><button class="text-button" id="clear-filters">Reset filters ${icon('rotate-ccw')}</button>`;
  else if (!scene) message.innerHTML = sceneLoading ? '<h3>Preparing the map…</h3>' : `${icon('box')}<h3>WebGL is unavailable.</h3><p>You can explore every session and its file details in the list.</p>`;
  $('#clear-filters')?.addEventListener('click', () => resetFilters());
  $('#empty-sources')?.addEventListener('click', () => void imports.open());
  refreshIcons();
}

function updateShareButton(reset = false) {
  const available = Boolean(filtered.length && scene);
  if (reset || !available) { window.clearTimeout(shareRevealTimer); shareRevealTimer = 0; shareReady = false; }
  $('.playback-share').classList.toggle('ready', shareReady && available);
  $<HTMLButtonElement>('#share-playback').disabled = !shareReady || !available;
  if (available && !shareReady && !shareRevealTimer) shareRevealTimer = window.setTimeout(() => {
    shareRevealTimer = 0; shareReady = true; updateShareButton();
  }, 1000);
}

function resetFilters(reveal?: Session) {
  sourceID = ''; $<HTMLSelectElement>('#source').value = '';
  projectID = ''; directory = ''; days = reveal ? 0 : DEFAULT_VIEW_STATE.days; fromDate = ''; toDate = ''; includeChildren = true; includeArchived = reveal?.archived === true;
  $<HTMLSelectElement>('#project').value = '';
  $<HTMLInputElement>('#children').checked = true;
  dateRange.setRange('', '');
  updateDirectories();
  updateFilters(true);
}

function renderList(preserve = false) {
  $('#list-count').textContent = count(filtered.length);
  const rows: SessionRow[] = [];
  sessionRows = new Map();
  let lastDate = '';
  for (const session of sortedSessions) {
    const end = sessionEnd(session), d = date(end, true);
    if (d !== lastDate) rows.push({ label: date(end), year: new Date(end).getFullYear() });
    lastDate = d;
    sessionRows.set(session.id, rows.length); rows.push({ session });
  }
  sessionList.setItems(rows, preserve);
  $('#session-list').querySelector('.empty-list')?.remove();
  if (!rows.length) $('#session-list').insertAdjacentHTML('beforeend', '<p class="empty-list">No sessions match your filters.</p>');
}

function updateListSelection(previous: string | null) {
  for (const id of [previous, selectedID]) {
    const card = id ? sessionList.getElement(sessionRows.get(id)!) : undefined;
    if (card) { card.classList.toggle('selected', id === selectedID); card.setAttribute('aria-pressed', String(id === selectedID)); }
  }
}

function renderHistogram() {
  tokenPlayback = playbackTokens(filtered); sessionPlayback = playbackSessions(filtered); tokenDisplay = '';
  const buckets = timelineBuckets(filtered.map(sessionEnd), graph.start, graph.end);
  const peak = Math.max(...buckets, 1);
  $('#histogram').innerHTML = buckets.map((n) => `<span style="height:${Math.max(4, n / peak * 100)}%;opacity:${n ? 0.8 : 0.15}" title="${n} session endpoints"></span>`).join('');
  $('#date-label').textContent = graph.start ? `${date(graph.start, new Date(graph.start).getFullYear() !== new Date(graph.end).getFullYear())} — ${date(graph.end, true)}` : 'No sessions';
  if (graph.start) {
    dateRange.setRange(fromDate || inputDate(graph.start), toDate || inputDate(graph.end));
  }
  updateScrubber();
}

function updateScrubber(scrubbing = false) {
  $<HTMLInputElement>('#scrubber').value = String(Math.round(playback * 1000));
  $('#timeline-cursor').style.left = `${playback * 100}%`;
  $('#histogram').style.setProperty('--progress', `${playback * 100}%`);
  const time = graph.start + (graph.end - graph.start) * playback;
  $('#playback-date').textContent = graph.start ? date(time, new Date(graph.start).getFullYear() !== new Date(graph.end).getFullYear()) : '—';
  const period = graph.nodes.length ? playbackDate(time, graph.end - graph.start) : '—';
  if ($('#playback-period').textContent !== period) $('#playback-period').textContent = period;
  const usage = tokenPlayback.at(time, playback >= 1);
  const sessions = sessionPlayback(time, playback >= 1);
  const display = `${usage.tokens}:${usage.sessions}:${sessions}`;
  if (display !== tokenDisplay) {
    tokenDisplay = display;
    $('#playback-summary').hidden = filtered.length === 0;
    $('#playback-sessions').textContent = count(sessions);
    $('#playback-tokens').textContent = tokenPlayback.recorded ? compact(usage.tokens) : '—';
    $('#playback-summary').title = `${count(sessions)} sessions started. ${tokenPlayback.recorded ? `${count(usage.tokens)} burnt tokens` : 'Token usage unavailable'}. Token totals are added at the latest saved message, including cache where reported. ${count(tokenPlayback.missing)} sessions have no recorded total.${tokenPlayback.partial ? ` ${count(tokenPlayback.partial)} recorded totals are partial.` : ''}${tokenPlayback.untimed ? ` ${count(tokenPlayback.untimed)} totals have no message timestamp and are included only at the end.` : ''}`;
  }
  scene?.setCutoff(playback, scrubbing);
}

function stopPlayback() {
  playing = false;
  playbackOutroTime = 0;
  $('#app').classList.remove('playback-mode');
  if (playbackPanels) {
    const previous = playbackPanels; playbackPanels = undefined;
    setPanel('explorer', previous.explorer);
    setPanel('inspector', previous.inspector && Boolean(selectedID));
  }
  scene?.setPlaying(false);
  cancelAnimationFrame(playFrame);
  $('#play').innerHTML = icon('play');
  $('#play').setAttribute('aria-label', 'Play timeline');
  refreshIcons();
}

function animatePlayback(time: number) {
  if (!playing) return;
  const delta = Math.max(0, time - lastPlayTime);
  lastPlayTime = time;
  if (!document.hidden) {
    if (playback < 1) playback = Math.min(1, playback + delta * preferences.playbackSpeed / PLAYBACK_DURATION);
    else playbackOutroTime += delta;
  }
  updateScrubber();
  scene?.setPlaybackOutro(playback >= 1 ? Math.min(1, playbackOutroTime / PLAYBACK_ORBIT_DURATION) : null);
  if (playback >= 1 && playbackOutroTime >= PLAYBACK_ORBIT_DURATION + PLAYBACK_END_HOLD) stopPlayback();
  else playFrame = requestAnimationFrame(animatePlayback);
}

function clearSelection() {
  const previous = selectedID;
  detailController?.abort(); timelineController?.abort();
  $('#file-legend').hidden = true;
  detailRequest++;
  timelineRequest++;
  selectedID = null;
  selectedDetail = undefined;
  selectedTimeline = undefined;
  scene?.select(null);
  history.replaceState(null, '', location.pathname);
  emptyInspector();
  updateListSelection(previous);
}

const inspectorPreviewCount = 3;

function renderConnections(container: HTMLElement, session: Session, initiallyExpanded: boolean) {
  const parents: { id: string; label: string; kind: IconName }[] = session.forkID ? [{ id: session.forkID, label: 'Forked from', kind: 'git-fork' }] : session.parentID ? [{ id: session.parentID, label: 'Parent', kind: 'network' }] : [];
  const children = data!.sessions.filter((s) => s.forkID === session.id || (!s.forkID && s.parentID === session.id));
  const related: typeof parents = [...parents, ...children.map((s): (typeof parents)[number] => ({ id: s.id, label: s.forkID ? 'Fork' : 'Child', kind: s.forkID ? 'git-fork' : 'network' }))];
  if (!related.length) { container.hidden = true; return; }
  const rows = (expanded: boolean) => (expanded ? related : related.slice(0, inspectorPreviewCount)).map((r) => {
    const relatedSession = sessionsByID.get(r.id);
    return `<button class="relation" data-related="${escape(r.id)}" ${!relatedSession ? 'disabled' : ''}>${icon(r.kind)}<span><small>${r.label}</small><strong>${escape(relatedSession?.title || 'Session no longer available')}</strong></span>${icon('arrow-up-right')}</button>`;
  }).join('');
  const label = (expanded: boolean) => expanded ? 'Show fewer connections' : `Show all ${count(related.length)} connections`;
  container.innerHTML = `<div class="section-label">Connections<span>${count(related.length)}</span></div><div id="connection-list">${rows(initiallyExpanded)}</div>
    ${related.length > inspectorPreviewCount ? `<button class="load-more" id="toggle-connections" type="button" aria-controls="connection-list" aria-expanded="${initiallyExpanded}">${label(initiallyExpanded)}</button>` : ''}`;
  container.querySelector<HTMLButtonElement>('#toggle-connections')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    container.querySelector('#connection-list')!.innerHTML = rows(expanded);
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = label(expanded);
    if (!expanded) button.scrollIntoView({ block: 'nearest' });
    refreshIcons();
  });
}

function renderInspector(session: Session, reveal = true) {
  const project = data!.projects.find((p) => p.id === session.projectID);
  const kind = session.forkID ? 'Fork' : session.parentID ? 'Child session' : 'Session';
  const isWorktree = project?.worktrees.includes(session.directory);
  const infoOpen = !reveal ? ($('#session-inspector').querySelector<HTMLDetailsElement>('.session-info')?.open ?? true) : true;
  const connectionsExpanded = !reveal && $('#toggle-connections')?.getAttribute('aria-expanded') === 'true';
  const infoRows: [IconName, string, string][] = [
    ['folder', 'Project', project?.name || 'Unknown'],
    ['cpu', 'Model', session.model],
    ['bot', 'Agent', session.agent || 'Unknown'],
    ['coins', session.usage?.partial ? 'Recorded tokens (partial)' : 'Recorded tokens', session.tokens === null ? 'Not recorded' : compact(session.tokens)],
    ['dollar-sign', session.usage?.costEstimated ? 'Cost (harness estimate)' : 'Recorded cost', session.cost === null ? 'Not recorded' : `$${session.cost.toFixed(2)}`],
  ];
  $('#session-inspector').innerHTML = `
    <div class="panel-heading"><span class="panel-title">${kind}</span><button id="close-inspector" class="icon-button" aria-label="Close session details">${icon('x')}</button></div>
    <div class="detail-scroll">
      <div class="detail-title"><span class="source-badge" data-source="${escape(session.source || 'opencode')}">${sourceIcon(session.source)}${escape(sourceName(session.source))}</span><h2>${escape(session.title)}</h2><div class="detail-title-meta"><span class="detail-date">${timestamp(session.created)}</span><button id="focus-session" class="icon-button" title="Focus node" aria-label="Focus node">${icon('crosshair')}</button></div></div>
      <section id="message-detail" class="detail-section"></section>
      ${sessionInfo(infoRows, `<div class="directory-card"><span>${icon(isWorktree ? 'git-branch' : 'folder')}${isWorktree ? 'Worktree' : 'Directory'}</span><code>${escape(session.directory)}</code></div>`, infoOpen)}
      <section id="commit-detail" class="detail-section"></section>
      <section id="pull-request-detail" class="detail-section" hidden></section>
      ${session.linkedSessionIDs?.length ? `<section class="detail-section"><div class="section-label">Linked provider history</div>${session.linkedSessionIDs.map(id => `<button class="relation" data-history="${escape(id)}">${sourceIcon(id.split(':')[0])}<span>${escape(sourceName(id.split(':')[0]))}</span>${icon('arrow-up-right')}</button>`).join('')}</section>` : ''}
      <div id="file-detail"><section class="detail-section"><div class="section-label">Changed files</div><div class="detail-loading">${icon('loader-circle', 'spinning')}Loading changes…</div></section></div>
      <section id="session-connections" class="detail-section"></section>
      <div id="session-tools"></div>
    </div>
  `;
  $('#toggle-inspector').hidden = false;
  if (reveal) setPanel('inspector', true);
  $('#close-inspector').addEventListener('click', () => { setPanel('inspector', false); $('#toggle-inspector').focus(); });
  $('#focus-session').addEventListener('click', () => { stopPlayback(); scene?.focus(session.id); });
  renderConnections($('#session-connections'), session, connectionsExpanded);
  renderTimeline();
  disposeCommitHistory?.();
  disposeCommitHistory = showCommitHistory($('#commit-detail'), session.id, (id, revision) => {
    eventHover.clear(); stopPlayback(); eventExplorer.open(session, id, revision, 'tools');
  });
  refreshIcons();
}

function renderTimeline(timeline?: TimelineMarkers) {
  const commits = timeline?.items.filter(item => item.kind === 'commit').length ?? 0;
  const notes = timeline ? [
    `${count(timeline.total)} ${timeline.total === 1 ? 'message' : 'messages'}`,
    commits ? `${count(commits)} ${commits === 1 ? 'commit marker' : 'commit markers'}` : '',
    timeline.limited ? 'Map limit reached' : '',
  ].filter(Boolean) : ['Loading messages…'];
  $('#message-detail').innerHTML = `<div class="section-label">Session timeline</div><div class="event-key"><span style="--event-color:#ffffff"><i></i>User & assistant messages</span></div><p class="coverage-note">${notes.map(escape).join(' · ')}</p><button class="secondary-button explore-events">Explore messages ${icon('arrow-right')}</button>`;
  $('.explore-events').addEventListener('click', () => openEvents()); refreshIcons();
}

async function loadTimeline(session: Session, refocus = false) {
  const request = ++timelineRequest;
  timelineController?.abort(); const controller = new AbortController(); timelineController = controller;
  try {
    const timeline = await fetchJSON<TimelineMarkers>(`/api/sessiongraph/session/${encodeURIComponent(session.id)}/event-markers`, controller.signal);
    if (controller.signal.aborted || request !== timelineRequest || selectedID !== session.id) return;
    selectedTimeline = timeline; scene?.setEvents(timeline.items, refocus); renderTimeline(timeline);
  } catch {
    if (controller.signal.aborted || request !== timelineRequest || selectedID !== session.id) return;
    $('#message-detail').innerHTML = '<div class="section-label">Session timeline</div><p class="coverage-note">Message timing unavailable.</p><button class="secondary-button explore-events">Explore messages</button><button class="load-more" id="retry-timeline">Retry message markers</button>';
    $('.explore-events').addEventListener('click', () => openEvents());
    $('#retry-timeline').addEventListener('click', () => void loadTimeline(session));
  }
}

function mergeDetail(previous: SessionDetail, next: SessionDetail): SessionDetail {
  const files = new Map(previous.files.map((file) => [file.path, { ...file }]));
  for (const file of next.files) {
    const existing = files.get(file.path);
    files.set(file.path, { ...file, steps: (existing?.steps || 0) + file.steps, source: existing?.source === 'snapshot' ? 'snapshot' : file.source });
  }
  const tools = new Map(previous.tools.map((tool) => [tool.name, tool.count]));
  next.tools.forEach((tool) => tools.set(tool.name, (tools.get(tool.name) || 0) + tool.count));
  return { ...next, pullRequests: next.pullRequests ?? previous.pullRequests, files: [...files.values()].sort((a, b) => b.steps - a.steps || a.path.localeCompare(b.path)), tools: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), locations: [...previous.locations, ...next.locations], messagesScanned: previous.messagesScanned + next.messagesScanned, snapshotSteps: previous.snapshotSteps + next.snapshotSteps };
}

function renderDetail(detail: SessionDetail) {
  const prSection = $('#pull-request-detail'), prs = detail.pullRequests || [];
  prSection.hidden = !prs.length;
  prSection.innerHTML = prs.length ? `<div class="section-label">Pull requests<span>${count(prs.length)}</span></div>${prs.map(pr =>
    `<a class="relation" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer">${icon('git-branch')}<span><small>${escape(pr.host)}</small><strong>${escape(pr.repository)} #${pr.number}</strong></span>${icon('arrow-up-right')}</a>`
  ).join('')}` : '';
  if (isTauri()) prSection.querySelectorAll<HTMLAnchorElement>('a').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    void openDesktopUrl(link.href).catch(() => showToast('Could not open the pull request in your browser.'));
  }));
  const files = detail.files;
  const root = $('#file-detail');
  const toolsRoot = $('#session-tools');
  const toolsOpen = toolsRoot.querySelector('details')?.open ?? false;
  const expanded = root.querySelector<HTMLButtonElement>('#toggle-files')?.getAttribute('aria-expanded') === 'true';
  const fileRows = (items: SessionDetail['files']) => items.map((file) => `<li title="${escape(file.path)} · ${file.source}">${icon('file-code-2')}<div><strong>${escape(directoryLabel(file.path))}</strong>${file.path.includes('/') ? `<span>${escape(file.path.slice(0, file.path.lastIndexOf('/')))}</span>` : ''}</div><small>${file.steps}×</small></li>`).join('');
  $('#file-legend').hidden = !files.length;
  root.innerHTML = `
    <section class="detail-section"><div class="section-label">Changed files<span>${count(files.length)}${detail.partial ? '+' : ''}</span></div>
    ${files.length ? `<ul class="file-list" id="changed-file-list">${fileRows(expanded ? files : files.slice(0, inspectorPreviewCount))}</ul>` : `<div class="no-files"><p>No file changes found.</p></div>`}
     ${files.length > inspectorPreviewCount ? `<button class="load-more" id="toggle-files" type="button" aria-controls="changed-file-list" aria-expanded="${expanded}">${expanded ? 'Show fewer files' : `Show all ${count(files.length)} files`}</button>` : ''}
     ${detail.partial || !detail.snapshotSteps || files.length > 80 ? `<details class="file-coverage"><summary>File coverage</summary><p class="coverage-note">${[detail.partial ? 'Some changes may be missing.' : '', !detail.snapshotSteps ? 'Snapshots unavailable.' : '', files.length > 80 ? '80 files shown on the map.' : ''].filter(Boolean).join(' ')}</p></details>` : ''}
     ${detail.nextCursor ? '<p class="coverage-note" id="history-loading" role="status">Loading full history…</p>' : ''}</section>
    ${detail.locations.length ? `<details class="more-details detail-section"><summary>Directory moves ${icon('chevron-down')}</summary>${detail.locations.map((l) => `<div class="location-entry"><span>${timestamp(l.time)}</span><code>${escape(l.directory)}</code></div>`).join('')}</details>` : ''}
  `;
  toolsRoot.innerHTML = detail.tools.length ? `<details class="more-details detail-section"${toolsOpen ? ' open' : ''}><summary>Tools used <span>${count(detail.tools.reduce((sum, t) => sum + t.count, 0))}</span>${icon('chevron-down')}</summary><div class="tools-list">${detail.tools.slice(0, 12).map((tool) => `<div><span>${escape(tool.name)}</span><strong>${tool.count}</strong></div>`).join('')}</div></details>` : '';
  root.querySelector<HTMLButtonElement>('#toggle-files')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const showAll = button.getAttribute('aria-expanded') !== 'true';
    $('#changed-file-list').innerHTML = fileRows(showAll ? files : files.slice(0, inspectorPreviewCount));
    button.setAttribute('aria-expanded', String(showAll));
    button.textContent = showAll ? 'Show fewer files' : `Show all ${count(files.length)} files`;
    if (!showAll) button.scrollIntoView({ block: 'nearest' });
    refreshIcons();
  });
  scene?.setFiles(files);
  refreshIcons();
}

async function loadFiles(id: string) {
  const request = ++detailRequest;
  detailController?.abort(); const controller = new AbortController(); detailController = controller;
  let cursor: string | undefined, accumulated: SessionDetail | undefined;
  const seen = new Set<string>();
  try {
    do {
      const result = await fetchJSON<SessionDetail>(`/api/sessiongraph/session/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, controller.signal);
      if (controller.signal.aborted || request !== detailRequest || selectedID !== id) return;
      if (accumulated && result.revision !== accumulated.revision) throw new Error('History changed. Retry to load the latest version.');
      accumulated = accumulated ? mergeDetail(accumulated, result) : result;
      selectedDetail = accumulated;
      // Show the first page promptly, then update only the progress label until
      // the full scan completes rather than rebuilding the file scene per page.
      if (!cursor || !result.nextCursor) renderDetail(accumulated);
      else if ($('#history-loading')) $('#history-loading').textContent = `Loading full history… ${count(accumulated.messagesScanned)} messages`;
      cursor = result.nextCursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error('History could not be loaded. Please retry.');
      if (cursor) seen.add(cursor);
    } while (cursor);
  } catch (error) {
    if (controller.signal.aborted || request !== detailRequest || selectedID !== id) return;
    if (selectedDetail) {
      renderDetail(selectedDetail);
      const status = $('#history-loading');
      if (status) status.innerHTML = 'History loading interrupted. <button class="text-button" id="retry-detail">Retry</button>';
      $('#retry-detail')?.addEventListener('click', () => void loadFiles(id));
    }
    else {
      $('#file-detail').innerHTML = `<section class="detail-section"><div class="section-label">Changed files</div><p class="coverage-note">${escape(error instanceof Error ? error.message : 'Details unavailable.')}</p><button class="load-more" id="retry-detail">Retry file details</button></section>`;
      $('#retry-detail').addEventListener('click', () => loadFiles(id));
    }
  }
}

function selectSession(id: string) {
  const session = sessionsByID.get(id);
  if (!session) return;
  const previous = selectedID;
  eventExplorer.close(); eventHover.clear();
  if (!filteredIDs.has(id)) resetFilters(session);
  stopPlayback();
  playback = 1;
  updateScrubber();
  selectedID = id;
  selectedDetail = undefined;
  selectedTimeline = undefined;
  $('#file-legend').hidden = true;
  history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
  scene?.select(id);
  renderInspector(session);
  scene?.focus(id);
  updateListSelection(previous);
  void loadFiles(id);
  void loadTimeline(session, true);
}

$('#session-list').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-session]');
  if (button?.dataset.session) selectSession(button.dataset.session);
});
$('#inspector').addEventListener('click', (event) => {
  const history = (event.target as HTMLElement).closest<HTMLElement>('[data-history]')?.dataset.history;
  if (history) {
    eventHover.clear(); stopPlayback(); setPanel('inspector', true);
    eventExplorer.open({ id: history, source: history.split(':')[0] });
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-related]');
  if (button?.dataset.related) selectSession(button.dataset.related);
});
$('#project').addEventListener('change', (event) => { projectID = (event.target as HTMLSelectElement).value; directory = ''; updateDirectories(); updateFilters(true); });
$('#source').addEventListener('change', (event) => { sourceID = (event.target as HTMLSelectElement).value; updateFilters(true); });
$('#directory').addEventListener('change', (event) => { directory = (event.target as HTMLSelectElement).value; updateFilters(true); });
$('#children').addEventListener('change', (event) => { includeChildren = (event.target as HTMLInputElement).checked; updateFilters(); });
document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => button.addEventListener('click', () => { days = button.dataset.days === 'ytd' ? 'ytd' : Number(button.dataset.days); fromDate = ''; toDate = ''; updateFilters(true); }));
$('#reset-camera').addEventListener('click', () => { stopPlayback(); scene?.reset(); });
$('#refresh').addEventListener('click', () => { if (data?.onboarding) void imports.open(true); else void imports.refresh(); });
$('#scrubber').addEventListener('input', (event) => { stopPlayback(); playback = Number((event.target as HTMLInputElement).value) / 1000; updateScrubber(true); });
$('#play').addEventListener('click', () => {
  if (!filtered.length) return;
  if (playing) return stopPlayback();
  if (playback >= 1) playback = 0;
  updateScrubber();
  playbackPanels = { explorer: !$('#explorer').hidden, inspector: !$('#inspector').hidden };
  setPanel('explorer', false); setPanel('inspector', false); setPanel('timeline', true);
  eventHover.clear(); tooltipSession = undefined;
  $('#app').classList.add('playback-mode');
  updateShareButton(true);
  playing = true;
  playbackOutroTime = 0;
  scene?.setPlaying(true);
  lastPlayTime = performance.now();
  $('#play').innerHTML = icon('pause');
  $('#play').setAttribute('aria-label', 'Pause timeline');
  refreshIcons();
  playFrame = requestAnimationFrame(animatePlayback);
});
document.addEventListener('visibilitychange', () => { lastPlayTime = performance.now(); }, { signal: autoImportEvents.signal });
async function exportAnimation() {
  const button = $<HTMLButtonElement>('#share-playback'); button.disabled = true;
  try {
    if (!playbackShare) { const { createPlaybackShare } = await import('./share'); playbackShare = createPlaybackShare(modalVisibility, () => void openPublishing()); }
    if (graph.nodes.length) playbackShare.open(graph, preferences);
  } catch { showToast('Could not open video sharing. Please try again.'); }
  finally { button.disabled = !filtered.length || !scene; }
}
async function openPublishing() {
  try {
    publishingDialog ??= createPublishing(modalVisibility, () => void exportAnimation(), publishingAccount);
    await publishingDialog.open(filtered.map(session => session.id));
  } catch { showToast('Could not open publishing. Please try again.'); }
}
$('#share-playback').addEventListener('click', openPublishing);
$('#open-publishing').addEventListener('click', openPublishing);
if (import.meta.hot) import.meta.hot.dispose(() => { window.clearTimeout(shareRevealTimer); playbackShare?.dispose(); publishingDialog?.dispose(); });
$('#help').addEventListener('click', () => { $<HTMLDialogElement>('#help-dialog').showModal(); modalVisibility(); });
$('#help-dialog').addEventListener('close', modalVisibility);
$('#help-dialog [data-close-help]').addEventListener('click', () => $<HTMLDialogElement>('#help-dialog').close());
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return;
  if (playing && event.key === 'Escape') { event.preventDefault(); stopPlayback(); return; }
  if (eventExplorer.handleKey(event)) return;
  if (event.key === 'Escape') {
    if (selectedID) clearSelection();
    else setPanel('explorer', false);
    return;
  }
  if ((event.target as HTMLElement).matches('input, select, textarea') || event.metaKey || event.ctrlKey || event.altKey) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !(event.target as Element).closest('[contenteditable="true"]')) {
    const target = event.target as HTMLElement;
    if (target.matches('canvas, body, .session-card') || target.closest('.session-card')) {
      const sorted = sortedSessions;
      const index = sorted.findIndex((s) => s.id === selectedID), direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const next = sorted[Math.max(0, Math.min(sorted.length - 1, index + direction))];
      if (next) {
        event.preventDefault(); selectSession(next.id);
        if (target.closest('.session-card')) {
          const row = sessionRows.get(next.id)!;
          sessionList.scrollToIndex(row);
          sessionList.getElement(row)?.focus({ preventScroll: true });
        }
      }
      return;
    }
  }
  if (event.key.toLowerCase() === 'f') { stopPlayback(); scene?.reset(); }
  if (event.key.toLowerCase() === 'h') {
    stopPlayback();
    const visible = (['explorer', 'timeline', 'inspector'] as const).filter((id) => !$(`#${id}`).hidden);
    if (visible.length) { hiddenPanels = visible; visible.forEach((id) => setPanel(id, false)); }
    else { (hiddenPanels.length ? hiddenPanels : ['explorer', 'timeline'] as PanelID[]).forEach((id) => { if (id !== 'inspector' || selectedID) setPanel(id, true); }); }
  }
});

void load().then(() => {
  // Let the usable session list paint before allocating a WebGL context and
  // compiling shaders, which can be expensive on a cold graphics driver.
  requestAnimationFrame(() => { window.setTimeout(() => void initializeScene(), 0); });
  if (data?.importing) imports.resume(); else checkAutoImport();
});
if (import.meta.env.DEV) Object.assign(window, { sessionGraphDiagnostics: () => scene?.diagnostics(), sessionGraphAudioDiagnostics: () => audio.diagnostics(), sessionGraphSearchDiagnostics: sessionSearch.diagnostics });
if (import.meta.hot) import.meta.hot.dispose(() => sessionList.dispose());
if (import.meta.hot) import.meta.hot.dispose(() => { settingsSaver?.dispose(); autoImport?.dispose(); autoImportEvents.abort(); window.clearInterval(autoImportTimer); detailController?.abort(); timelineController?.abort(); timelineClient.clear(); scene?.dispose(); audio.dispose(); settings.dispose(); eventExplorer.dispose(); eventHover.dispose(); desktopUpdater.dispose(); dateRange.dispose(); disposeSelects(); reducedMotion.removeEventListener('change', onSystemMotion); window.removeEventListener('storage', onPreferencesStorage); sessionSearch.dispose(); launcher.dispose(); imports.dispose(); cancelAnimationFrame(playFrame); });
