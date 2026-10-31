import type { Graph, GraphNode, Session } from './types';

const adjectives = 'Cosmic Wobbly Disco Sneaky Bouncy Galactic Crispy Dizzy Fuzzy Noodle Groovy Sleepy Spicy Jolly Loopy Squishy Turbo Giggly Velvet Soggy Zippy Fluffy Moonwalking Wiggly Fizzy Snazzy Goofy Jazzy Tiny Chunky Dapper Wacky'.split(' ');
const nouns = 'Wombat Pickle Pancake Badger Potato Narwhal Noodle Goblin Otter Turnip Hamster Comet Dumpling Goose Biscuit Llama Muffin Squid Raccoon Toaster Waffle Penguin Yeti Pudding Walrus Taco Jellybean Platypus Sloth Cactus Donut Mongoose'.split(' ');

/** Random aliases without collision retries, even with a pathological random source. */
export function projectAliases(count: number, random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) {
  const pairs = adjectives.flatMap(adjective => nouns.map(noun => `${adjective} ${noun}`));
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.floor(index / pairs.length);
    // Large libraries still get two words and a unique alias.
    return `Project ${'Mega'.repeat(cycle)}${pairs[index % pairs.length]}`;
  });
}

/** Allowlist the export model. No names, paths, titles, native IDs, or source metadata survive. */
export function shareGraph(graph: Graph): Graph {
  const names = projectAliases(graph.lanes.length);
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
    lanes: graph.lanes.map((lane, index) => ({ key: `project-${index}`, label: names[index], color: lane.color, kind: 'directory', y: lane.y, z: lane.z, nodes: lane.nodes.map(node => byID.get(ids.get(node.session.id)!)!) })),
  };
}
