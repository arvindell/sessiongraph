// Panel positions are UI-only and stay in memory. Event delegation also covers
// the inspector header, which is replaced whenever another session is selected.
export function setupPanelDragging() {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let dragging: { panel: HTMLElement; handle: HTMLElement; pointerID: number; x: number; y: number; left: number; top: number } | undefined;
  let narrow = innerWidth < 760;

  function position(panel: HTMLElement, x: number, y: number) {
    const left = Math.max(12, Math.min(x, innerWidth - panel.offsetWidth - 12));
    const top = Math.max(72, Math.min(y, innerHeight - panel.offsetHeight - 12));
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', transform: 'none' });
    panel.dataset.positioned = 'true';
  }

  function finish() {
    if (!dragging) return;
    const { panel, handle, pointerID } = dragging;
    dragging = undefined;
    panel.classList.remove('dragging');
    if (handle.hasPointerCapture(pointerID)) handle.releasePointerCapture(pointerID);
  }

  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    const panel = target.closest<HTMLElement>('.floating-panel');
    if (!panel) return;
    document.querySelectorAll('.floating-panel').forEach((p) => p.classList.toggle('front', p === panel));
    const handle = target.closest<HTMLElement>('[data-drag-panel]');
    if (!handle) return;
    panel.querySelectorAll<HTMLDetailsElement>('.custom-dates[open]').forEach((details) => { details.open = false; });
    event.preventDefault();
    handle.focus({ preventScroll: true });
    const rect = panel.getBoundingClientRect();
    dragging = { panel, handle, pointerID: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId);
    panel.classList.add('dragging');
  }, options);

  document.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== dragging.pointerID) return;
    position(dragging.panel, dragging.left + event.clientX - dragging.x, dragging.top + event.clientY - dragging.y);
  }, options);
  document.addEventListener('pointerup', finish, options);
  document.addEventListener('pointercancel', finish, options);
  document.addEventListener('lostpointercapture', finish, options);

  document.addEventListener('keydown', (event) => {
    const handle = (event.target as Element).closest<HTMLElement>('[data-drag-panel]');
    const panel = handle?.closest<HTMLElement>('.floating-panel');
    if (!panel || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    position(panel, rect.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), rect.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
  }, options);

  const panels = [...document.querySelectorAll<HTMLElement>('.floating-panel')];
  const constrain = (panel: HTMLElement) => {
    if (panel.hidden || !panel.dataset.positioned) return;
    const rect = panel.getBoundingClientRect();
    position(panel, rect.left, rect.top);
  };
  const observer = new ResizeObserver((entries) => entries.forEach((entry) => constrain(entry.target as HTMLElement)));
  panels.forEach((panel) => observer.observe(panel));
  window.addEventListener('resize', () => {
    finish();
    if (narrow !== (innerWidth < 760)) {
      narrow = innerWidth < 760;
      panels.forEach((panel) => { panel.removeAttribute('style'); delete panel.dataset.positioned; });
    } else panels.forEach(constrain);
  }, options);
  return () => { finish(); controller.abort(); observer.disconnect(); };
}
