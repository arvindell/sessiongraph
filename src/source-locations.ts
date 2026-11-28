import { isTauri } from '@tauri-apps/api/core';
import type { SourceStatus } from '@sessiongraph/core/types';
import { sourceOption } from '@sessiongraph/core/sources';
import { requestLocal } from './local-api';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
interface LocationOptions { checked?: boolean; disabled?: boolean; settings?: boolean; desktop?: boolean }

export function sourceLocationContents(source: SourceStatus, options: LocationOptions = {}) {
  const hint = source.pathHint || 'Choose the harness history root, not its executable or project working directory.';
  return `${sourceOption(source, options)}${source.pathSupported ? `<details class="source-location"><summary>History location <span>${source.path ? 'Custom' : 'Automatic'}</span></summary>
    <form class="source-location-form"><fieldset ${options.disabled ? 'disabled' : ''}>
      <p class="source-location-hint">${escape(hint)}</p>
      <label>History path<input class="source-path" aria-label="${escape(source.name)} history path" value="${escape(source.path || '')}" placeholder="Automatic — paste an absolute path to override" spellcheck="false" autocomplete="off"/></label>
      <div class="source-location-actions">${options.desktop ? '<button type="button" class="secondary-button source-browse">Browse…</button>' : ''}<button type="submit" class="secondary-button">Save path</button><button type="button" class="text-button source-automatic">Automatic</button></div>
      <p class="source-location-note">Only this harness is affected. Automatic restores environment/default discovery. Saving does not start an import or grant filesystem access.</p>
    </fieldset></form><p class="source-location-status" role="status"></p></details>` : ''}`;
}

export function sourceLocationOption(source: SourceStatus, options: LocationOptions = {}) {
  return `<div class="source-setting" data-source="${escape(source.id)}">${sourceLocationContents(source, options)}</div>`;
}

export async function saveSourceLocation(source: string, path: string | null, signal?: AbortSignal): Promise<SourceStatus> {
  const result = await requestLocal<{ saved: true; source: SourceStatus }>('/api/sessiongraph/sources/path', 'Could not save history location.', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'source-path' },
    body: JSON.stringify({ source, path }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  return result.source;
}

/** Shared by onboarding and Settings; unsaved source checkboxes stay untouched. */
export function createSourceLocations(container: HTMLElement, options: { settings?: boolean; busy: (value: boolean) => void }) {
  const events = new AbortController(), desktop = isTauri();
  let locked = false, busy = false;
  const controls = () => container.querySelectorAll<HTMLFieldSetElement>('.source-location-form fieldset').forEach(fieldset => { fieldset.disabled = locked || busy; });
  function status(row: HTMLElement, text: string) { row.querySelector<HTMLElement>('.source-location-status')!.textContent = text; }
  async function save(row: HTMLElement, path: string | null) {
    if (locked || busy) return;
    if (path !== null && !path.trim()) { status(row, 'Enter a history path, or choose Automatic.'); return; }
    const restoreFocus = row.contains(document.activeElement);
    busy = true; controls(); options.busy(true);
    status(row, 'Saving history location…');
    try {
      const source = await saveSourceLocation(row.dataset.source!, path, events.signal);
      if (events.signal.aborted || !container.contains(row)) return;
      const checked = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked;
      row.innerHTML = sourceLocationContents(source, { settings: options.settings, desktop, checked, disabled: true });
      row.querySelector<HTMLDetailsElement>('details')!.open = true;
      status(row, source.available ? 'Saved. Import selected sources to read this history.' : 'Saved, but no readable history was detected here. Check the expected folder and OS permissions before importing.');
    } catch (error) {
      if (!events.signal.aborted && container.contains(row)) status(row, error instanceof Error ? error.message : 'Could not save history location.');
    } finally {
      busy = false;
      if (!events.signal.aborted) {
        controls(); options.busy(false);
        if (restoreFocus && row.closest('dialog')?.open && (document.activeElement === document.body || row.contains(document.activeElement))) row.querySelector<HTMLInputElement>('.source-path')?.focus();
      }
    }
  }
  container.addEventListener('submit', event => {
    const form = event.target as HTMLFormElement;
    if (!form.matches('.source-location-form')) return;
    event.preventDefault();
    const row = form.closest<HTMLElement>('.source-setting')!;
    void save(row, row.querySelector<HTMLInputElement>('.source-path')!.value);
  }, { signal: events.signal });
  container.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.source-automatic, .source-browse');
    if (!button || locked || busy) return;
    const row = button.closest<HTMLElement>('.source-setting')!;
    if (button.matches('.source-automatic')) { void save(row, null); return; }
    busy = true; controls(); options.busy(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ title: 'Choose harness history folder', directory: true, multiple: false });
      if (!events.signal.aborted && container.contains(row) && typeof path === 'string') {
        row.querySelector<HTMLInputElement>('.source-path')!.value = path;
        status(row, 'Folder chosen. Save path to apply it.');
      }
    } catch (error) {
      if (!events.signal.aborted && container.contains(row)) status(row, error instanceof Error ? error.message : 'Could not open the folder picker. Paste a path instead.');
    } finally { busy = false; if (!events.signal.aborted) { controls(); options.busy(false); } }
  }, { signal: events.signal });
  return {
    option: (source: SourceStatus, checked = source.selected) => sourceLocationOption(source, { settings: options.settings, desktop, checked, disabled: locked || busy }),
    setDisabled(value: boolean) { locked = value; controls(); },
    get busy() { return busy; },
    dispose() { events.abort(); },
  };
}
