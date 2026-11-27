import { icon, escapeMarkup, type IconName } from './icons';
import { graphButton, graphHelp, sessionInfo, shortcutHints, soundButton } from './graph-ui';
import { InteractionAudio } from './audio';
import { TimelineScene } from './scene';
import { observeSelects } from './controls';
import { DEFAULT_PREFERENCES } from './preferences';
import { newestPublicSessionFirst, publicGraphLayout, publicSessionRecency, validatePublicGraph, type PublicGraph } from './public-graph';
import { playbackControls } from './playback-controls';
import { PLAYBACK_DURATION, PLAYBACK_ORBIT_DURATION, PLAYBACK_END_HOLD, playbackDate, playbackSessions, timelineBuckets } from './playback';
import { playbackTokens, validTokenCount } from './playback-tokens';
import { sessionEnd } from './layout';
import { sourceName, sourceIconElement } from './sources';
import type { TimelineSummary } from './timeline';
import { VirtualList } from './virtual-list';
import { viewDateBounds } from './view-state';
import './public-viewer.css';

export { publicSummary } from './public-stats';
const number = (value: number | null | undefined) => value == null ? 'unknown' : value.toLocaleString();
const date = (value: number | null) => value === null ? 'unknown' : new Date(value).toLocaleString();
const shortDate = (value: number, year = false) => new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
let viewerSequence = 0;

