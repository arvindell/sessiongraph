import type { ImportStatus, SourceStatus } from './types';
import { sourceName, sourceIcon } from './sources';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function createImports(onChange: () => Promise<void>, onVisibility: () => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'imports-dialog';
  dialog.setAttribute('aria-labelledby', 'imports-heading');
  dialog.innerHTML = `<button class="icon-button dialog-close" aria-label="Close sources">×</button><span class="eyebrow">SessionGraph</span><h2 id="imports-heading">Search &amp; visualize all your LLM sessions</h2><p class="imports-intro">Choose the apps to import. Everything stays on this computer.</p><div class="import-sources"></div><div class="imports-progress" role="status"></div><details class="imports-notes" hidden><summary>Import details</summary><div></div></details><footer><span>Saved locally in SQLite</span><button class="primary-button import-start">Import sessions <span>↗</span></button></footer>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  let running = false, timer = 0, disposed = false, returnFocus: HTMLElement | null = null;
  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`/api/sessiongraph/${path}`, options), value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Import unavailable.');
    return value;
  }
  function renderProgress(status: ImportStatus) {
    running = status.running;
    $<HTMLButtonElement>('.import-start').disabled = running;
    dialog.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = running; });
    $('.imports-progress').textContent = running
      ? `${sourceName(status.source)} · ${status.imported.toLocaleString()} imported · ${status.unchanged.toLocaleString()} unchanged${status.discovered ? ` / ${status.discovered.toLocaleString()} found` : ' · discovering…'}`
      : `${status.imported.toLocaleString()} imported · ${status.unchanged.toLocaleString()} already up to date${status.failed ? ` · ${status.failed} unavailable` : ''}`;
    $('.import-start').textContent = running ? 'Importing…' : 'Import updates ↗';
    $('.imports-notes').hidden = !status.errors.length;
    const errors = new Map<string, number>(); status.errors.forEach((error) => errors.set(error, (errors.get(error) || 0) + 1));
    $('.imports-notes div').innerHTML = [...errors].map(([error, count]) => `<p>${escape(error)}${count > 1 ? ` (${count} occurrences)` : ''}</p>`).join('');
    document.dispatchEvent(new CustomEvent('sessiongraph-import-status', { detail: status }));
  }
  async function poll() {
    if (disposed) return;
    try {
      const status = await request<ImportStatus>('import'); renderProgress(status);
      if (status.running) timer = window.setTimeout(poll, 1000);
      else { await onChange(); }
    } catch (error) { running = false; $('.imports-progress').textContent = error instanceof Error ? error.message : 'Import disconnected.'; $<HTMLButtonElement>('.import-start').disabled = false; }
  }
  async function start(sources?: string[]) {
    if (running) { if (!dialog.open) dialog.showModal(); onVisibility(); return; }
    try {
      renderProgress(await request<ImportStatus>('import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'import' }, body: JSON.stringify({ sources }) }));
      window.clearTimeout(timer); timer = window.setTimeout(poll, 100);
    } catch (error) { $('.imports-progress').textContent = error instanceof Error ? error.message : 'Import unavailable.'; }
  }
  async function open(first = false) {
    returnFocus = document.activeElement as HTMLElement;
    $('#imports-heading').textContent = first ? 'Search & visualize all your LLM sessions' : 'Your session sources.';
    if (!dialog.open) dialog.showModal(); onVisibility();
    $('.import-sources').textContent = 'Finding local session sources…';
    try {
      const result = await request<{ sources: SourceStatus[] }>('sources');
      $('.import-sources').innerHTML = result.sources.map((s) => `<label class="import-source" data-source="${escape(s.id)}"><input type="checkbox" value="${escape(s.id)}" ${s.selected || first && s.available ? 'checked' : ''} ${running ? 'disabled' : ''}/><span class="source-symbol">${sourceIcon(s.id)}</span><span><strong>${escape(s.name)}</strong><small>${escape(s.description)}</small><small class="source-imported">${s.sessions ? `${s.sessions.toLocaleString()} saved · ` : ''}${s.lastImport ? `Last import ${new Date(s.lastImport).toLocaleString()}` : 'Not imported yet'}</small></span><span class="source-detected ${s.available ? 'detected' : ''}">${s.available ? 'Detected' : 'Not found'}</span></label>`).join('');
      const status = await request<ImportStatus>('import');
      if (status.running) { renderProgress(status); window.clearTimeout(timer); timer = window.setTimeout(poll, 1000); }
      else if (!first) renderProgress(status);
    } catch (error) { $('.import-sources').textContent = error instanceof Error ? error.message : 'Could not detect sources.'; }
  }
  $('.import-start').addEventListener('click', () => void start([...dialog.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value)));
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { onVisibility(); returnFocus?.focus(); });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  return { open, refresh: () => start(), resume: () => { window.clearTimeout(timer); void poll(); }, dispose: () => { disposed = true; window.clearTimeout(timer); dialog.remove(); } };
}
