import { timelineColor, timelineLabel, type TimelineItem, type TimelinePage, type TimelineSummary } from './timeline';
import type { Session } from './types';
import { sourceName } from './sources';
import type { TimelineClient } from './timeline-client';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const time = (value: number | null) => value === null ? 'Time not recorded' : timestamp.format(value);
const badge = (item: Pick<TimelineSummary, 'kind' | 'role'>) => `<span class="event-badge" style="--event-color:${timelineColor(item)}">${timelineLabel(item)}</span>`;

export function createEventExplorer(container: HTMLElement, client: TimelineClient, callbacks: { select: (item: TimelineItem | null) => void }) {
  const panel = document.createElement('aside');
  panel.className = 'event-panel glass'; panel.id = 'message-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'event-title');
  panel.innerHTML = `<header class="event-heading"><h2 id="event-title">Messages</h2><button class="icon-button event-close" aria-label="Close message details">×</button></header>
    <div class="event-detail-nav"><button class="secondary-button" data-step="previous" aria-label="Previous message" title="Previous message (← / ↑)">← Previous</button><span class="event-position" role="status"></span><button class="secondary-button" data-step="next" aria-label="Next message" title="Next message (→ / ↓)">Next →</button></div>
    <div class="event-scroll"><article class="event-content" aria-label="Message details" tabindex="0"></article>
      <details class="event-browser"><summary>Browse messages <span class="event-count"></span></summary>
        <nav class="event-list" aria-label="Session messages"></nav><div class="event-pagination"><button class="secondary-button" data-page="previous">← Earlier page</button><button class="secondary-button" data-page="next">Later page →</button></div>
      </details>
    </div><footer class="event-footer"><details><summary>History coverage</summary><p class="event-coverage"></p></details><button class="text-button event-reload">Reload</button></footer>`;
  container.append(panel);
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => panel.querySelector<T>(selector)!;
  const listeners = new AbortController();
  let pending: AbortController | undefined, session: Session | undefined, page: TimelinePage | undefined;
  let revision: string | undefined;
  const filter = 'messages';
  let busy = false;
  let prefetch: AbortController | undefined, prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  let last: { item?: string; cursor?: string } = {};
  const row = (item: TimelineSummary, index: number) => `<button class="event-row" data-event="${escape(item.id)}" aria-current="${page?.selected?.id === item.id ? 'true' : 'false'}"><span class="event-row-top">${badge(item)}<small>#${page!.offset + index + 1}</small></span><span class="event-preview">${escape(item.preview || 'No text recorded')}</span><time>${time(item.time)}</time></button>`;
  function renderRows() {
    if (!page || !$<HTMLDetailsElement>('.event-browser').open) return;
    $('.event-list').innerHTML = page.items.map(row).join('') || '<p class="event-empty">No saved messages.</p>';
  }
  function render() {
    if (!page) return;
    $('.event-count').textContent = `${page.total.toLocaleString()} messages${page.partial ? ' · partial coverage' : ''}`;
    renderRows();
    for (const direction of ['previous', 'next'] as const) $<HTMLButtonElement>(`[data-page="${direction}"]`).disabled = !page[`${direction}Cursor`];
    $('.event-coverage').textContent = page.note || (page.partial ? 'Saved history is incomplete or still awaiting import.' : 'Saved local history. Missing timestamps are never inferred.');
    const item = page.selected;
    $('.event-position').textContent = item ? `${page.offset + page.items.findIndex((message) => message.id === item.id) + 1} / ${page.total}` : 'No messages';
    for (const direction of ['previous', 'next'] as const) $<HTMLButtonElement>(`[data-step="${direction}"]`).disabled = !page[`${direction}Item`];
    if (!item) { $('.event-content').innerHTML = '<div class="event-empty"><h3>No messages yet.</h3><p>Refresh the source to import saved user and assistant messages.</p></div>'; callbacks.select(null); return; }
    callbacks.select(item);
    $('.event-content').innerHTML = `<div class="event-detail-heading">${badge(item)}<h3>${escape(item.name)}</h3><p>${time(item.time)}</p>${item.time === null ? '<p>No timestamp · this message has no map position.</p>' : item.time < session!.created || item.time > Math.max(session!.created, session!.activity?.lastMessageAt || session!.created) ? '<p>Outside this session’s plotted lifetime.</p>' : ''}</div>
      ${item.partial ? '<p class="event-warning">Some content is shortened, missing, or unsupported in this import.</p>' : ''}
      ${item.text ? `<section class="event-payload"><pre>${escape(item.text)}</pre></section>` : '<p class="event-empty">No message text was recorded.</p>'}
      <details class="event-provenance"><summary>Source details</summary><dl><dt>Source</dt><dd>${escape(sourceName(session?.source))}</dd><dt>Message ID</dt><dd>${escape(item.messageID)}</dd><dt>Timestamp source</dt><dd>${escape(item.timeSource)}</dd></dl></details>`;
  }
  async function load(options: { item?: string; cursor?: string } = {}) {
    if (!session) return;
    clearTimeout(prefetchTimer);
    pending?.abort(); const controller = new AbortController(); pending = controller; last = options;
    busy = true; panel.setAttribute('aria-busy', 'true'); $('.event-position').textContent = 'Loading…';
    for (const control of panel.querySelectorAll<HTMLButtonElement>('[data-step], [data-page]')) control.disabled = true;
    const scroll = $('.event-list').scrollTop, oldOffset = page?.offset;
    const activeElement = document.activeElement;
    const active = activeElement instanceof HTMLElement ? activeElement.dataset : undefined;
    try {
      const result = await client.read(session.id, { filter, ...options, ...(revision ? { revision } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      page = result; revision = page!.revision; render();
      $('.event-list').scrollTop = page!.offset === oldOffset ? scroll : 0;
      $('.event-scroll').scrollTop = 0;
      const selector = active?.event ? `[data-event="${active.event}"]` : '';
      if (selector && (document.activeElement === activeElement || (!activeElement?.isConnected && document.activeElement === document.body))) panel.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        prefetch?.abort(); prefetch = new AbortController();
        for (const item of [page?.previousItem, page?.nextItem]) if (item) void client.read(session!.id, { item, filter, revision }, prefetch.signal).catch(() => {});
      }, 60);
    } catch (error) {
      if (controller.signal.aborted) return;
      page = undefined; $('.event-position').textContent = 'Unavailable';
      $('.event-content').innerHTML = `<div class="event-empty"><h3>Could not load this history.</h3><p>${escape(error instanceof Error ? error.message : 'Please retry.')}</p><button class="secondary-button" data-retry>Retry</button> <button class="secondary-button" data-reload>Reload current history</button></div>`;
    } finally { if (pending === controller) { busy = false; panel.removeAttribute('aria-busy'); } }
  }
  const reload = () => { client.clear(); revision = undefined; page = undefined; void load(); };
  const visible = () => !panel.hidden && !container.hidden;
  const close = () => {
    clearTimeout(prefetchTimer); prefetch?.abort();
    pending?.abort(); pending = undefined; busy = false; page = undefined; panel.hidden = true;
    panel.removeAttribute('aria-busy'); container.classList.remove('has-events'); callbacks.select(null);
  };
  const step = (direction: 'previous' | 'next') => {
    if (busy) return;
    const id = direction === 'next' ? page?.nextItem : page?.previousItem;
    if (id) void load({ item: id });
  };
  panel.addEventListener('click', (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
    if (button.dataset.event) void load({ item: button.dataset.event });
    if (button.dataset.step) step(button.dataset.step === 'next' ? 'next' : 'previous');
    if (button.dataset.page) { const cursor = button.dataset.page === 'next' ? page?.nextCursor : page?.previousCursor; if (cursor) void load({ cursor }); }
    if (button.hasAttribute('data-retry')) void load(last);
    if (button.hasAttribute('data-reload') || button.classList.contains('event-reload')) reload();
    if (button.classList.contains('event-close')) { close(); document.querySelector<HTMLCanvasElement>('#scene canvas')?.focus({ preventScroll: true }); }
  }, { signal: listeners.signal });
  $('.event-browser').addEventListener('toggle', renderRows, { signal: listeners.signal });
  return {
    close,
    handleKey(event: KeyboardEvent) {
      if (!visible() || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || document.querySelector('dialog[open]')) return false;
      if ((event.target as Element).closest('input, select, textarea, [contenteditable="true"], [data-drag-panel], #explorer')) return false;
      if (event.key === 'Escape') { event.preventDefault(); close(); document.querySelector<HTMLCanvasElement>('#scene canvas')?.focus({ preventScroll: true }); return true; }
      if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) return false;
      event.preventDefault(); step(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? 'previous' : 'next'); return true;
    },
    open(value: Session, item?: string, snapshot?: string) {
      clearTimeout(prefetchTimer); prefetch?.abort();
      const sameSession = session?.id === value.id;
      session = value; revision = snapshot; page = undefined;
      $('.event-list').replaceChildren(); $('.event-content').innerHTML = '<p class="event-empty">Loading saved history…</p>';
      $('.event-coverage').textContent = 'Loading coverage…';
      if (!sameSession) $<HTMLDetailsElement>('.event-browser').open = false;
      panel.hidden = false; container.classList.add('has-events');
      void load(item ? { item } : {});
    },
    dispose() { clearTimeout(prefetchTimer); prefetch?.abort(); pending?.abort(); listeners.abort(); panel.remove(); },
  };
}
