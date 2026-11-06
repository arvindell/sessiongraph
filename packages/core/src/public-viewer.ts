import { TimelineScene } from './scene';
import { DEFAULT_PREFERENCES } from './preferences';
import { publicGraphLayout, type PublicGraph, type PublicSession } from './public-graph';
import { sourceName } from './sources';
import type { TimelineSummary } from './timeline';
import './public-viewer.css';

const number = (value: number | null | undefined) => value == null ? 'Unknown' : value.toLocaleString();
const date = (value: number | null) => value === null ? 'Unknown' : new Date(value).toLocaleString();
export function publicSummary(graph: PublicGraph) {
  const values = [`${graph.sessions.length.toLocaleString()} sessions`];
  if (graph.settings.tokens) {
    const known = graph.sessions.filter(s => s.tokens !== null);
    values.push(`${known.reduce((sum, s) => sum + s.tokens!, 0).toLocaleString()} recorded tokens${known.length < graph.sessions.length ? ' (partial coverage)' : ''}`);
  }
  if (graph.settings.messageCounts) {
    values.push(`${graph.sessions.reduce((sum, s) => sum + (s.messages?.count ?? 0), 0).toLocaleString()} recorded messages${graph.sessions.some(s => s.messages?.partial) ? ' (partial history)' : ''}`);
  }
  return values.join(' · ');
}

export function createPublicViewer(host: HTMLElement, value: PublicGraph) {
  const graph = publicGraphLayout(value);
  host.classList.add('public-viewer');
  host.innerHTML = `<div class="public-canvas" aria-label="Anonymous session graph"></div><div class="public-view-controls"><button type="button" data-view="3d" aria-pressed="true">3D</button><button type="button" data-view="2d" aria-pressed="false">2D</button><button type="button" data-fit>Fit view</button></div><div class="public-session" aria-live="polite"><p>Select a session to inspect its public data.</p></div><div class="public-playback"><button type="button" data-play>Play</button><input type="range" min="0" max="1000" value="1000" aria-label="Graph playback position"><output></output></div>`;
  const canvas = host.querySelector<HTMLElement>('.public-canvas')!;
  const details = host.querySelector<HTMLElement>('.public-session')!;
  const output = host.querySelector('output')!, scrubber = host.querySelector('input')!, play = host.querySelector<HTMLButtonElement>('[data-play]')!;
  let frame = 0, progress = 1, last = 0, disposed = false;
  const stop = () => { cancelAnimationFrame(frame); frame = 0; scene?.setPlaying(false); play.textContent = 'Play'; };
  let scene: TimelineScene | undefined;
  function select(id: string | null) {
    scene?.select(id); details.replaceChildren();
    if (id === null) { details.textContent = 'Select a session to inspect its public data.'; return; }
    const session = value.sessions[Number(id)];
    const heading = document.createElement('h3'); heading.textContent = `Session ${session.id + 1}`; details.append(heading);
    const row = (name: string, text: string) => { const p = document.createElement('p'), label = document.createElement('strong'); label.textContent = `${name}: `; p.append(label, text); details.append(p); };
    row('Group', String(session.group + 1));
    if (session.timestamps) { row('Created', date(session.timestamps.created)); row('Last message', date(session.timestamps.lastMessageAt)); }
    if ('tokens' in session) row('Tokens', number(session.tokens));
    if (session.messages) { row('Messages', `${number(session.messages.count)}${session.messages.partial ? ' · partial history' : ''}`); row('Without timestamps', number(session.messages.untimed)); }
    if ('model' in session) row('Model', session.model ?? 'Unknown or private alias');
    if ('harness' in session) row('Harness', session.harness ? sourceName(session.harness) : 'Unknown');
    if (session.messageTimes) {
      row('Message timestamps', `${session.messageTimes.values.length.toLocaleString()}${session.messageTimes.limited ? ' · limited' : ''}`);
      const list = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'View timestamps'; list.append(summary);
      const pre = document.createElement('pre'); pre.textContent = session.messageTimes.values.map(date).join('\n') || 'No recorded timestamps.'; list.append(pre); details.append(list);
    }
    const markers: TimelineSummary[] = (session.messageTimes?.values ?? []).map((time, index) => ({ id: `public-${index}`, ordinal: index, kind: 'message', name: 'Message', role: 'user', time, timeSource: 'recorded', preview: '' }));
    scene?.setEvents(markers);
  }
  try {
    scene = new TimelineScene(canvas, { onSelect: select, onHover() {}, onPlaybackInterrupt: stop, onEvent() {}, onEventHover() {} });
    scene.applyPreferences({ ...DEFAULT_PREFERENCES, muted: true, clickSounds: false, focusDimming: false, messageDots: value.settings.messageTimestamps });
    scene.setGraph(graph, true);
  } catch {
    canvas.textContent = '3D rendering is unavailable. Use the session list below to inspect the published data.';
    host.querySelector<HTMLElement>('.public-view-controls')!.hidden = true;
  }
  const update = () => {
    scene?.setCutoff(progress); scrubber.value = String(Math.round(progress * 1000));
    output.textContent = value.settings.timestamps ? new Date(graph.start + (graph.end - graph.start) * progress).toLocaleDateString() : 'Timestamps hidden';
  };
  const animate = (now: number) => {
    if (disposed) return;
    progress = Math.min(1, progress + Math.min(now - last, 100) / 35_000); last = now; update();
    if (progress === 1) stop(); else frame = requestAnimationFrame(animate);
  };
  play.onclick = () => { if (frame) return stop(); if (progress >= 1) progress = 0; last = performance.now(); scene?.setPlaying(true); play.textContent = 'Pause'; frame = requestAnimationFrame(animate); };
  scrubber.oninput = () => { stop(); progress = Number(scrubber.value) / 1000; update(); };
  for (const button of host.querySelectorAll<HTMLButtonElement>('[data-view]')) button.onclick = () => {
    scene?.setFlat(button.dataset.view === '2d');
    for (const other of host.querySelectorAll('[data-view]')) other.setAttribute('aria-pressed', String(other === button));
  };
  host.querySelector<HTMLButtonElement>('[data-fit]')!.onclick = () => scene?.reset();
  // Keyboard/screen-reader access independent of WebGL picking.
  const label = document.createElement('label'); label.className = 'public-session-picker'; label.textContent = 'Inspect session ';
  const picker = document.createElement('select'); picker.setAttribute('aria-label', 'Inspect anonymous session');
  picker.append(new Option('Choose a session', ''));
  value.sessions.forEach(s => picker.append(new Option(`Session ${s.id + 1} · Group ${s.group + 1}`, String(s.id))));
  picker.onchange = () => select(picker.value || null); label.append(picker); host.append(label);
  update();
  return { dispose() { disposed = true; stop(); scene?.dispose(); host.replaceChildren(); } };
}
