export type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** Frame in container-local coordinates, leaving room for this viewer's visible panels. */
export function focusArea(container: ScreenRect, panels: ScreenRect[], topInset = 72) {
  const width = container.right - container.left, height = container.bottom - container.top;
  const bounds = { left: Math.min(16, width / 4), right: width - Math.min(16, width / 4), top: Math.min(topInset, height / 4), bottom: height - Math.min(24, height / 4) };
  let regions = [bounds];
  for (const panel of panels) {
    const obstacle = { left: panel.left - container.left - 20, right: panel.right - container.left + 20, top: panel.top - container.top - 20, bottom: panel.bottom - container.top + 20 };
    regions = regions.flatMap(region => {
      if (obstacle.right <= region.left || obstacle.left >= region.right || obstacle.bottom <= region.top || obstacle.top >= region.bottom) return [region];
      return [
        { ...region, right: Math.min(region.right, obstacle.left) },
        { ...region, left: Math.max(region.left, obstacle.right) },
        { ...region, bottom: Math.min(region.bottom, obstacle.top) },
        { ...region, top: Math.max(region.top, obstacle.bottom) },
      ].filter(r => r.right > r.left && r.bottom > r.top);
    });
  }
  const area = (r: ScreenRect) => (r.right - r.left) * (r.bottom - r.top);
  const usable = regions.filter(r => r.right - r.left >= 120 && r.bottom - r.top >= 100);
  const best = (usable.length ? usable : regions).sort((a, b) => area(b) - area(a))[0] ?? bounds;
  return { x: (best.left + best.right) / 2, y: (best.top + best.bottom) / 2, width: best.right - best.left, height: best.bottom - best.top };
}
