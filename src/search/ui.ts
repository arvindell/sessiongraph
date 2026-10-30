import { excerpt, normalize, parseQuery, words } from './engine';
import type { SessionAtlasData, Session } from '../types';
import { sourceName, sourceIcon } from '../sources';
import { contentVersion } from './persistence';
import type { ContentPage, IndexStatus, SearchHit, SearchRequest, SearchResponse } from './types';

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function highlight(text: string, terms: string[]): string {
  const tokens = new Set(terms.map(normalize));
  let last = 0, html = '';
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    html += escape(text.slice(last, match.index));
    const value = normalize(match[0]);
    const matched = [...tokens].some((token) => value.startsWith(token));
    html += matched ? `<mark>${escape(match[0])}</mark>` : escape(match[0]);
    last = match.index + match[0].length;
  }
  return html + escape(text.slice(last));
}

export function createSessionSearch(onChoose: (id: string) => void, onVisibility: (open: boolean) => void = () => {}, onOpen?: (session: Session) => void) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const events = new AbortController();
  const options = { signal: events.signal };
  const dialog = document.createElement('dialog');
  dialog.className = 'search-dialog';
  dialog.setAttribute('aria-label', 'Search sessions');
  dialog.innerHTML = `
    <div class="search-command"><span class="search-command-icon" aria-hidden="true">⌕</span><input id="session-query" type="search" placeholder="Search sessions, messages, files…" autocomplete="off" spellcheck="false" role="combobox" aria-label="Search all sessions" aria-autocomplete="list" aria-expanded="true" aria-controls="search-results"/><button class="icon-button search-close" aria-label="Close search" title="Close (Esc)">×</button></div>
    <div class="search-options"><select id="search-scope" aria-label="Search scope" title="Switch scope (Alt+S)"><option value="all">All history</option><option value="view">Current view</option></select><button id="search-conversations" class="search-chip" aria-label="Index conversations" aria-pressed="true" title="Pause or resume background indexing. Indexed messages, tools, and files remain searchable.">Conversations</button><span id="search-index-state" role="status">Loading index…</span></div>
    <div class="search-body"><div id="search-results" class="search-results" role="listbox" aria-label="Matching sessions"><div class="search-results-inner"></div></div><aside id="search-preview" class="search-preview" aria-label="Session preview"></aside></div>
    <div class="search-footer"><span id="search-result-status" role="status">Loading sessions…</span><button id="search-more" hidden>More results</button><details class="search-syntax"><summary title="Search filters and cache">Filters</summary><div><code>project:quentli</code><code>model:claude</code><code>in:files package.json</code><code>is:fork</code><code>after:2026-09-01</code><code>"exact phrase"</code><button id="search-clear-cache" title="Clear saved search text and pause indexing. Titles remain searchable; enable Conversations to rebuild.">Clear saved index</button></div></details><span class="search-keys"><kbd>↑↓</kbd> navigate <kbd>↵</kbd> open</span></div>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const input = $<HTMLInputElement>('#session-query');
  const list = $('#search-results');
  const inner = $('.search-results-inner');
  const preview = $('#search-preview');
  const scope = $<HTMLSelectElement>('#search-scope');
  let sessions = new Map<string, Session>(), projects = new Map<string, string>();
  let sourceID: string | undefined;
  let hits: SearchHit[] = [], active = 0, total = 0, request = 0, limit = 80;
  let queryFrame = 0, started = 0, elapsed = 0, pending = false, composing = false;
  let conversations = true, status: IndexStatus | undefined;
  let returnFocus: HTMLElement | null = null;
  let previewController: AbortController | undefined;
  let previewTimer = 0, previewKey = '';
  let errorMessage = '', selectionTouched = false;
  const cache = new Map<string, ContentPage>();
  const ROW_HEIGHT = 86;
  const send = (message: SearchRequest) => worker.postMessage(message);

  function updateStatus() {
    if (!status) return;
    const state = $('#search-index-state');
    state.textContent = status.storage === 'restoring' ? 'Restoring saved index…' : status.complete === status.total && status.total ? `Conversations ready${status.storage === 'local' ? ' · saved locally' : ''}` : `${status.indexed.toLocaleString()} / ${status.total.toLocaleString()} conversations${!conversations ? ' · paused' : status.active ? ' · indexing' : ' · partial'}`;
    state.title = `Titles and metadata cover all ${status.total.toLocaleString()} imported sessions. ${status.complete.toLocaleString()} conversations have all supported text indexed. ${status.failed ? `${status.failed} unavailable; toggle Conversations to retry. ` : ''}${status.limited ? 'Large histories are sampled; missing matches may be in unindexed text. ' : ''}${status.storage === 'memory' ? 'Saving unavailable; search continues in memory.' : `Saved in local SQLite. ${status.restored.toLocaleString()} conversations restored; unchanged pages are reused. Clear saved index under Filters. Imported sessions remain saved.`}`;
  }
  function renderRows() {
    inner.style.height = `${hits.length * ROW_HEIGHT}px`;
    if (!hits.length) {
      inner.innerHTML = `<div class="search-empty">${escape(errorMessage || (pending ? 'Searching…' : input.value ? 'No matching sessions' : 'No sessions available'))}</div>`;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_HEIGHT) - 3);
    const end = Math.min(hits.length, start + Math.ceil(list.clientHeight / ROW_HEIGHT) + 7);
    inner.innerHTML = hits.slice(start, end).map((hit, offset) => {
      const i = start + offset, session = sessions.get(hit.id)!;
      if (!session) return '';
      const meta = `${sourceName(session.source)} · ${projects.get(session.projectID) || session.directory.split('/').at(-1) || 'Global'} · ${new Date(session.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      return `<div id="search-hit-${i}" class="search-result ${i === active ? 'active' : ''}" role="option" aria-selected="${i === active}" aria-posinset="${i + 1}" aria-setsize="${total}" data-result-index="${i}" style="top:${i * ROW_HEIGHT}px"><div class="search-result-title">${highlight(session.title, hit.terms)}</div><div class="search-result-meta"><span>${sourceIcon(session.source)}${escape(meta)}</span><span class="match-kind">${escape(hit.source)}</span></div>${hit.excerpt ? `<div class="search-result-excerpt">${highlight(hit.excerpt, hit.terms)}</div>` : `<div class="search-result-excerpt">${escape(session.model)}</div>`}</div>`;
    }).join('');
    if (active >= start && active < end) input.setAttribute('aria-activedescendant', `search-hit-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function renderPreview(page?: ContentPage, loading = false, failed = false) {
    const hit = hits[active], session = hit && sessions.get(hit.id);
    if (!session) { preview.innerHTML = ''; return; }
    const terms = hit.terms.length ? hit.terms : words(parseQuery(input.value).text);
    const matching = page?.fragments.filter((fragment) => {
      const text = normalize(fragment.text);
      return terms.length && terms.every((term) => text.includes(term));
    }).slice(0, 4) || [];
    const conversation = page?.fragments.filter((f) => ['You', 'Assistant'].includes(f.kind)).slice(0, 5).reverse() || [];
    const lines = matching.length ? matching : conversation;
    preview.innerHTML = `<div class="search-preview-heading"><span>${escape(projects.get(session.projectID) || 'Session')}</span><h2>${highlight(session.title, terms)}</h2><p>${escape(session.model)} · ${new Date(session.created).toLocaleDateString()}</p><button class="secondary-button search-open">Explore session <span aria-hidden="true">↗</span></button></div>${hit.excerpt ? `<section class="search-preview-section"><h3>Matching passage</h3><p>${highlight(hit.excerpt, terms)}</p></section>` : ''}<section class="search-preview-section"><h3>${matching.length ? 'Matching context' : 'Recent conversation'}</h3>${loading ? '<p class="preview-loading">Loading preview…</p>' : failed ? '<p>Preview unavailable.</p><button class="text-button preview-retry">Retry</button>' : lines.length ? lines.map((fragment) => `<article><span>${escape(fragment.kind)}</span><p>${highlight(excerpt(fragment.text, terms, 360), terms)}</p></article>`).join('') : '<p>No conversation text in this batch.</p>'}${page && (page.nextCursor || page.truncated) ? '<p class="preview-coverage">Recent messages · partial preview</p>' : ''}</section>`;
    preview.querySelector('.search-open')?.addEventListener('click', choose, options);
    if (onOpen) {
      const button = document.createElement('button');
      button.className = 'text-button search-launch'; button.innerHTML = `${sourceIcon(session.source)}Open in ${escape(sourceName(session.source))} ↗`;
      button.addEventListener('click', () => onOpen(session), options);
      preview.querySelector('.search-preview-heading')?.append(button);
    }
    preview.querySelector('.preview-retry')?.addEventListener('click', () => { previewKey = ''; schedulePreview(); }, options);
  }
  function schedulePreview() {
    const hit = hits[active], session = hit && sessions.get(hit.id);
    const key = session ? `${session.id}:${contentVersion(session)}:${input.value}` : '';
    if (key === previewKey) return;
    previewKey = key;
    window.clearTimeout(previewTimer);
    previewController?.abort();
    if (!session) { renderPreview(); return; }
    const cacheKey = `${session.id}:${contentVersion(session)}`;
    const cached = cache.get(cacheKey);
    if (cached) { renderPreview(cached); return; }
    renderPreview(undefined, true);
    previewTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      previewController = controller;
      try {
        const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(session.id)}/content?updated=${session.updated}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Preview unavailable');
        const page = await response.json() as ContentPage;
        if (controller.signal.aborted || key !== previewKey) return;
        if (cache.size >= 25) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, page);
        renderPreview(page);
      } catch { if (!controller.signal.aborted && key === previewKey) renderPreview(undefined, false, true); }
    }, 90);
  }
  function runQuery() {
    cancelAnimationFrame(queryFrame);
    pending = true;
    input.setAttribute('aria-busy', 'true');
    const current = ++request;
    started = performance.now();
    queryFrame = requestAnimationFrame(() => send({ type: 'query', request: current, text: input.value, viewOnly: scope.value === 'view', limit }));
  }
  function changeQuery() {
    active = 0; selectionTouched = false; limit = 80; list.scrollTop = 0; previewKey = '';
    runQuery();
  }
  function move(offset: number) {
    if (!hits.length) return;
    selectionTouched = true;
    active = Math.max(0, Math.min(hits.length - 1, active + offset));
    const y = active * ROW_HEIGHT;
    if (y < list.scrollTop) list.scrollTop = y;
    else if (y + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_HEIGHT - list.clientHeight;
    renderRows(); schedulePreview();
  }
  function close() {
    dialog.close();
    onVisibility(false);
    previewController?.abort(); window.clearTimeout(previewTimer);
    previewKey = '';
    returnFocus?.focus({ preventScroll: true });
  }
  function choose() {
    const hit = hits[active];
    if (!hit || pending) return;
    close(); onChoose(hit.id);
  }
  function open() {
    if (!dialog.open) { returnFocus = document.activeElement as HTMLElement; dialog.showModal(); }
    onVisibility(true);
    input.focus({ preventScroll: true }); input.select();
    runQuery();
    if (conversations) send({ type: 'warm', enabled: true });
  }
  worker.onmessage = (event: MessageEvent<SearchResponse>) => {
    const message = event.data;
    if (message.type === 'status') { status = message.status; updateStatus(); return; }
    if (message.type === 'error') { errorMessage = message.message; pending = false; input.setAttribute('aria-busy', 'false'); renderRows(); return; }
    if (message.request !== request) return;
    const selected = hits[active]?.id;
    elapsed = pending ? performance.now() - started : elapsed;
    pending = false; input.setAttribute('aria-busy', 'false');
    hits = message.hits; total = message.total; errorMessage = message.error || '';
    active = Math.max(0, Math.min(hits.length - 1, selectionTouched && selected ? hits.findIndex((hit) => hit.id === selected) : 0));
    $('#search-result-status').textContent = errorMessage || `${total.toLocaleString()} ${input.value ? 'matches' : 'sessions'} · ${Math.round(message.elapsed)} ms`;
    $('#search-more').hidden = hits.length >= total || limit >= 250;
    if (dialog.open) { renderRows(); schedulePreview(); }
  };
  worker.onerror = () => { errorMessage = 'Search could not start. Reload to retry.'; pending = false; renderRows(); };
  input.addEventListener('input', () => { if (!composing) changeQuery(); }, options);
  input.addEventListener('compositionstart', () => { composing = true; }, options);
  input.addEventListener('compositionend', () => { composing = false; changeQuery(); }, options);
  scope.addEventListener('change', changeQuery, options);
  list.addEventListener('scroll', renderRows, options);
  list.addEventListener('click', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('[data-result-index]');
    if (!row) return;
    active = Number(row.dataset.resultIndex); selectionTouched = true; renderRows(); schedulePreview(); input.focus();
  }, options);
  list.addEventListener('dblclick', choose, options);
  $('#search-more').addEventListener('click', () => { limit = Math.min(250, limit + 80); runQuery(); }, options);
  $('#search-conversations').addEventListener('click', () => {
    conversations = !conversations;
    $('#search-conversations').setAttribute('aria-pressed', String(conversations));
    send({ type: 'warm', enabled: conversations }); updateStatus();
  }, options);
  $('#search-clear-cache').addEventListener('click', () => {
    conversations = false;
    $('#search-conversations').setAttribute('aria-pressed', 'false');
    cache.clear(); previewKey = ''; previewController?.abort(); window.clearTimeout(previewTimer);
    $<HTMLDetailsElement>('.search-syntax').open = false;
    send({ type: 'clear-cache' }); input.focus();
  }, options);
  $('.search-close').addEventListener('click', close, options);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }, options);
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (composing || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); move((event.key === 'PageDown' ? 1 : -1) * Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT))); }
    if (event.key === 'Enter' && event.target === input) { event.preventDefault(); choose(); }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key.toLowerCase() === 's' && event.altKey) { event.preventDefault(); scope.value = scope.value === 'view' ? 'all' : 'view'; changeQuery(); }
  }, options);
  document.addEventListener('keydown', (event) => {
    if (dialog.open || document.querySelector('dialog[open]')) return;
    const target = event.target as HTMLElement;
    const editable = target.isContentEditable || target.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, select');
    if ((event.key === '/' && !editable && !event.ctrlKey && !event.metaKey && !event.altKey) || (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault(); open();
    }
  }, options);
  const observer = new ResizeObserver(() => { if (dialog.open) renderRows(); });
  observer.observe(list);
  return {
    open,
    setData(data: SessionAtlasData) {
      if (sourceID !== data.sourceID) { cache.clear(); previewKey = ''; previewController?.abort(); window.clearTimeout(previewTimer); }
      sourceID = data.sourceID;
      sessions = new Map(data.sessions.map((s) => [s.id, s])); projects = new Map(data.projects.map((p) => [p.id, p.name]));
      send({ type: 'data', sessions: data.sessions, projects: data.projects, sourceID });
    },
    setScope(ids: string[]) { send({ type: 'scope', ids }); },
    diagnostics: () => ({ open: dialog.open, query: input.value, matches: total, renderedRows: inner.querySelectorAll('[role="option"]').length, roundTripMs: elapsed, pending, index: status }),
    dispose() { worker.terminate(); events.abort(); observer.disconnect(); previewController?.abort(); window.clearTimeout(previewTimer); cancelAnimationFrame(queryFrame); dialog.remove(); },
  };
}
