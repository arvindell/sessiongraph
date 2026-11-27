import type { Preferences } from './preferences';
import type { Graph } from './types';

/** Fixed GPU budgets, independent of library size. */
export const PARTICLE_BUDGETS = {
  performance: { dust: 160, trails: 32, bursts: 8, sparks: 12 },
  balanced: { dust: 560, trails: 96, bursts: 24, sparks: 20 },
  high: { dust: 1100, trails: 160, bursts: 40, sparks: 28 },
} satisfies Record<Preferences['quality'], { dust: number; trails: number; bursts: number; sparks: number }>;

/** Evenly sample without reordering or mutating the source. */
export function particleSample<T>(items: readonly T[], limit: number): T[] {
  const count = Math.min(items.length, Math.max(0, Math.floor(limit)));
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * items.length / count)]);
}

/** Walk only explicit ancestry edges. Nearby sessions and shared lanes are not family. */
export function graphFamily(graph: Graph, selected: string, limit = 256) {
  const ids = new Set(graph.nodes.map(node => node.session.id));
  const depths = new Map<string, number>();
  if (!ids.has(selected) || limit < 1) return { depths, edges: [] as { edge: Graph['edges'][number]; depth: number }[] };
  const adjacent = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    for (const [from, to] of [[edge.from, edge.to], [edge.to, edge.from]]) {
      const neighbors = adjacent.get(from) || [];
      neighbors.push(to); adjacent.set(from, neighbors);
    }
  }
  const queue = [selected]; depths.set(selected, 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const neighbor of adjacent.get(id) || []) {
      if (depths.has(neighbor) || depths.size >= limit) continue;
      depths.set(neighbor, depths.get(id)! + 1); queue.push(neighbor);
    }
  }
  const edges = graph.edges.filter(edge => depths.has(edge.from) && depths.has(edge.to)).slice(0, limit * 2)
    .map(edge => ({ edge, depth: Math.min(depths.get(edge.from)!, depths.get(edge.to)!) }));
  return { depths, edges };
}

/** An explicit scrub gesture, not normal playback, creates a signed, bounded gust. */
export function scrubImpulse(from: number, to: number, elapsed: number, span: number) {
  if (![from, to, elapsed, span].every(Number.isFinite) || span <= 0 || from === to) return 0;
  const velocity = (to - from) / span / Math.max(1 / 120, elapsed);
  return Math.max(-1, Math.min(1, velocity * .65));
}

/** Sorted recorded markers only; loading a snapshot or rewinding never invents a message. */
export function crossedMessages(positions: readonly number[], from: number, to: number, limit = 6) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const upper = (x: number) => {
    let low = 0, high = positions.length;
    while (low < high) { const mid = (low + high) >>> 1; if (positions[mid] <= x) low = mid + 1; else high = mid; }
    return low;
  };
  const first = upper(from), end = upper(to), count = Math.min(end - first, Math.max(0, Math.floor(limit)));
  return Array.from({ length: count }, (_, index) => positions[first + Math.floor(index * (end - first) / count)]);
}
