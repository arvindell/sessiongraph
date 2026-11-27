import { escapeMarkup, icon, type IconName } from './icons';
import './graph-ui.css';

/** Only presentation data enters these helpers, never a local session record. */
export function sessionInfo(rows: readonly (readonly [IconName, string, string])[], extra = '', open = true) {
  return `<details class="session-info graph-session-info"${open ? ' open' : ''}><summary>Session info ${icon('chevron-down')}</summary><dl>
    ${rows.map(([glyph, label, value]) => `<div><dt>${icon(glyph)}${escapeMarkup(label)}</dt><dd>${escapeMarkup(value)}</dd></div>`).join('')}
  </dl>${extra}</details>`;
}

export function graphButton(glyph: IconName, label: string, attributes: Record<string, string | boolean> = {}, title = label, text = '') {
  const attrs = Object.entries(attributes).flatMap(([key, value]) => value === false ? [] : [value === true ? key : `${key}="${escapeMarkup(value)}"`]);
  return `<button type="button" class="graph-button${text ? ' graph-button-labeled' : ''}" aria-label="${escapeMarkup(label)}" title="${escapeMarkup(title)}" ${attrs.join(' ')}>${icon(glyph)}${text ? `<span>${escapeMarkup(text)}</span>` : ''}</button>`;
}

export const mapShortcut = {
  search: ['search', '/', 'Search'],
  fit: ['crosshair', 'F', 'Fit view'],
  panels: ['panels', 'H', 'Panels'],
  clear: ['x', 'Esc', 'Clear selection'],
} as const;

export function shortcutHints(keys: readonly (keyof typeof mapShortcut)[], cls: string) {
  return `<aside class="graph-shortcuts ${escapeMarkup(cls)}" aria-label="Keyboard shortcuts">${keys.map(key => {
    const [glyph, binding, label] = mapShortcut[key];
    return `<span>${icon(glyph)}<kbd>${binding}</kbd>${label}</span>`;
  }).join('')}</aside>`;
}

export function soundButton(muted: boolean) {
  return { glyph: muted ? 'volume-x' : 'volume-2', label: muted ? 'Unmute sound' : 'Mute sound' } as const;
}

export function graphHelp(id: string, keys: readonly (keyof typeof mapShortcut)[], extra = '') {
  const hints = keys.map(key => mapShortcut[key]);
  return `<dialog class="graph-help" id="${id}" aria-labelledby="${id}-title">${graphButton('x', 'Close help', { 'data-close-help': true })}<h2 id="${id}-title">Explore the map</h2>
    <div class="graph-help-rows"><div><span>Orbit</span><kbd>Drag</kbd></div><div><span>Zoom</span><kbd>Scroll / pinch</kbd></div><div><span>Pan</span><kbd>Right-drag</kbd></div>
    ${hints.map(([glyph, key, label]) => `<div><span>${icon(glyph)}${label}</span><kbd>${key}</kbd></div>`).join('')}</div>
    <p>Time runs left to right. Select a session to inspect its details, or click empty space to clear the selection.</p>${extra}</dialog>`;
}
