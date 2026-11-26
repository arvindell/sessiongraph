import type { ImportStatus, SourceStatus } from '@sessiongraph/core/types';
import { sourceName, sourceOption, sortSources } from '@sessiongraph/core/sources';

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function createImports(onChange: (background: boolean) => Promise<void>, onVisibility: () => void, notice: (message: string) => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'imports-dialog';
  dialog.setAttribute('aria-labelledby', 'imports-heading');
  dialog.innerHTML = `<button class="icon-button dialog-close" aria-label="Close sources">×</button><span class="eyebrow">SessionGraph</span><h2 id="imports-heading">Explore &amp; visualize all your LLM sessions</h2><p class="imports-intro">Your history stays local. Choose the apps to read; import, search, and visualization run on this computer. No account, cloud sync, or telemetry.</p><details class="privacy-disclosure"><summary>Local data &amp; network access</summary><p>Imports are read-only and never start an AI agent. Desktop update checks contact GitHub without session content. Explicitly continuing a session opens another harness, which may contact its model provider.</p><p>Saved history and handoff files are not encrypted by SessionGraph. Your device permissions and backups affect who can access them.</p></details><div class="import-sources"></div><div class="imports-progress" role="status"></div><details class="imports-notes" hidden><summary>Import details</summary><div></div></details><footer><span>Saved locally in SQLite</span><button class="primary-button import-start">Import sessions <span>↗</span></button></footer>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  let running = false, timer = 0, disposed = false, returnFocus: HTMLElement | null = null;
  let starting = false, polling = false, background = false;
  const requests = new AbortController();
  let onboarding = false, view = 0, loadingSources = false, sourcesReady = false, setupImport = false;
  function renderAction() {
    const selected = dialog.querySelectorAll('input:checked').length;
    $<HTMLButtonElement>('.import-start').disabled = running || starting || loadingSources;
    $('.import-start').textContent = running || starting ? 'Importing…' : loadingSources ? 'Finding sources…' : !sourcesReady ? 'Try again' : onboarding ? selected ? 'Import & continue →' : 'Continue without importing →' : 'Import updates ↗';
    dialog.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = running || starting; });
  }
  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`/api/sessiongraph/${path}`, { ...options, signal: AbortSignal.any([requests.signal, AbortSignal.timeout(30_000)]) }), value = await response.json();
    if (response.status === 409 && path === 'import' && options?.method === 'POST') return request<T>('import');
    if (!response.ok) throw new Error(value.error || 'Import unavailable.');
    return value;
  }
  function renderProgress(status: ImportStatus) {
    running = status.running;
    renderAction();
    $('.imports-progress').textContent = running
      ? `${status.source ? sourceName(status.source) : 'Importing'} · ${status.imported.toLocaleString()} imported · ${status.unchanged.toLocaleString()} unchanged${status.discovered ? ` / ${status.discovered.toLocaleString()} found` : ' · discovering…'}`
      : `${status.imported.toLocaleString()} imported · ${status.unchanged.toLocaleString()} already up to date${status.failed ? ` · ${status.failed} unavailable` : ''}`;
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
        const completedSetup = setupImport; setupImport = false;
        await onChange(background);
        if (!disposed && completedSetup) notice(status.failed
          ? 'Import finished with some unavailable history. Open Manage sources for details or to retry.'
          : status.imported + status.unchanged ? 'Your sessions are ready to explore.' : 'No conversations found. You can choose other sources in Manage sources.');
      }
    } catch (error) { failure(error); }
    finally { polling = false; }
  }
  function failure(error: unknown) {
    if (disposed) return;
    setupImport = false;
    const message = error instanceof Error ? error.message : 'Import unavailable.';
    renderProgress({ running: false, discovered: 0, imported: 0, unchanged: 0, failed: 1, errors: [message] });
    $('.imports-progress').textContent = message;
    if (!dialog.open) notice(`${message} Open Manage sources to retry.`);
  }
  async function start(sources?: string[], automatic = false) {
    if (disposed || automatic && dialog.open) return;
    if (running || starting || polling || timer) { if (!automatic && !dialog.open) void open(); return; }
    starting = true; background = automatic;
    running = true; renderAction();
    const initialSetup = onboarding && dialog.open && sources !== undefined, startedView = view;
    try {
      const status = await request<ImportStatus>('import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionGraph-Action': 'import' }, body: JSON.stringify(automatic ? { automatic: true } : { sources }) });
      if (disposed) return;
      renderProgress(status);
      if (initialSetup) {
        setupImport = Boolean(sources?.length);
        if (view === startedView && dialog.open) dialog.close();
        if (sources?.length) notice('Import started. You can explore the map as soon as your sessions are ready.');
        await onChange(true);
      }
      if (disposed) return;
      window.clearTimeout(timer); timer = window.setTimeout(poll, 100);
    } catch (error) { failure(error); }
    finally { starting = false; if (!disposed) renderAction(); }
  }
  async function open(first = false) {
    onboarding = first; const openedView = ++view;
    loadingSources = true; sourcesReady = false;
    returnFocus = document.activeElement as HTMLElement;
    $('#imports-heading').textContent = first ? 'Explore & visualize all your LLM sessions' : 'Your session sources.';
    $('footer > span').textContent = first ? 'You can change sources later.' : 'Saved locally in SQLite';
    if (first) { $('.imports-progress').textContent = 'Detected conversation sources are selected for you.'; $('.imports-notes').hidden = true; }
    renderAction();
    if (!dialog.open) dialog.showModal(); onVisibility();
    $('.import-sources').textContent = 'Finding local session sources…';
    try {
      const result = await request<{ sources: SourceStatus[] }>('sources');
      if (disposed || openedView !== view) return;
      $('.import-sources').innerHTML = sortSources(result.sources).map((source) => sourceOption(source, { checked: source.selected || first && source.available && source.capabilities.history, disabled: running })).join('');
      sourcesReady = true;
      if (first && !dialog.querySelector('input:checked')) $('.imports-progress').textContent = 'No conversation sources selected. You can choose sources now or add them later.';
      const status = await request<ImportStatus>('import');
      if (disposed || openedView !== view) return;
      if (status.running) { renderProgress(status); window.clearTimeout(timer); timer = window.setTimeout(poll, 1000); }
      else if (!first) renderProgress(status);
    } catch (error) { if (!disposed && openedView === view) { sourcesReady = false; $('.import-sources').textContent = error instanceof Error ? error.message : 'Could not detect sources.'; } }
    finally { if (!disposed && openedView === view) { loadingSources = false; renderAction(); } }
  }
  $('.import-sources').addEventListener('change', renderAction);
  $('.import-start').addEventListener('click', () => { if (!sourcesReady) void open(onboarding); else void start([...dialog.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value)); });
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { view++; loadingSources = false; onVisibility(); returnFocus?.focus(); });
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  return { open, sources: async () => (await request<{ sources: SourceStatus[] }>('sources')).sources, select: (sources: string[]) => start(sources), get busy() { return running || starting || polling || Boolean(timer); }, refresh: (automatic = false) => start(undefined, automatic), resume: () => { background = true; running = true; window.clearTimeout(timer); void poll(); }, dispose: () => { disposed = true; requests.abort(); window.clearTimeout(timer); dialog.remove(); } };
}
