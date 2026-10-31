import { DEFAULT_PREFERENCES, type Preferences } from './preferences';
import { createElement, PanelsTopLeft, Volume2, Sparkles, Orbit, type IconNode } from 'lucide';
import { refreshSelects } from './controls';

type Section = 'interface' | 'audio' | 'graphics' | 'trails';
const tabs: [Section, string, IconNode][] = [['interface', 'Interface', PanelsTopLeft], ['audio', 'Sound', Volume2], ['graphics', 'Graphics', Sparkles], ['trails', 'Trails & playback', Orbit]];
const toggle = (key: keyof Preferences, label: string, hint: string) => `<label class="setting-row"><span><strong>${label}</strong><small>${hint}</small></span><input type="checkbox" role="switch" data-pref="${key}" aria-label="${label}"/></label>`;
const range = (key: keyof Preferences, label: string, hint: string, min: number, max: number, unit = '%', step = 1) => `<label class="setting-row setting-range"><span><strong>${label}</strong><small>${hint}</small></span><span class="setting-slider"><input type="range" data-pref="${key}" aria-label="${label}" min="${min}" max="${max}" step="${step}"/><output data-output="${key}" data-unit="${unit}"></output></span></label>`;
const select = (key: keyof Preferences, label: string, hint: string, options: [string, string][]) => `<label class="setting-row"><span><strong>${label}</strong><small>${hint}</small></span><select data-pref="${key}" aria-label="${label}">${options.map(([value, title]) => `<option value="${value}">${title}</option>`).join('')}</select></label>`;

