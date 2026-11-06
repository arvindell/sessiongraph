/** Switchback: the shared geometry for web, native icons, and exported media. */
export const BRAND_MINT = '#b0e9d6';
export const BRAND_INK = '#080e13';
export const BRAND_TEXT = '#dbe7e3';
export const BRAND_SIZE = 128;
export const BRAND_STROKE = 10;
export const BRAND_PATH = 'M102 24 86 40H36a14 14 0 0 0 0 28h40a14 14 0 0 1 0 28H22';
export const BRAND_NODES = [[102, 24], [36, 40], [22, 96]] as const;
export const BRAND_NODE_RADIUS = 10;

export function brandSymbol(color = BRAND_MINT) {
  return `<g fill="${color}"><path d="${BRAND_PATH}" fill="none" stroke="${color}" stroke-width="${BRAND_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>${BRAND_NODES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${BRAND_NODE_RADIUS}"/>`).join('')}</g>`;
}

export function brandSvg({ tile = false, rounded = true, color = BRAND_MINT } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><title>SessionGraph</title>${tile ? `<rect width="128" height="128" rx="${rounded ? 28 : 0}" fill="${BRAND_INK}"/><g transform="translate(8 8) scale(.875)">${brandSymbol(color)}</g>` : brandSymbol(color)}</svg>\n`;
}

let route: Path2D | undefined;

/** Vector-only: no image fetch or decode races in GIF/MP4 capture. */
export function drawBrandMark(context: CanvasRenderingContext2D, x: number, y: number, size: number, color = BRAND_MINT) {
  route ??= new Path2D(BRAND_PATH);
  context.save();
  context.translate(x, y);
  context.scale(size / BRAND_SIZE, size / BRAND_SIZE);
  context.strokeStyle = context.fillStyle = color;
  context.lineWidth = BRAND_STROKE;
  context.lineCap = context.lineJoin = 'round';
  context.stroke(route);
  for (const [cx, cy] of BRAND_NODES) {
    context.beginPath();
    context.arc(cx, cy, BRAND_NODE_RADIUS, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}
