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
export const timeX = (time: number, graph: Pick<Graph, 'start' | 'end' | 'timeFrame'>) => {
  const frame = graph.timeFrame || graph;
  return (time - frame.start) / Math.max(1, frame.end - frame.start) * 300 - 150;
};
export const progressX = (progress: number, graph: Pick<Graph, 'start' | 'end' | 'timeFrame'>) => timeX(graph.start + (graph.end - graph.start) * progress, graph);
export const trailPosition = (node: GraphNode, x: number): [number, number, number] => [x, node.position[1], node.position[2]];
/** A session is born at its start, travels with time, then rests at its last message. */
export const headPosition = (node: GraphNode, frontier: number) => trailPosition(node, Math.max(node.startPosition[0], Math.min(frontier, node.position[0])));
export const connectionPositions = (from: GraphNode, to: GraphNode) => [
  trailPosition(from, Math.max(from.startPosition[0], Math.min(to.startPosition[0], from.position[0]))), to.startPosition,
] as const;

export function makeGraph(sessions: Session[], projects: Project[], previous?: Graph): Graph {
  if (!sessions.length) return { nodes: [], edges: [], lanes: [], start: 0, end: 0 };
  const ordered = [...sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const start = ordered[0].created;
  const end = ordered.reduce((latest, session) => Math.max(latest, sessionEnd(session)), start + 3_600_000);
  const timeFrame = previous?.nodes.length ? previous.timeFrame || { start: previous.start, end: previous.end } : { start, end };
  const groups = new Map<string, Session[]>();
  for (const session of ordered) {
    const key = `${session.projectID}:${session.directory}`;
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }
  const sortedGroups = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const slots = new Map(previous?.lanes.map((lane, index) => [lane.key, lane.slot ?? index]));
  let nextSlot = Math.max(-1, ...slots.values()) + 1;
  for (const [key] of sortedGroups) if (!slots.has(key)) slots.set(key, nextSlot++);
  sortedGroups.sort((a, b) => slots.get(a[0])! - slots.get(b[0])!);
  const lanes: Lane[] = [];
  const nodes: GraphNode[] = [];
  sortedGroups.forEach(([key, group]) => {
    const index = slots.get(key)!;
    // The initially busiest directory is the central trunk. Imports retain
    // those slots; every node's X coordinate is its latest saved message.
    const angle = index * 2.399963;
    const distance = index === 0 ? 0 : 15 + Math.sqrt(index) * 14;
    const y = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance * 0.7;
    const color = PALETTE[index % PALETTE.length];
    const project = projects.find((p) => p.id === group[0].projectID);
    const directory = group[0].directory;
    const lane: Lane = {
      key, slot: index, label: directoryLabel(directory), color,
      kind: project?.worktrees.includes(directory) ? 'worktree' : 'directory',
      y, z, nodes: [],
    };
    for (const session of group) {
      const x = timeX(sessionEnd(session), timeFrame);
      const startX = timeX(session.created, timeFrame);
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
  // Newly discovered ancestors can add links without moving an existing branch.
  for (const old of previous?.nodes || []) {
    const node = byID.get(old.session.id);
    if (node && node.session.projectID === old.session.projectID && node.session.directory === old.session.directory) {
      node.position[1] = old.position[1]; node.position[2] = old.position[2];
      placed.add(node.session.id);
    }
  }
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
  return { nodes, edges, lanes, start, end, timeFrame };
}
