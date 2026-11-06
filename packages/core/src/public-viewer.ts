import { TimelineScene } from './scene';
import { DEFAULT_PREFERENCES, motionEnabled } from './preferences';
import { publicGraphLayout, validatePublicGraph, type PublicGraph } from './public-graph';
import { publicSummary } from './public-stats';
import { PLAYBACK_DURATION, playbackDate, playbackSessions, timelineBuckets } from './playback';
import { sourceName } from './sources';
import type { TimelineSummary } from './timeline';
import './public-viewer.css';

export { publicSummary } from './public-stats';
const number = (value: number | null | undefined) => value == null ? 'Unknown' : value.toLocaleString();
const date = (value: number | null) => value === null ? 'Unknown' : new Date(value).toLocaleString();

/** Shared desktop publication preview and web explorer. All inspection is in-memory public data. */
export function createPublicViewer(host: HTMLElement, input: PublicGraph, options: { fullscreen?: boolean } = {}) {
  const value = validatePublicGraph(input);
  let graph = publicGraphLayout(value);
  host.classList.add('public-viewer');
  host.classList.toggle('public-viewer-full', Boolean(options.fullscreen));
  host.innerHTML = `
    <div class="public-canvas" aria-label="Interactive public session graph"></div>
    <div class="public-toolbar"><button type="button" data-sessions aria-expanded="true">☷ Sessions</button><span class="public-badge">Public snapshot</span></div>
    <nav class="public-view-controls" aria-label="Graph controls"><div class="public-view-switch"><button type="button" data-view="3d" aria-pressed="true">3D</button><button type="button" data-view="2d" aria-pressed="false">2D</button></div><button type="button" data-fit title="Fit view (F)">Fit view</button><button type="button" data-motion aria-pressed="true">Motion</button><button type="button" data-timeline aria-expanded="true">Timeline</button></nav>
    <aside class="public-browser public-panel" aria-label="Public sessions">
      <div class="public-panel-heading"><h2>Sessions <span data-count></span></h2><button type="button" data-close-list aria-label="Close sessions">×</button></div>
      <label class="public-search"><span>Search public data</span><input type="search" placeholder="Session, group, model…" aria-label="Search public sessions"></label>
      <div class="public-filters"><select data-group aria-label="Anonymous group"><option value="">All groups</option></select><select data-harness aria-label="Coding agent"><option value="">All agents</option></select><select data-days aria-label="Date range"><option value="0">All dates</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select></div>
      <div class="public-list" role="list" aria-label="Sessions"></div><button type="button" data-more hidden>Show more sessions</button>
    </aside>
    <aside class="public-session public-panel" aria-label="Public session details" hidden><div class="public-panel-heading"><h2 data-session-heading></h2><button type="button" data-close-detail aria-label="Close session details">×</button></div><div class="public-session-data"></div></aside>
    <div class="public-tooltip" hidden></div>
    <section class="public-playback public-panel" aria-label="Timeline controls"><div class="public-timeline-heading"><span data-period></span><select data-speed aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></div><div class="public-timeline-track"><button type="button" data-play aria-label="Play timeline">▶</button><div class="public-histogram-wrap"><div class="public-histogram" aria-hidden="true"></div><input type="range" min="0" max="1000" value="1000" aria-label="Graph playback position"></div><output></output></div><p data-summary></p></section>
    <p class="public-hints">Drag to orbit · Scroll to zoom · <kbd>F</kbd> fit · <kbd>Esc</kbd> clear</p>
    <p class="public-announcement" role="status"></p>`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const canvas = $('.public-canvas'), details = $('.public-session'), body = $('.public-session-data'), list = $('.public-list');
  const group = $<HTMLSelectElement>('[data-group]'), harness = $<HTMLSelectElement>('[data-harness]'), days = $<HTMLSelectElement>('[data-days]');
  const search = $<HTMLInputElement>('input[type=search]'), scrubber = $<HTMLInputElement>('input[type=range]'), play = $<HTMLButtonElement>('[data-play]');
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)'), events = new AbortController();
  const preferences = { ...DEFAULT_PREFERENCES, muted: true, clickSounds: false, focusDimming: false, messageDots: value.settings.messageTimestamps };
  let scene: TimelineScene | undefined, selected: number | null = null, visible = value.sessions, listLimit = 80;
  let frame = 0, progress = 1, last = 0, disposed = false, markers: TimelineSummary[] = [];
  let sessionCount = playbackSessions(graph.nodes.map(n => n.session));
  const stop = () => { cancelAnimationFrame(frame); frame = 0; scene?.setPlaying(false); play.textContent = '▶'; play.setAttribute('aria-label', 'Play timeline'); };
  const announce = (text: string) => { $('.public-announcement').textContent = text; };
  const row = (name: string, text: string) => { const p = document.createElement('p'), label = document.createElement('strong'); label.textContent = `${name}: `; p.append(label, text); body.append(p); };

  function select(id: string | null, focus = false) {
    const session = id === null ? undefined : value.sessions[Number(id)];
    selected = session && visible.some(s => s.id === session.id) ? session.id : null;
    scene?.select(selected === null ? null : String(selected));
    scene?.setEvents([]); markers = []; body.replaceChildren(); details.hidden = selected === null;
    for (const card of list.querySelectorAll<HTMLButtonElement>('button')) card.setAttribute('aria-pressed', String(card.dataset.session === String(selected)));
    if (selected === null || !session) return;
    stop(); progress = 1; update();
    $('[data-session-heading]').textContent = `Session ${session.id + 1}`;
    row('Group', `Group ${session.group + 1}`);
    if (session.timestamps) { row('Created', date(session.timestamps.created)); row('Last message', date(session.timestamps.lastMessageAt)); }
    if ('tokens' in session) row('Tokens', number(session.tokens));
    if (session.messages) { row('Messages', `${number(session.messages.count)}${session.messages.partial ? ' · partial history' : ''}`); row('Untimed messages', number(session.messages.untimed)); }
    if ('model' in session) row('Model', session.model ?? 'Unknown or private alias');
    if ('harness' in session) row('Harness', session.harness ? sourceName(session.harness) : 'Unknown');
    for (const [label, parent] of [['Fork of', session.fork], ['Child of', session.parent]] as const) if (parent !== null) {
      const p = document.createElement('p'), button = document.createElement('button');
      p.append(`${label} `); button.textContent = `Session ${parent + 1}`; button.type = 'button';
      button.disabled = !visible.some(s => s.id === parent); button.onclick = () => select(String(parent), true); p.append(button); body.append(p);
    }
    if (session.messageTimes) {
      row('Message timestamps', `${session.messageTimes.values.length.toLocaleString()}${session.messageTimes.limited ? ' · limited coverage' : ''}`);
      const disclosure = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'View published timestamps';
      const pre = document.createElement('pre'); pre.textContent = session.messageTimes.values.map(date).join('\n') || 'No recorded timestamps.';
      disclosure.append(summary, pre); body.append(disclosure);
      markers = session.messageTimes.values.map((time, index) => ({ id: `public-${index}`, ordinal: index, kind: 'message', name: 'Message', role: 'user', time, timeSource: 'recorded', preview: '' }));
      scene?.setEvents(markers);
    }
    const note = document.createElement('p'); note.className = 'public-detail-note'; note.textContent = 'Only published metadata. Names, messages, code, paths, and costs stay private.'; body.append(note);
    if (focus) scene?.focus(String(session.id));
    announce(`Selected Session ${session.id + 1}.`);
  }
  function renderList() {
    list.replaceChildren(); $('[data-count]').textContent = String(visible.length);
    const colors = new Map(graph.nodes.map(n => [Number(n.session.id), n.color]));
    for (const session of visible.slice(0, listLimit)) {
      const item = document.createElement('div'), button = document.createElement('button'), title = document.createElement('span'), subtitle = document.createElement('small');
      item.setAttribute('role', 'listitem'); button.type = 'button'; button.dataset.session = String(session.id); button.setAttribute('aria-pressed', String(selected === session.id));
      button.style.setProperty('--session-color', colors.get(session.id) || '#b0e9d6'); title.textContent = `Session ${session.id + 1}`;
      subtitle.textContent = [`Group ${session.group + 1}`, session.harness ? sourceName(session.harness) : '', session.model || ''].filter(Boolean).join(' · ');
      button.append(title, subtitle); button.onclick = () => select(String(session.id), true); item.append(button); list.append(item);
    }
    if (!visible.length) list.textContent = 'No sessions match these filters.';
    $('[data-more]').hidden = listLimit >= visible.length;
  }
  function update() {
    scene?.setCutoff(progress); scrubber.value = String(Math.round(progress * 1000));
    const time = graph.start + (graph.end - graph.start) * progress;
    $('output').textContent = value.settings.timestamps && graph.nodes.length ? playbackDate(time, graph.end - graph.start) : `${sessionCount(time, progress === 1)} sessions`;
    $('.public-histogram-wrap').style.setProperty('--progress', `${progress * 100}%`);
  }
  function filter() {
    stop(); listLimit = 80; progress = 1;
    const query = search.value.toLowerCase().trim(), cutoff = value.settings.timestamps && Number(days.value) ? Math.max(...value.sessions.map(s => s.timestamps!.lastMessageAt ?? s.timestamps!.created)) - Number(days.value) * 86400_000 : 0;
    visible = value.sessions.filter(s => (!group.value || String(s.group) === group.value) && (!harness.value || s.harness === harness.value) && (!cutoff || Math.max(s.timestamps!.created, s.timestamps!.lastMessageAt ?? 0) >= cutoff) && (!query || `session ${s.id + 1} group ${s.group + 1} ${s.model ?? ''} ${s.harness ? sourceName(s.harness) : ''}`.toLowerCase().includes(query)));
    graph = publicGraphLayout(value, new Set(visible.map(s => s.id)));
    sessionCount = playbackSessions(graph.nodes.map(n => n.session)); scene?.setGraph(graph, true); select(null);
    const buckets = timelineBuckets(graph.nodes.map(n => n.session.created), graph.start, graph.end, 50), max = Math.max(1, ...buckets);
    $('.public-histogram').replaceChildren(...buckets.map(count => { const bar = document.createElement('span'); bar.style.height = `${Math.max(4, count / max * 100)}%`; return bar; }));
    $('[data-period]').textContent = !value.settings.timestamps ? 'Session order · timestamps not shared' : visible.length ? `${new Date(graph.start).toLocaleDateString()} — ${new Date(graph.end).toLocaleDateString()}` : 'No sessions';
    $('[data-summary]').textContent = publicSummary({ ...value, sessions: visible });
    play.disabled = !visible.length; scrubber.disabled = !visible.length; renderList(); update();
  }
  try {
    scene = new TimelineScene(canvas, {
      onSelect: id => select(id), onPlaybackInterrupt: stop,
      onHover: (node, x, y) => {
        const tooltip = $('.public-tooltip'); tooltip.hidden = !node;
        if (node) { const rect = host.getBoundingClientRect(); tooltip.textContent = node.session.title; tooltip.style.left = `${Math.max(8, Math.min(host.clientWidth - 135, x - rect.left + 14))}px`; tooltip.style.top = `${Math.max(8, y - rect.top - 35)}px`; }
      },
      onEvent: id => { const marker = markers.find(m => m.id === id); if (marker) { scene?.focusEvent(marker); announce(`Published message timestamp: ${date(marker.time)}.`); } },
      onEventHover() {},
    });
    scene.applyPreferences(preferences);
  } catch {
    canvas.textContent = '3D rendering is unavailable. Explore the published data in the sessions panel.';
    $('.public-view-controls').hidden = true;
  }
  [...new Set(value.sessions.map(s => s.group))].sort((a, b) => a - b).forEach(id => group.add(new Option(`Group ${id + 1}`, String(id))));
  [...new Set(value.sessions.flatMap(s => s.harness ? [s.harness] : []))].sort().forEach(id => harness.add(new Option(sourceName(id), id)));
  harness.hidden = !value.settings.harness; days.hidden = !value.settings.timestamps;
  for (const control of [group, harness, days]) control.onchange = filter;
  search.oninput = filter;
  $('[data-more]').onclick = () => { listLimit += 80; renderList(); };
  const setList = (open: boolean) => { $('.public-browser').hidden = !open; $('[data-sessions]').setAttribute('aria-expanded', String(open)); };
  $('[data-sessions]').onclick = () => setList($('.public-browser').hidden);
  $('[data-close-list]').onclick = () => setList(false);
  $('[data-close-detail]').onclick = () => select(null);
  $('[data-fit]').onclick = () => scene?.reset();
  $('[data-timeline]').onclick = () => { const panel = $('.public-playback'); panel.hidden = !panel.hidden; $('[data-timeline]').setAttribute('aria-expanded', String(!panel.hidden)); };
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-view]')) button.onclick = () => {
    preferences.view = button.dataset.view === '2d' ? '2d' : '3d';
    scene?.setFlat(button.dataset.view === '2d');
    for (const other of host.querySelectorAll('[data-view]')) other.setAttribute('aria-pressed', String(other === button));
  };
  const applyMotion = () => { scene?.applyPreferences(preferences); $('button[data-motion]').setAttribute('aria-pressed', String(motionEnabled(preferences, motionQuery.matches))); };
  $('button[data-motion]').onclick = () => { preferences.motion = motionEnabled(preferences, motionQuery.matches) ? 'off' : 'on'; applyMotion(); };
  motionQuery.addEventListener('change', applyMotion, { signal: events.signal });
  const animate = (now: number) => {
    if (disposed) return;
    progress = Math.min(1, progress + Math.min(now - last, 100) / PLAYBACK_DURATION * Number($<HTMLSelectElement>('[data-speed]').value)); last = now; update();
    if (progress === 1) stop(); else frame = requestAnimationFrame(animate);
  };
  play.onclick = () => { if (frame) return stop(); if (progress >= 1) progress = 0; last = performance.now(); scene?.setPlaying(true); play.textContent = 'Ⅱ'; play.setAttribute('aria-label', 'Pause timeline'); frame = requestAnimationFrame(animate); };
  scrubber.oninput = () => { stop(); progress = Number(scrubber.value) / 1000; update(); };
  host.tabIndex = -1;
  host.addEventListener('keydown', event => {
    if ((event.target as HTMLElement).matches('input, select, textarea') || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); scene?.reset(); }
    if (event.key === 'Escape') select(null);
    if (event.key === '/') { event.preventDefault(); setList(true); search.focus(); }
  }, { signal: events.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); scene?.setSuspended(document.hidden); }, { signal: events.signal });
  const observer = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) stop(); scene?.setSuspended(!entry.isIntersecting || document.hidden); }); observer.observe(host);
  filter(); applyMotion();
  return { dispose() { disposed = true; stop(); events.abort(); observer.disconnect(); scene?.dispose(); host.replaceChildren(); host.classList.remove('public-viewer', 'public-viewer-full'); } };
}
