import type { Graph, GraphNode, Lane, Project, Session } from './types';

export const PALETTE = ['#b0e9d6', '#8eaff4', '#d7a1f1', '#eac594', '#8cdbdf', '#e7a3b8', '#a8ca91'];

export function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  // Avalanche adjacent string seeds so nearby IDs don't form accidental stripes.
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

export function directoryLabel(directory: string): string {
  return directory.replace(/\/$/, '').split('/').at(-1) || '/';
}

// Metadata updates can be title changes or filesystem writes, not messages.
// Unknown message times stay at creation until a timestamp is available.
export const sessionEnd = (session: Session) => Math.max(session.created, session.activity?.lastMessageAt || session.created);
export const timeX = (time: number, graph: Pick<Graph, 'start' | 'end'>) => (time - graph.start) / Math.max(1, graph.end - graph.start) * 300 - 150;
export const trailPosition = (node: GraphNode, x: number): [number, number, number] => [x, node.position[1], node.position[2]];
export const connectionPositions = (from: GraphNode, to: GraphNode) => [
  trailPosition(from, Math.max(from.startPosition[0], Math.min(to.startPosition[0], from.position[0]))), to.startPosition,
] as const;

export function makeGraph(sessions: Session[], projects: Project[]): Graph {
  if (!sessions.length) return { nodes: [], edges: [], lanes: [], start: 0, end: 0 };
  const ordered = [...sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const start = ordered[0].created;
  const end = ordered.reduce((latest, session) => Math.max(latest, sessionEnd(session)), start + 3_600_000);
  const groups = new Map<string, Session[]>();
  for (const session of ordered) {
    const key = `${session.projectID}:${session.directory}`;
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }
  const sortedGroups = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const lanes: Lane[] = [];
  const nodes: GraphNode[] = [];
  sortedGroups.forEach(([key, group], index) => {
    // The busiest directory is the central trunk. Other directories fan out in
    // depth and height; every node's X coordinate is its latest saved message.
    const angle = index * 2.399963;
    const distance = index === 0 ? 0 : 15 + Math.sqrt(index) * 14;
    const y = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance * 0.7;
    const color = PALETTE[index % PALETTE.length];
    const project = projects.find((p) => p.id === group[0].projectID);
    const directory = group[0].directory;
    const lane: Lane = {
      key, label: directoryLabel(directory), color,
      kind: project?.worktrees.includes(directory) ? 'worktree' : 'directory',
      y, z, nodes: [],
    };
    for (const session of group) {
      const x = timeX(sessionEnd(session), { start, end });
      const startX = timeX(session.created, { start, end });
      const seed = hash(session.id);
      const isBranch = Boolean(session.parentID || session.forkID);
      const spread = isBranch ? 12 : 6;
      const wave = Math.sin((startX + 150) / 65 + index * 0.7) * 3.5;
      const node: GraphNode = {
        session,
        position: [x, y + wave + (seed - 0.5) * spread, z + (hash(session.id + 'z') - 0.5) * spread],
        startPosition: [startX, 0, 0],
        color,
        radius: 0.35 + Math.min(0.65, Math.log10(1 + (session.tokens || 0)) * 0.08),
      };
      nodes.push(node);
      lane.nodes.push(node);
    }
    lanes.push(lane);
  });
  const ids = new Set(ordered.map((s) => s.id));
  const edges: Graph['edges'] = [];
  for (const session of ordered) {
    if (session.forkID && ids.has(session.forkID)) edges.push({ from: session.forkID, to: session.id, kind: 'fork' });
    else if (session.parentID && ids.has(session.parentID)) edges.push({ from: session.parentID, to: session.id, kind: 'child' });
  }
  const byID = new Map(nodes.map((node) => [node.session.id, node]));
  const placed = new Set<string>();
  // Give descendants room to branch in Y/Z, while X remains exact chronological
  // time. Directory changes keep their own lane instead of merging two streams.
  function place(node: GraphNode, visited = new Set<string>()) {
    const id = node.session.id;
    if (placed.has(id) || visited.has(id)) return;
    visited.add(id);
    const parentID = node.session.forkID || node.session.parentID;
    const parent = parentID ? byID.get(parentID) : undefined;
    if (parent && parent.session.directory === node.session.directory) {
      place(parent, visited);
      const direction = hash(id + 'branch') > 0.5 ? 1 : -1;
      node.position[1] = parent.position[1] + direction * (9 + hash(id) * 15);
      node.position[2] = parent.position[2] + (hash(id + 'depth') - 0.5) * 18;
    }
    placed.add(id);
  }
  ordered.forEach((session) => place(byID.get(session.id)!));
  nodes.forEach((node) => { node.startPosition = trailPosition(node, node.startPosition[0]); });
  return { nodes, edges, lanes, start, end };
}
