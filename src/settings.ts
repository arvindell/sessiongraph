import { DEFAULT_PREFERENCES, type Preferences } from './preferences';
import { createElement, PanelsTopLeft, Database, Volume2, Sparkles, Orbit, LockKeyhole, type IconNode } from 'lucide';
import { refreshSelects } from './controls';
import type { SaveState } from './library-settings';
import type { ImportStatus, SourceStatus } from './types';
import { sourceIcon, sortSources } from './sources';

type Section = 'interface' | 'sources' | 'audio' | 'graphics' | 'trails' | 'privacy';
const tabs: [Section, string, IconNode][] = [['interface', 'Interface', PanelsTopLeft], ['sources', 'Sources', Database], ['audio', 'Sound', Volume2], ['graphics', 'Graphics', Sparkles], ['trails', 'Trails & playback', Orbit], ['privacy', 'Privacy', LockKeyhole]];
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const toggle = (key: keyof Preferences, label: string, hint: string) => `<label class="setting-row"><span><strong>${label}</strong><small>${hint}</small></span><input type="checkbox" role="switch" data-pref="${key}" aria-label="${label}"/></label>`;
const range = (key: keyof Preferences, label: string, hint: string, min: number, max: number, unit = '%', step = 1) => `<label class="setting-row setting-range"><span><strong>${label}</strong><small>${hint}</small></span><span class="setting-slider"><input type="range" data-pref="${key}" aria-label="${label}" min="${min}" max="${max}" step="${step}"/><output data-output="${key}" data-unit="${unit}"></output></span></label>`;
const select = (key: keyof Preferences, label: string, hint: string, options: [string, string][]) => `<label class="setting-row"><span><strong>${label}</strong><small>${hint}</small></span><select data-pref="${key}" aria-label="${label}">${options.map(([value, title]) => `<option value="${value}">${title}</option>`).join('')}</select></label>`;

