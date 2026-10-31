import type { ImportStatus, SourceStatus } from './types';
import { sourceName, sourceIcon, sortSources } from './sources';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function createImports(onChange: (background: boolean) => Promise<void>, onVisibility: () => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'imports-dialog';
  dialog.setAttribute('aria-labelledby', 'imports-heading');
  dialog.innerHTML = `<button class="icon-button dialog-close" aria-label="Close sources">×</button><span class="eyebrow">SessionGraph</span><h2 id="imports-heading">Explore &amp; visualize all your LLM sessions</h2><p class="imports-intro">Your history stays local. Choose the apps to read; import, search, and visualization run on this computer. No account, cloud sync, or telemetry.</p><details class="privacy-disclosure"><summary>Local data &amp; network access</summary><p>Imports are read-only and never start an AI agent. Desktop update checks contact GitHub without session content. Explicitly continuing a session opens another harness, which may contact its model provider.</p><p>Saved history and handoff files are not encrypted by SessionGraph. Your device permissions and backups affect who can access them.</p></details><div class="import-sources"></div><div class="imports-progress" role="status"></div><details class="imports-notes" hidden><summary>Import details</summary><div></div></details><footer><span>Saved locally in SQLite</span><button class="primary-button import-start">Import sessions <span>↗</span></button></footer>`;
  document.body.append(dialog);
  const search = document.createElement('input'); search.type = 'search'; search.className = 'source-search'; search.placeholder = 'Find a source…'; search.setAttribute('aria-label', 'Find a session source');
  dialog.querySelector('.import-sources')!.before(search);
  search.addEventListener('input', () => dialog.querySelectorAll<HTMLElement>('.import-source').forEach(row => { row.hidden = !row.textContent!.toLowerCase().includes(search.value.trim().toLowerCase()); }));
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  let running = false, timer = 0, disposed = false, returnFocus: HTMLElement | null = null;
  let starting = false, polling = false, background = false;
  const requests = new AbortController();
  let onboarding = false, view = 0, closeAfterImport: number | undefined;
  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`/api/sessiongraph/${path}`, { ...options, signal: AbortSignal.any([requests.signal, AbortSignal.timeout(30_000)]) }), value = await response.json();
    if (response.status === 409 && path === 'import' && options?.method === 'POST') return request<T>('import');
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
    if (disposed || polling) return;
    timer = 0;
    polling = true;
    try {
      const status = await request<ImportStatus>('import'); if (disposed) return; renderProgress(status);
      if (status.running) timer = window.setTimeout(poll, 1000);
      else {
        const completedView = closeAfterImport; closeAfterImport = undefined;
        await onChange(background);
        if (!disposed && completedView === view && dialog.open && !status.failed && !status.errors.length) dialog.close();
      }
    } catch (error) { failure(error); }
    finally { polling = false; }
  }
  function failure(error: unknown) {
    if (disposed) return;
    closeAfterImport = undefined;
    const message = error instanceof Error ? error.message : 'Import unavailable.';
    renderProgress({ running: false, discovered: 0, imported: 0, unchanged: 0, failed: 1, errors: [message] });
    $('.imports-progress').textContent = message;
  }
  async function start(sources?: string[], automatic = false) {
    if (disposed || automatic && dialog.open) return;
    if (running || starting || polling || timer) { if (!automatic && !dialog.open) void open(); return; }
    starting = true; background = automatic;
    running = true; $<HTMLButtonElement>('.import-start').disabled = true;
    closeAfterImport = onboarding && dialog.open && sources !== undefined ? view : undefined;
    try {
      const status = await request<ImportStatus>('import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'import' }, body: JSON.stringify(automatic ? { automatic: true } : { sources }) });
      if (disposed) return;
      renderProgress(status);
      window.clearTimeout(timer); timer = window.setTimeout(poll, 100);
    } catch (error) { failure(error); }
    finally { starting = false; }
  }
  async function open(first = false) {
    onboarding = first; view++;
    returnFocus = document.activeElement as HTMLElement;
    $('#imports-heading').textContent = first ? 'Explore & visualize all your LLM sessions' : 'Your session sources.';
    if (!dialog.open) dialog.showModal(); onVisibility();
    $('.import-sources').textContent = 'Finding local session sources…';
    search.value = '';
    try {
      const result = await request<{ sources: SourceStatus[] }>('sources');
      $('.import-sources').innerHTML = sortSources(result.sources).map((s) => `<label class="import-source" data-source="${escape(s.id)}"><input type="checkbox" value="${escape(s.id)}" ${s.selected || first && s.available ? 'checked' : ''} ${running ? 'disabled' : ''}/><span class="source-symbol">${sourceIcon(s.id)}</span><span><strong>${escape(s.name)}</strong><small>${escape(s.description)}</small><small class="source-imported">${s.sessions ? `${s.sessions.toLocaleString()} saved · ` : ''}${s.lastImport ? `Last import ${new Date(s.lastImport).toLocaleString()}` : 'Not imported yet'}</small></span><span class="source-detected ${s.available ? 'detected' : ''}">${s.available ? 'Detected' : 'Not found'}</span></label>`).join('');
      const status = await request<ImportStatus>('import');
      if (status.running) { renderProgress(status); window.clearTimeout(timer); timer = window.setTimeout(poll, 1000); }
      else if (!first) renderProgress(status);
    } catch (error) { $('.import-sources').textContent = error instanceof Error ? error.message : 'Could not detect sources.'; }
  }
  $('.import-start').addEventListener('click', () => void start([...dialog.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value)));
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { view++; closeAfterImport = undefined; onVisibility(); returnFocus?.focus(); });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  return { open, sources: async () => (await request<{ sources: SourceStatus[] }>('sources')).sources, select: (sources: string[]) => start(sources), get busy() { return running || starting || polling || Boolean(timer); }, refresh: (automatic = false) => start(undefined, automatic), resume: () => { background = true; running = true; window.clearTimeout(timer); void poll(); }, dispose: () => { disposed = true; requests.abort(); window.clearTimeout(timer); dialog.remove(); } };
}
