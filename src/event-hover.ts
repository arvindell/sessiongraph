import { timelineColor, timelineLabel, type TimelineItem, type TimelineSummary } from './timeline';
import type { TimelineClient } from './timeline-client';

/** Read a bounded preview only while its marker is hovered; never select it. */
export function createEventHover(tooltip: HTMLElement, container: HTMLElement, client: TimelineClient) {
  const cache = new Map<string, { text: string; shortened: boolean }>();
  let key: string | undefined, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let current: TimelineSummary | undefined, x = 0, y = 0, overlapping = 1;
  const title = document.createElement('strong'), body = document.createElement('pre'), footer = document.createElement('span');
  const clear = () => { clearTimeout(timer); controller?.abort(); controller = undefined; key = undefined; current = undefined; tooltip.hidden = true; tooltip.classList.remove('message-tooltip'); };
  function render(text: string, note: string) {
    if (!current) return;
    const heading = `${timelineLabel(current)} · ${current.name}`, content = text || 'No text recorded.';
    const hint = [note, overlapping > 1 ? `${overlapping} nearby items` : '', 'Click to focus and read · ← / → to navigate'].filter(Boolean).join(' · ');
    if (title.textContent !== heading) title.textContent = heading;
    if (body.textContent !== content) body.textContent = content;
    if (footer.textContent !== hint) footer.textContent = hint;
    if (title.parentElement !== tooltip) tooltip.replaceChildren(title, body, footer);
    tooltip.classList.add('message-tooltip'); tooltip.hidden = false;
    tooltip.style.setProperty('--event-color', timelineColor(current));
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    const bounds = container.getBoundingClientRect();
    const panels = [...document.querySelectorAll<HTMLElement>('.floating-panel:not([hidden]), .app-header, .map-controls')].map((panel) => panel.getBoundingClientRect());
    // Prefer a quadrant that keeps the preview in the map, including moved panels.
    const positions = [y + 18, y - height - 18].flatMap((top) => [x + 18, x - width - 18].map((left) => {
      left = Math.max(8, Math.min(left, container.clientWidth - width - 8));
      top = Math.max(8, Math.min(top, container.clientHeight - height - 8));
      const screenX = bounds.left + left, screenY = bounds.top + top;
      const overlap = panels.reduce((area, panel) => area
        + Math.max(0, Math.min(screenX + width, panel.right + 8) - Math.max(screenX, panel.left - 8))
        * Math.max(0, Math.min(screenY + height, panel.bottom + 8) - Math.max(screenY, panel.top - 8)), 0);
      return { left, top, overlap };
    }));
    const position = positions.reduce((best, next) => next.overlap < best.overlap ? next : best);
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
  }
  function preview(item: TimelineItem) {
    const text = [item.text, item.input ? `Input\n${item.input}` : '', item.output ? `Output\n${item.output}` : ''].filter(Boolean).join('\n\n');
    return { text: text.slice(0, 1800), shortened: text.length > 1800 || Boolean(item.partial) };
  }
  return {
    clear,
    show(item: TimelineSummary, sessionID: string, revision: string, count: number, left: number, top: number) {
      const nextKey = `${sessionID}:${revision}:${item.id}`, changed = key !== nextKey;
      if (changed) clear();
      key = nextKey; current = item; x = left; y = top; overlapping = count;
      const saved = cache.get(nextKey);
      render(saved?.text || item.preview, saved ? saved.shortened ? 'Content preview' : '' : 'Loading message…');
      if (!changed || saved) return;
      timer = setTimeout(async () => {
        const request = new AbortController(); controller = request;
        try {
          const page = await client.read(sessionID, { item: item.id, revision, filter: 'messages' }, request.signal);
          if (request.signal.aborted || key !== nextKey || page.selected?.id !== item.id) return;
          const value = preview(page.selected); cache.set(nextKey, value);
          if (cache.size > 20) cache.delete(cache.keys().next().value!);
          render(value.text, value.shortened ? 'Content preview' : '');
        } catch { if (!request.signal.aborted && key === nextKey) render(item.preview, 'Saved excerpt · open for details'); }
      }, 120);
    },
    dispose() { clear(); cache.clear(); },
  };
}
