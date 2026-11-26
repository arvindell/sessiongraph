import { connectionPositions } from './layout.ts';
import { publicGraphLayout, type PublicGraph } from './public-graph.ts';

/** A bounded, inert thumbnail of the shared layout, derived only from a validated public snapshot. */
export function publicGraphThumbnail(value: PublicGraph) {
  const graph = publicGraphLayout(value);
  const project = ([x, y, z]: readonly number[]) => [x + z * .22, -y + z * .3];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of graph.nodes) for (const position of [node.startPosition, node.position]) {
    const [x, y] = project(position);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const scale = Math.min(560 / Math.max(50, maxX - minX), 272 / Math.max(45, maxY - minY));
  const point = (position: readonly number[]) => {
    const [x, y] = project(position);
    return [320 + (x - (minX + maxX) / 2) * scale, 180 + (y - (minY + maxY) / 2) * scale];
  };
  const xy = (position: readonly number[]) => point(position).map(n => n.toFixed(2)).join(' ');
  const nodes = new Map(graph.nodes.map(n => [n.session.id, n]));
  const step = Math.max(1, Math.ceil(graph.nodes.length / 600));
  const visible = graph.nodes.filter((_, index) => index % step === 0);
  const ids = new Set(visible.map(n => n.session.id));
  const links = graph.edges.filter(e => ids.has(e.to)).map(edge => {
    const from = nodes.get(edge.from)!, to = nodes.get(edge.to)!;
    const [a, b] = connectionPositions(from, to), [x1, y1] = point(a), [x2, y2] = point(b), mid = (x1 + x2) / 2;
    return `<path d="M${x1.toFixed(2)} ${y1.toFixed(2)}C${mid.toFixed(2)} ${y1.toFixed(2)} ${mid.toFixed(2)} ${y2.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}" stroke="${to.color}" opacity=".45"/>`;
  });
  const trails = visible.map(node => {
    const [x, y] = point(node.position).map(n => n.toFixed(2));
    return `<path d="M${xy(node.startPosition)}L${x} ${y}" stroke="${node.color}" opacity=".4"/><circle cx="${x}" cy="${y}" r="6" fill="${node.color}" opacity=".08"/><circle cx="${x}" cy="${y}" r="2" fill="${node.color}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><title>Public session graph preview</title><rect width="640" height="360" fill="#0a141b"/><g fill="none" stroke-width=".8">${links.join('')}${trails.join('')}</g></svg>`;
}