/** Shared desktop publication preview and web explorer. All inspection is in-memory public data. */
export function createPublicViewer(host: HTMLElement, input: PublicGraph, options: { fullscreen?: boolean; sourceIconBase?: string; profileCard?: HTMLElement } = {}) {
  let value = validatePublicGraph(input);
  let graph = publicGraphLayout(value);
  let projects = new Map(graph.lanes.flatMap(lane => lane.nodes.map(node => [Number(node.session.projectID), lane.label] as const)));
  host.classList.add('public-viewer');
  host.dataset.graphAudio = '';
  const helpID = `public-graph-help-${++viewerSequence}`;
  host.classList.toggle('public-viewer-full', Boolean(options.fullscreen));
  host.innerHTML = `
    <div class="public-canvas" aria-label="Interactive public session graph"></div>
    <nav class="public-view-controls" aria-label="Graph controls">
      ${graphButton('center-focus', 'Fit view', { 'data-fit': true }, 'Fit view (F)')}
      ${graphButton('clock', 'Toggle timeline', { 'data-timeline': true, 'aria-expanded': 'true' }, 'Timeline')}
      ${graphButton('panel-right', 'Toggle session details', { 'data-detail': true, 'aria-expanded': 'false', hidden: true }, 'Session details')}
      ${graphButton('circle-help', 'Help', { 'data-help': true, 'aria-haspopup': 'dialog' })}
      ${graphButton('volume-2', 'Mute sound', { 'data-mute': true, 'data-sound': 'none', 'aria-pressed': 'false' })}
    </nav>
    <div class="public-left">
    <div class="public-toolbar">${graphButton('search', 'Toggle sessions', { 'data-sessions': true, 'aria-expanded': 'true' }, 'Sessions', 'Sessions')}</div>
    <aside class="public-browser public-panel" aria-label="Sessions">
      <div class="public-panel-heading"><h2>Sessions <span data-count></span></h2>${graphButton('x', 'Close sessions', { 'data-close-list': true })}</div>
      <div class="public-filters"><div class="public-filter" data-harness-filter><select data-harness data-source-icons="${escapeMarkup(options.sourceIconBase || '/sources')}" aria-label="Session source"><option value="">All sources</option></select></div><div class="public-filter">${icon('folder')}<select data-project aria-label="Project"><option value="">All projects</option></select></div></div>
      <div class="public-list" role="list" aria-label="Sessions"></div>
    </aside>
    </div>
    <aside class="public-session public-panel" aria-label="Session details" hidden><div class="public-panel-heading"><h2 data-session-heading></h2>${graphButton('crosshair', 'Focus node', { 'data-focus': true })}${graphButton('x', 'Close session details', { 'data-close-detail': true })}</div><div class="public-session-data"></div></aside>
    <div class="public-tooltip" hidden></div>
    <section class="public-playback public-panel timeline-controls" aria-label="Timeline controls">${playbackControls(`<span class="public-period-label">${icon('clock')}<span data-range-label>Timeline</span></span><div class="range-buttons" role="group" aria-label="Date range"><button type="button" data-days="7">7D</button><button type="button" data-days="30">30D</button><button type="button" data-days="90">90D</button><button type="button" data-days="ytd" title="Year to date">YTD</button><button type="button" data-days="0">All</button></div><select data-speed aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>${graphButton('x', 'Close timeline', { 'data-close-timeline': true })}`, {}, { showCoverage: false })}</section>
    ${shortcutHints(['fit', 'clear'], 'public-hints')}
    ${graphHelp(helpID, ['fit', 'clear'])}
    <p class="public-announcement" role="status"></p>`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  if (options.profileCard) $('.public-left').prepend(options.profileCard);
  const part = (name: string) => $(`[data-playback=${name}]`);
  const canvas = $('.public-canvas'), details = $('.public-session'), body = $('.public-session-data'), list = $('.public-list'), browser = $('.public-browser'), timeline = $('.public-playback');
  const project = $<HTMLSelectElement>('[data-project]'), harness = $<HTMLSelectElement>('[data-harness]'), speed = $<HTMLSelectElement>('[data-speed]');
  const scrubber = part('scrubber') as HTMLInputElement, play = part('play') as HTMLButtonElement;
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)'), events = new AbortController();
  const preferences = { ...DEFAULT_PREFERENCES, focusDimming: false, messageDots: value.settings.messageTimestamps };
  const audio = new InteractionAudio(preferences, () => {}, host);
  const defaultDays = () => value.settings.timestamps ? 'ytd' : 0;
  let scene: TimelineScene | undefined, selected: number | null = null, visible = value.sessions, days: number | 'ytd' = defaultDays();
  let frame = 0, playing = false, progress = 1, outro = 0, last = 0, disposed = false, markers: TimelineSummary[] = [];
  let panels: { browser: boolean; details: boolean } | undefined;
  let sessionCount = playbackSessions(graph.nodes.map(n => n.session)), tokens = playbackTokens(graph.nodes.map(n => n.session), { allSources: true });
  const setList = (open: boolean) => { browser.hidden = !open; $('[data-sessions]').setAttribute('aria-expanded', String(open)); };
  const setTimeline = (open: boolean) => { timeline.hidden = !open; $('[data-timeline]').setAttribute('aria-expanded', String(open)); };
  const announce = (text: string) => { $('.public-announcement').textContent = text; };
  const setDetails = (open: boolean) => { details.hidden = !open; const toggle = $('[data-detail]'); toggle.hidden = selected === null; toggle.setAttribute('aria-expanded', String(open)); };
  let colors = new Map<number, string>();
  const virtualList = new VirtualList<PublicGraph['sessions'][number]>(list, {
    key: session => String(session.id),
    estimate: () => 66,
    render: (session, index) => {
      const item = document.createElement('div'), button = document.createElement('button'), title = document.createElement('span'), subtitle = document.createElement('small');
      item.setAttribute('role', 'listitem'); item.setAttribute('aria-posinset', String(index + 1)); item.setAttribute('aria-setsize', String(visible.length));
      button.type = 'button'; button.dataset.session = String(session.id); button.setAttribute('aria-pressed', String(selected === session.id));
      button.style.setProperty('--session-color', colors.get(session.id) || '#b0e9d6'); title.textContent = `Session ${session.id + 1}`;
      if (session.harness) subtitle.append(sourceIconElement(session.harness, options.sourceIconBase));
      const text = document.createElement('span'); text.textContent = [projects.get(session.group), session.model].filter(Boolean).join(' · '); subtitle.append(text);
      button.append(title, subtitle); button.onclick = () => select(String(session.id)); item.append(button);
      return item;
    },
  });

  function stop() {
    cancelAnimationFrame(frame); frame = 0; playing = false; outro = 0;
    host.classList.remove('playback-mode');
    if (panels) { setList(panels.browser); setDetails(panels.details && selected !== null); panels = undefined; }
    scene?.setPlaying(false); play.innerHTML = icon('play'); play.setAttribute('aria-label', 'Play timeline');
  }
  function select(id: string | null) {
    stop();
    const session = id === null ? undefined : value.sessions[Number(id)];
    selected = session && visible.some(s => s.id === session.id) ? session.id : null;
    scene?.select(selected === null ? null : String(selected));
    scene?.setEvents([]); markers = []; body.replaceChildren(); setDetails(selected !== null);
    for (const card of list.querySelectorAll<HTMLButtonElement>('button')) card.setAttribute('aria-pressed', String(card.dataset.session === String(selected)));
    if (selected === null || !session) return;
    if (host.clientWidth < 1000) setList(false);
    progress = 1; update();
    $('[data-session-heading]').textContent = `Session ${session.id + 1}`;
    if (session.harness) { const badge = document.createElement('div'); badge.className = 'public-source-badge'; badge.append(sourceIconElement(session.harness, options.sourceIconBase), sourceName(session.harness)); body.append(badge); }
    const rows: [IconName, string, string][] = [['folder', 'Project', projects.get(session.group) || 'Unknown']];
    if ('model' in session) rows.push(['cpu', 'Model', session.model ?? 'unknown']);
    if ('harness' in session && !session.harness) rows.push(['bot', 'Agent', 'unknown']);
    if ('tokens' in session) rows.push(['coins', 'Tokens incl. cache', number(session.tokens)]);
    if (session.timestamps) rows.push(['calendar', 'Created', date(session.timestamps.created)], ['clock', 'Last message', date(session.timestamps.lastMessageAt)]);
    if (session.messages) { rows.push(['message', 'Messages', number(session.messages.count)]); if (session.messages.untimed) rows.push(['clock', 'Untimed messages', number(session.messages.untimed)]); }
    body.insertAdjacentHTML('beforeend', sessionInfo(rows));
    for (const [label, parent, symbol] of [['Fork of', session.fork, 'git-fork'], ['Child of', session.parent, 'network']] as const) if (parent !== null) {
      const button = document.createElement('button'); button.className = 'public-relation'; button.type = 'button'; button.dataset.related = String(parent);
      button.innerHTML = icon(symbol); button.append(`${label} Session ${parent + 1}`);
      button.disabled = !visible.some(s => s.id === parent); button.onclick = () => select(String(parent)); body.append(button);
    }
    if (session.messageTimes?.values.length) {
      const disclosure = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `${number(session.messageTimes.values.length)} message timestamps`;
      const pre = document.createElement('pre'); pre.textContent = session.messageTimes.values.map(date).join('\n');
      disclosure.append(summary, pre); body.append(disclosure);
      markers = session.messageTimes.values.map((time, index) => ({ id: `public-${index}`, ordinal: index, kind: 'message', name: 'Message', role: 'user', time, timeSource: 'recorded', preview: '' }));
      scene?.setEvents(markers);
    }
    scene?.focus(String(session.id));
    announce(`Selected Session ${session.id + 1}.`);
  }
  function renderList() {
    $('[data-count]').textContent = number(visible.length);
    colors = new Map(graph.nodes.map(n => [Number(n.session.id), n.color]));
    virtualList.setItems(visible);
    list.querySelector('.public-list-empty')?.remove();
    if (!visible.length) { const empty = document.createElement('p'); empty.className = 'public-list-empty'; empty.textContent = 'No sessions match these filters.'; list.append(empty); }
  }
  function update(scrubbing = false) {
    scene?.setCutoff(progress, scrubbing); scrubber.value = String(Math.round(progress * 1000));
    const time = graph.start + (graph.end - graph.start) * progress, count = sessionCount(time, progress === 1);
    part('date').textContent = value.settings.timestamps && graph.nodes.length ? shortDate(time) : `${number(count)} sessions`;
    part('period').textContent = value.settings.timestamps && graph.nodes.length ? playbackDate(time, graph.end - graph.start) : 'All time';
    part('cursor').style.left = `${progress * 100}%`; part('histogram').style.setProperty('--progress', `${progress * 100}%`);
    part('summary').hidden = !visible.length;
    part('sessions').textContent = number(count);
    const usage = tokens.at(time, progress === 1);
    part('tokens').textContent = tokens.recorded && validTokenCount(usage.tokens) ? compact.format(usage.tokens) : '—';
    $('[data-token-total]').hidden = !value.settings.tokens;
  }
  function filter(reuseLayout = false) {
    stop(); progress = 1;
    const { min: earliest, max: latest } = days === 'ytd' ? viewDateBounds({ days, fromDate: '', toDate: '' })
      : { min: days ? Math.max(...value.sessions.map(publicSessionRecency)) - days * 86400_000 : 0, max: Infinity };
    visible = value.sessions.filter(s => {
      const recency = publicSessionRecency(s);
      return (!project.value || String(s.group) === project.value) && (!harness.value || s.harness === harness.value) && recency >= earliest && recency <= latest;
    }).sort(newestPublicSessionFirst);
    if (!reuseLayout || visible.length !== value.sessions.length) graph = publicGraphLayout(value, new Set(visible.map(s => s.id)));
    sessionCount = playbackSessions(graph.nodes.map(n => n.session)); tokens = playbackTokens(graph.nodes.map(n => n.session), { allSources: true });
    scene?.setGraph(graph, true); select(null);
    const buckets = timelineBuckets(graph.nodes.map(n => sessionEnd(n.session)), graph.start, graph.end), max = Math.max(1, ...buckets);
    part('histogram').replaceChildren(...buckets.map(count => { const bar = document.createElement('span'); bar.style.height = `${Math.max(4, count / max * 100)}%`; bar.style.opacity = count ? '.8' : '.15'; return bar; }));
    $('[data-range-label]').textContent = !visible.length ? 'No sessions' : value.settings.timestamps ? `${shortDate(graph.start)} — ${shortDate(graph.end, true)}` : 'Timeline';
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-days]')) button.setAttribute('aria-pressed', String(button.dataset.days === String(days)));
    play.disabled = !visible.length; scrubber.disabled = !visible.length; renderList(); update();
  }
  try {
    scene = new TimelineScene(canvas, {
      onSelect: id => { select(id); if (id !== null) void audio.play('select'); }, onPlaybackInterrupt: stop,
      onHover: (node, x, y) => {
        const tooltip = $('.public-tooltip'); tooltip.hidden = !node;
        if (node) { const rect = host.getBoundingClientRect(); tooltip.textContent = node.session.title; tooltip.style.left = `${Math.max(8, Math.min(host.clientWidth - 135, x - rect.left + 14))}px`; tooltip.style.top = `${Math.max(8, y - rect.top - 35)}px`; }
      },
      onEvent: id => { const marker = markers.find(m => m.id === id); if (marker) { scene?.focusEvent(marker); announce(date(marker.time)); } },
      onEventHover() {},
    }, { panels: [browser, details, timeline, ...(options.profileCard ? [options.profileCard] : [])], focusTop: 80 });
    scene.applyPreferences(preferences);
  } catch {
    canvas.textContent = '3D rendering is unavailable. Explore sessions in the panel.';
    ($('[data-fit]') as HTMLButtonElement).disabled = true;
  }
  function populateFilters() {
    project.replaceChildren(new Option('All projects', '')); harness.replaceChildren(new Option('All sources', ''));
    [...projects].sort((a, b) => a[0] - b[0]).forEach(([id, name]) => project.add(new Option(name, String(id))));
    [...new Set(value.sessions.flatMap(s => s.harness ? [s.harness] : []))].sort().forEach(id => harness.add(new Option(sourceName(id), id)));
    $('[data-harness-filter]').hidden = !value.settings.harness;
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-days]')) button.hidden = !value.settings.timestamps && button.dataset.days !== '0';
  }
  populateFilters();
  for (const control of [project, harness]) control.onchange = () => filter();
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-days]')) button.onclick = () => { days = button.dataset.days === 'ytd' ? 'ytd' : Number(button.dataset.days); filter(); };
  $('[data-sessions]').onclick = () => { stop(); if (browser.hidden && host.clientWidth < 1000) setDetails(false); setList(browser.hidden); };
  $('[data-close-list]').onclick = () => setList(false);
  $('[data-close-detail]').onclick = () => setDetails(false);
  $('[data-detail]').onclick = () => { if (selected === null) return; stop(); if (details.hidden && host.clientWidth < 1000) setList(false); setDetails(details.hidden); };
  $('[data-focus]').onclick = () => { if (selected !== null) scene?.focus(String(selected)); };
  const fit = () => { stop(); scene?.reset(); };
  $('[data-fit]').onclick = fit;
  $('[data-timeline]').onclick = () => { stop(); setTimeline(timeline.hidden); };
  $('[data-close-timeline]').onclick = () => setTimeline(false);
  const help = $<HTMLDialogElement>(`#${helpID}`);
  let inView = true;
  const syncSuspended = () => scene?.setSuspended(!inView || document.hidden || help.open);
  $('[data-help]').onclick = () => { stop(); help.showModal(); syncSuspended(); };
  $('[data-close-help]').onclick = () => help.close();
  help.addEventListener('close', syncSuspended, { signal: events.signal });
  const mute = $('[data-mute]');
  mute.onclick = () => {
    preferences.muted = !preferences.muted; audio.configure(preferences);
    const sound = soundButton(preferences.muted);
    mute.innerHTML = icon(sound.glyph); mute.title = sound.label;
    mute.setAttribute('aria-label', sound.label); mute.setAttribute('aria-pressed', String(preferences.muted));
    if (!preferences.muted) void audio.play();
  };
  const applyMotion = () => scene?.applyPreferences(preferences);
  motionQuery.addEventListener('change', applyMotion, { signal: events.signal });
  const animate = (now: number) => {
    if (disposed || !playing) return;
    const delta = Math.max(0, now - last); last = now;
    if (progress < 1) progress = Math.min(1, progress + delta * Number(speed.value) / PLAYBACK_DURATION); else outro += delta;
    update(); scene?.setPlaybackOutro(progress >= 1 ? Math.min(1, outro / PLAYBACK_ORBIT_DURATION) : null);
    if (progress >= 1 && outro >= PLAYBACK_ORBIT_DURATION + PLAYBACK_END_HOLD) stop(); else frame = requestAnimationFrame(animate);
  };
  play.onclick = () => {
    if (playing) return stop();
    if (progress >= 1) progress = 0;
    panels = { browser: !browser.hidden, details: !details.hidden }; setList(false); setDetails(false);
    $('.public-tooltip').hidden = true; host.classList.add('playback-mode');
    playing = true; outro = 0; last = performance.now(); update(); scene?.setPlaying(true);
    play.innerHTML = icon('pause'); play.setAttribute('aria-label', 'Pause timeline'); frame = requestAnimationFrame(animate);
  };
  scrubber.oninput = () => { stop(); progress = Number(scrubber.value) / 1000; update(true); };
  host.tabIndex = -1;
  host.addEventListener('keydown', event => {
    if (help.open) return;
    if ((event.target as HTMLElement).matches('input, select, textarea') || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); fit(); }
    if (event.key === 'Escape') select(null);
    if (event.code === 'Space' && !(event.target as HTMLElement).closest('button, summary')) { event.preventDefault(); play.click(); }
  }, { signal: events.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); syncSuspended(); }, { signal: events.signal });
  const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; if (!inView) stop(); syncSuspended(); }); observer.observe(host);
  if (host.clientWidth < 760) setList(false);
  filter(true); applyMotion();
  const disposeSelects = observeSelects(host);
  return {
    diagnostics: () => ({ ...scene?.diagnostics(), playing, progress, outro, selected }),
    setData(input: PublicGraph) {
      value = validatePublicGraph(input); graph = publicGraphLayout(value);
      projects = new Map(graph.lanes.flatMap(lane => lane.nodes.map(node => [Number(node.session.projectID), lane.label] as const)));
      preferences.messageDots = value.settings.messageTimestamps; days = defaultDays(); selected = null;
      populateFilters(); filter(true); applyMotion();
    },
    dispose() { disposed = true; stop(); events.abort(); observer.disconnect(); disposeSelects(); virtualList.dispose(); scene?.dispose(); audio.dispose(); delete host.dataset.graphAudio; host.replaceChildren(); host.classList.remove('public-viewer', 'public-viewer-full'); },
  };
}