export function createSettings(callbacks: { change: (patch: Partial<Preferences>) => void; visibility: () => void; previewSound: () => void; resetPanels: () => void }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog'; dialog.setAttribute('aria-labelledby', 'settings-title');
  dialog.innerHTML = `<header class="settings-heading"><div><span class="settings-eyebrow">YOUR CORNER OF THE COSMOS</span><h2 id="settings-title">Make yourself at home.</h2><p>Tune the atmosphere. Find your focus.</p></div><button class="icon-button settings-close" aria-label="Close settings">×</button></header>
    <div class="settings-layout"><nav class="settings-tabs" role="tablist" aria-label="Settings categories">${tabs.map(([id, name, glyph], i) => `<button role="tab" id="settings-tab-${id}" aria-controls="settings-${id}" aria-selected="${!i}" tabindex="${i ? -1 : 0}" data-tab="${id}">${createElement([glyph[0], { ...glyph[1], 'aria-hidden': 'true', 'stroke-width': 1.5 }, glyph[2]]).outerHTML}${name}</button>`).join('')}</nav>
    <div class="settings-content">
      <section id="settings-interface" role="tabpanel" aria-labelledby="settings-tab-interface"><h3>Less friction. More focus.</h3><p class="settings-description">A workspace that feels right, every time you return.</p>
        ${select('view', 'Default view', 'Switch between depth and a flat timeline.', [['3d', '3D galaxy'], ['2d', '2D timeline']])}
        ${select('motion', 'Motion', 'Camera transitions, reveals, and ambient movement.', [['system', 'Follow system'], ['on', 'On'], ['off', 'Off']])}
        ${select('density', 'Session list', 'Make a little more room for your history.', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}
        ${range('panelOpacity', 'Panel opacity', 'Let more of the map show through.', 55, 100)}
        <div class="settings-note"><span>Moved things around?</span><button class="secondary-button settings-reset-panels">Reset panel positions</button></div>
      </section>
      <section id="settings-audio" role="tabpanel" aria-labelledby="settings-tab-audio" hidden><h3>A little feedback.</h3><p class="settings-description">Soft interaction tones, synthesized locally when you use a control.</p>
        ${toggle('muted', 'Mute all sound', 'Silence everything. Your volume levels are kept.')}
        ${toggle('clickSounds', 'Interaction sounds', 'A soft tick for controls; a chime for sessions.')}
        ${range('clickVolume', 'Interaction volume', 'Keep feedback as subtle as you like.', 0, 100)}
        <div class="settings-note"><span class="settings-audio-status" role="status">Sound starts after your first interaction.</span><button class="secondary-button settings-preview" data-sound="none">Preview chime</button></div>
        <p class="settings-footnote">Audio pauses while this tab is hidden. The speaker button on the map is a quick mute.</p>
      </section>
      <section id="settings-graphics" role="tabpanel" aria-labelledby="settings-tab-graphics" hidden><h3>Set the scene.</h3><p class="settings-description">Balance a luminous map with a lighter footprint.</p>
        ${select('quality', 'Render quality', 'Performance uses 1× resolution and skips post-process effects.', [['performance', 'Performance'], ['balanced', 'Balanced'], ['high', 'High fidelity']])}
        ${range('bloom', 'Glow strength', 'Soft light around bright nodes; disabled in Performance.', 0, 75)}
        ${range('nodeScale', 'Node size', 'Scale the lights without changing their positions.', 60, 180)}
        ${toggle('stars', 'Starfield', 'A faint field of stars behind the timeline.')}
        ${toggle('labels', 'Map labels', 'Directory names and the selected session title.')}
        ${toggle('focusDimming', 'Focus dimming', 'Quiet surrounding nodes when a session is selected.')}
      </section>
      <section id="settings-trails" role="tabpanel" aria-labelledby="settings-tab-trails" hidden><h3>Follow the thread.</h3><p class="settings-description">Trails always start at creation and meet the node at the latest recorded message.</p>
        ${select('trails', 'Session trails', 'Choose how much history to draw on the map.', [['all', 'All sessions'], ['selected', 'Selected session'], ['off', 'Hidden']])}
        ${range('trailOpacity', 'Trail brightness', 'Fade lifetime trails into the background.', 0, 100)}
        ${toggle('trailFlow', 'Flowing trails', 'A decorative pulse along each lifetime; respects Motion.')}
        ${range('trailSpeed', 'Flow speed', 'How quickly the light travels along the trails.', 10, 100)}
        ${toggle('relationships', 'Relationship links', 'Show recorded fork and child connections.')}
        ${toggle('messageDots', 'Message & event dots', 'Clickable user, assistant, tool, and event markers on the selected trail.')}
        ${range('playbackSpeed', 'Playback speed', '1× plays the full timeline in 30 seconds.', .25, 3, '×', .25)}
        <p class="settings-footnote">Flow is decorative. Message dots reflect saved timestamps; visual settings never alter your history.</p>
      </section>
    </div></div><footer class="settings-footer"><span class="settings-save-status" role="status">Changes save automatically on this device.</span><button class="text-button settings-reset">Restore defaults</button><button class="primary-button settings-done">Done</button></footer>`;
  document.body.append(dialog);
  const events = new AbortController(), options = { signal: events.signal };
  let focus: HTMLElement | null = null;
  const close = () => dialog.close();
  for (const selector of ['.settings-close', '.settings-done']) dialog.querySelector(selector)!.addEventListener('click', close, options);
  dialog.addEventListener('close', () => { callbacks.visibility(); focus?.focus({ preventScroll: true }); }, options);
  dialog.addEventListener('keydown', (event) => { event.stopPropagation(); }, options);
  function activate(id: string) {
    for (const [section] of tabs) {
      const tab = dialog.querySelector<HTMLButtonElement>(`[data-tab="${section}"]`)!;
      tab.setAttribute('aria-selected', String(section === id)); tab.tabIndex = section === id ? 0 : -1;
      dialog.querySelector<HTMLElement>(`#settings-${section}`)!.hidden = section !== id;
    }
    dialog.querySelector('.settings-content')!.scrollTop = 0;
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
    open() { if (dialog.open) return; focus = document.activeElement as HTMLElement; dialog.showModal(); callbacks.visibility(); dialog.querySelector<HTMLButtonElement>('[aria-selected="true"]')!.focus(); },
    render(values: Preferences, saved: boolean) {
      for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-pref]')) {
        const key = control.dataset.pref as keyof Preferences;
        if (control.type === 'checkbox') (control as HTMLInputElement).checked = Boolean(values[key]);
        else control.value = String(values[key]);
        const output = dialog.querySelector<HTMLOutputElement>(`[data-output="${key}"]`);
        if (output) output.value = `${values[key]}${output.dataset.unit}`;
        control.disabled = (key === 'bloom' && values.quality === 'performance') || (key === 'trailSpeed' && (!values.trailFlow || values.trails === 'off' || values.motion === 'off'));
      }
      dialog.querySelector('.settings-save-status')!.textContent = saved ? 'Saved on this device · changes apply live.' : 'Applied for this visit; local storage is unavailable.';
      (dialog.querySelector('.settings-preview') as HTMLButtonElement).disabled = values.muted || !values.clickSounds || !values.clickVolume;
      refreshSelects(dialog);
    },
    audioStatus(text: string) { dialog.querySelector('.settings-audio-status')!.textContent = text; },
    dispose() { events.abort(); dialog.remove(); },
  };
}