export function createSettings(callbacks: { change: (patch: Partial<Preferences>) => void; visibility: () => void; previewSound: () => void; resetPanels: () => void; getSources: () => Promise<SourceStatus[]>; importSources: (ids: string[]) => Promise<void> }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog'; dialog.setAttribute('aria-labelledby', 'settings-title');
  dialog.innerHTML = `<header class="settings-heading"><div><h2 id="settings-title">Settings</h2><p>Import, appearance, and playback preferences.</p></div><button class="icon-button settings-close" aria-label="Close settings">×</button></header>
    <div class="settings-layout"><nav class="settings-tabs" role="tablist" aria-label="Settings categories">${tabs.map(([id, name, glyph], i) => `<button role="tab" id="settings-tab-${id}" aria-controls="settings-${id}" aria-selected="${!i}" tabindex="${i ? -1 : 0}" data-tab="${id}">${createElement([glyph[0], { ...glyph[1], 'aria-hidden': 'true', 'stroke-width': 1.5 }, glyph[2]]).outerHTML}${name}</button>`).join('')}</nav>
    <div class="settings-content">
      <section id="settings-interface" role="tabpanel" aria-labelledby="settings-tab-interface"><h3>Interface</h3><p class="settings-description">View preferences and filters are saved with your library.</p>
        ${select('view', 'Default view', 'Switch between depth and a flat timeline.', [['3d', '3D galaxy'], ['2d', '2D timeline']])}
        ${select('motion', 'Motion', 'Camera transitions, reveals, and ambient movement.', [['system', 'Follow system'], ['on', 'On'], ['off', 'Off']])}
        ${select('density', 'Session list', 'Adjust spacing between sessions.', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}
        ${range('panelOpacity', 'Panel opacity', 'Adjust panel background transparency.', 55, 100)}
        <div class="settings-note"><span>Restore the default panel layout.</span><button class="secondary-button settings-reset-panels">Reset panel positions</button></div>
      </section>
      <section id="settings-sources" role="tabpanel" aria-labelledby="settings-tab-sources" hidden><h3>Sources</h3><p class="settings-description">Choose the local apps to import. Importing is read-only.</p>
        ${toggle('autoImport', 'Auto-import sessions', 'Check selected sources on startup, on return, and every minute while visible.')}
        <input type="search" class="source-search" placeholder="Find a source…" aria-label="Find a session source"/>
        <div class="settings-sources-list import-sources"></div>
        <div class="settings-import-progress" role="status"></div>
        <div class="settings-note"><span>Source changes apply when you import. Previously saved history is kept.</span><button class="secondary-button settings-import" disabled>Import selected sources</button></div>
      </section>
      <section id="settings-audio" role="tabpanel" aria-labelledby="settings-tab-audio" hidden><h3>Sound</h3><p class="settings-description">Interaction sounds are synthesized locally.</p>
        ${toggle('muted', 'Mute all sound', 'Silence everything. Your volume levels are kept.')}
        ${toggle('clickSounds', 'Interaction sounds', 'A soft tick for controls; a chime for sessions.')}
        ${range('clickVolume', 'Interaction volume', 'Adjust interaction sound volume.', 0, 100)}
        <div class="settings-note"><span class="settings-audio-status" role="status">Sound starts after your first interaction.</span><button class="secondary-button settings-preview" data-sound="none">Preview chime</button></div>
        <p class="settings-footnote">Audio pauses while this tab is hidden. The speaker button on the map is a quick mute.</p>
      </section>
      <section id="settings-graphics" role="tabpanel" aria-labelledby="settings-tab-graphics" hidden><h3>Graphics</h3><p class="settings-description">Adjust rendering quality and map appearance.</p>
        ${select('quality', 'Render quality', 'Performance uses 1× resolution and skips post-process effects.', [['performance', 'Performance'], ['balanced', 'Balanced'], ['high', 'High fidelity']])}
        ${range('bloom', 'Glow strength', 'Soft light around bright nodes; disabled in Performance.', 0, 75)}
        ${range('nodeScale', 'Node size', 'Scale the lights without changing their positions.', 60, 180)}
        ${toggle('stars', 'Starfield', 'A faint field of stars behind the timeline.')}
        ${toggle('labels', 'Map labels', 'Directory names and the selected session title.')}
        ${toggle('focusDimming', 'Focus dimming', 'Dim surrounding nodes when a session is selected.')}
      </section>
      <section id="settings-trails" role="tabpanel" aria-labelledby="settings-tab-trails" hidden><h3>Trails &amp; playback</h3><p class="settings-description">Trails start at creation and end at the latest recorded message.</p>
        ${select('trails', 'Session trails', 'Choose how much history to draw on the map.', [['all', 'All sessions'], ['selected', 'Selected session'], ['off', 'Hidden']])}
        ${range('trailOpacity', 'Trail brightness', 'Fade lifetime trails into the background.', 0, 100)}
        ${toggle('trailFlow', 'Flowing trails', 'A decorative pulse along each lifetime; respects Motion.')}
        ${range('trailSpeed', 'Flow speed', 'How quickly the light travels along the trails.', 10, 100)}
        ${toggle('relationships', 'Relationship links', 'Show recorded fork and child connections.')}
        ${toggle('messageDots', 'Message & event dots', 'Clickable user, assistant, tool, and event markers on the selected trail.')}
        ${range('playbackSpeed', 'Playback speed', '1× plays the full timeline in 30 seconds.', .25, 3, '×', .25)}
        <p class="settings-footnote">Flow is decorative. Message dots reflect saved timestamps; visual settings never alter your history.</p>
      </section>
      <section id="settings-privacy" role="tabpanel" aria-labelledby="settings-tab-privacy" hidden><h3>Privacy</h3><p class="settings-description">Local storage and network access.</p>
        <div class="setting-row"><span><strong>Processed on this computer</strong><small>Importing, indexing, search, and visualization run locally. Imports read your selected sources without changing them or starting an AI agent.</small></span></div>
        <div class="setting-row"><span><strong>Update checks use the internet</strong><small>Desktop update checks and downloads contact GitHub without session content. npm installation contacts its registry. These services receive ordinary connection metadata, including your public IP address.</small></span></div>
        <div class="setting-row"><span><strong>Continuing a session is your choice</strong><small>Explicitly launching another harness lets it read the selected context. It may contact its model provider under its own privacy settings.</small></span></div>
        <div class="setting-row"><span><strong>Local storage is not encrypted by SessionGraph</strong><small>Saved conversations, search text, and handoff files rely on your device's access controls. Disk encryption and backup or sync settings affect confidentiality. Deselecting a source keeps previously imported history.</small></span></div>
      </section>
    </div></div><footer class="settings-footer"><span class="settings-save-status" role="status">Changes save automatically on this device.</span><button class="text-button settings-reset">Restore defaults</button><button class="primary-button settings-done">Done</button></footer>`;
  document.body.append(dialog);
  const events = new AbortController(), options = { signal: events.signal };
  const sourceSearch = dialog.querySelector<HTMLInputElement>('.source-search')!;
  const filterSources = () => dialog.querySelectorAll<HTMLElement>('.import-source').forEach(row => { row.hidden = !row.textContent!.toLowerCase().includes(sourceSearch.value.trim().toLowerCase()); });
  sourceSearch.addEventListener('input', filterSources, options);
  let focus: HTMLElement | null = null;
  let sourceRequest = 0, sourcesLoading = false, sourcesRunning = false, active: Section = 'interface';
  const sourceControls = () => {
    dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.settings-source, .settings-import').forEach((control) => { control.disabled = sourcesLoading || sourcesRunning; });
    if (!dialog.querySelector('.settings-source')) (dialog.querySelector('.settings-import') as HTMLButtonElement).disabled = true;
  };
  async function loadSources() {
    const request = ++sourceRequest; sourcesLoading = true; sourceControls();
    const list = dialog.querySelector('.settings-sources-list')!;
    list.textContent = 'Finding local session sources…';
    try {
      const sources = await callbacks.getSources();
      if (events.signal.aborted || request !== sourceRequest) return;
      list.innerHTML = sortSources(sources).map((source) => `<label class="import-source"><input class="settings-source" type="checkbox" value="${escape(source.id)}" ${source.selected ? 'checked' : ''}/><span class="source-symbol">${sourceIcon(source.id)}</span><span><strong>${escape(source.name)}</strong><small>${escape(source.description)}</small><small class="source-imported">${source.sessions.toLocaleString()} saved${source.error ? ` · ${escape(source.error)}` : ''}</small></span><span class="source-detected ${source.available ? 'detected' : ''}">${source.available ? 'Detected' : 'Not found'}</span></label>`).join('');
      filterSources();
    } catch (error) {
      if (events.signal.aborted || request !== sourceRequest) return;
      list.textContent = error instanceof Error ? error.message : 'Could not detect sources.';
      const retry = document.createElement('button'); retry.className = 'secondary-button'; retry.textContent = 'Retry'; retry.addEventListener('click', () => void loadSources(), options); list.append(retry);
    } finally {
      if (request === sourceRequest && !events.signal.aborted) { sourcesLoading = false; sourceControls(); (dialog.querySelector('.settings-import') as HTMLButtonElement).disabled ||= !list.querySelector('input'); }
    }
  }
  dialog.querySelector('.settings-import')!.addEventListener('click', async () => {
    const ids = [...dialog.querySelectorAll<HTMLInputElement>('.settings-source:checked')].map((input) => input.value);
    sourcesRunning = true; sourceControls();
    dialog.querySelector('.settings-import-progress')!.textContent = 'Starting import…';
    try { await callbacks.importSources(ids); }
    catch (error) { sourcesRunning = false; sourceControls(); dialog.querySelector('.settings-import-progress')!.textContent = error instanceof Error ? error.message : 'Import unavailable.'; }
  }, options);
  const close = () => dialog.close();
  for (const selector of ['.settings-close', '.settings-done']) dialog.querySelector(selector)!.addEventListener('click', close, options);
  dialog.addEventListener('close', () => { callbacks.visibility(); focus?.focus({ preventScroll: true }); }, options);
  dialog.addEventListener('keydown', (event) => { event.stopPropagation(); }, options);
  function activate(id: string) {
    active = id as Section;
    for (const [section] of tabs) {
      const tab = dialog.querySelector<HTMLButtonElement>(`[data-tab="${section}"]`)!;
      tab.setAttribute('aria-selected', String(section === id)); tab.tabIndex = section === id ? 0 : -1;
      dialog.querySelector<HTMLElement>(`#settings-${section}`)!.hidden = section !== id;
    }
    dialog.querySelector('.settings-content')!.scrollTop = 0;
    if (active === 'sources') void loadSources();
  }
  for (const tab of dialog.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    tab.addEventListener('click', () => activate(tab.dataset.tab!), options);
    tab.addEventListener('keydown', (event) => {
      const index = tabs.findIndex(([id]) => id === tab.dataset.tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % tabs.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + tabs.length - 1) % tabs.length : -1;
      if (next < 0) return;
      event.preventDefault(); activate(tabs[next][0]); dialog.querySelector<HTMLButtonElement>(`[data-tab="${tabs[next][0]}"]`)!.focus();
    }, options);
  }
  dialog.addEventListener('input', (event) => {
    const control = event.target as HTMLInputElement | HTMLSelectElement, key = control.dataset.pref;
    if (!key) return;
    const value = control.type === 'checkbox' ? (control as HTMLInputElement).checked : control.type === 'range' ? Number(control.value) : control.value;
    callbacks.change({ [key]: value });
  }, options);
  dialog.querySelector('.settings-preview')!.addEventListener('click', callbacks.previewSound, options);
  dialog.querySelector('.settings-reset')!.addEventListener('click', () => callbacks.change({ ...DEFAULT_PREFERENCES }), options);
  dialog.querySelector('.settings-reset-panels')!.addEventListener('click', callbacks.resetPanels, options);
  return {
    open() { if (dialog.open) return; focus = document.activeElement as HTMLElement; dialog.showModal(); callbacks.visibility(); dialog.querySelector<HTMLButtonElement>('[aria-selected="true"]')!.focus(); if (active === 'sources') void loadSources(); },
    importStatus(status: ImportStatus) {
      const wasRunning = sourcesRunning; sourcesRunning = status.running; sourceControls();
      dialog.querySelector('.settings-import-progress')!.textContent = status.running ? `Importing · ${status.imported.toLocaleString()} saved` : `${status.imported.toLocaleString()} imported · ${status.unchanged.toLocaleString()} unchanged${status.failed ? ` · ${status.failed} unavailable` : ''}${status.errors.length ? ` · ${status.errors[0]}` : ''}`;
      if (wasRunning && !status.running && dialog.open && active === 'sources') void loadSources();
    },
    render(values: Preferences, saved: boolean, saving: SaveState = 'saved') {
      for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref]')) {
        const key = control.dataset.pref as keyof Preferences;
        if (control.type === 'checkbox') (control as HTMLInputElement).checked = Boolean(values[key]);
        else control.value = String(values[key]);
        const output = dialog.querySelector<HTMLOutputElement>(`[data-output="${key}"]`);
        if (output) output.value = `${values[key]}${output.dataset.unit}`;
        control.disabled = (key === 'bloom' && values.quality === 'performance') || (key === 'trailSpeed' && (!values.trailFlow || values.trails === 'off' || values.motion === 'off'));
      }
      dialog.querySelector('.settings-save-status')!.textContent = saving === 'saving' ? 'Saving preferences…' : saving === 'error' ? 'Changes applied; could not save to the local library.' : saved ? 'Saved on this device · changes apply live.' : 'Applied for this visit; storage is unavailable.';
      (dialog.querySelector('.settings-preview') as HTMLButtonElement).disabled = values.muted || !values.clickSounds || !values.clickVolume;
      refreshSelects(dialog);
    },
    audioStatus(text: string) { dialog.querySelector('.settings-audio-status')!.textContent = text; },
    dispose() { events.abort(); dialog.remove(); },
  };
}
