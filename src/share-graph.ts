import type { Graph, GraphNode, Session } from '@sessiongraph/core/types';
import { projectAliases } from '@sessiongraph/core/anonymous-projects';
export { projectAliases } from '@sessiongraph/core/anonymous-projects';

/** Allowlist the export model. No names, paths, titles, native IDs, or source metadata survive. */
export function shareGraph(graph: Graph): Graph {
  const names = projectAliases(graph.lanes.length);
  const laneBySession = new Map(graph.lanes.flatMap(lane => lane.nodes.map(node => [node.session.id, lane.key] as const)));
  const projectOrder = new Map<string, number>();
  for (const session of graph.nodes.map(node => node.session).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
    const key = laneBySession.get(session.id); if (key !== undefined && !projectOrder.has(key)) projectOrder.set(key, projectOrder.size);
  }
  const ids = new Map(graph.nodes.map((node, index) => [node.session.id, `session-${index}`]));
  const projects = new Map(graph.lanes.flatMap((lane, index) => lane.nodes.map(node => [node.session.id, `project-${index}`] as const)));
  const nodes: GraphNode[] = graph.nodes.map((node) => {
    const original = node.session;
    const session: Session = {
      id: ids.get(original.id)!, title: 'Session', projectID: projects.get(original.id)!, directory: '',
      created: original.created, updated: original.created,
      activity: original.activity && { firstMessageAt: original.activity.firstMessageAt, lastMessageAt: original.activity.lastMessageAt, userMessages: original.activity.userMessages, untimedUserMessages: original.activity.untimedUserMessages },
      archived: false, model: '', provider: '', agent: '', cost: null,
      source: original.source === 'continue' ? 'continue' : original.source === 'opencode' || !original.source ? 'opencode' : 'unknown',
      tokens: original.tokens,
    };
    if (original.parentID && ids.has(original.parentID)) session.parentID = ids.get(original.parentID);
    if (original.forkID && ids.has(original.forkID)) session.forkID = ids.get(original.forkID);
    return { session, position: [...node.position], startPosition: [...node.startPosition], color: node.color, radius: node.radius };
  });
  const byID = new Map(nodes.map(node => [node.session.id, node]));
  return {
    start: graph.start, end: graph.end, timeFrame: graph.timeFrame && { ...graph.timeFrame }, nodes,
    edges: graph.edges.map(edge => ({ from: ids.get(edge.from)!, to: ids.get(edge.to)!, kind: edge.kind })),
    lanes: graph.lanes.map((lane, index) => ({ key: `project-${index}`, label: names[projectOrder.get(lane.key)!], color: lane.color, kind: 'directory', y: lane.y, z: lane.z, nodes: lane.nodes.map(node => byID.get(ids.get(node.session.id)!)!) })),
  };
}
