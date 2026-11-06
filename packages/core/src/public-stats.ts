import type { PublicGraph } from './public-graph';

/** Unknown or hidden usage is never represented as zero. */
export function publicGraphStats(graph: PublicGraph) {
  const recorded = graph.settings.tokens ? graph.sessions.filter(s => typeof s.tokens === 'number') : [];
  const total = recorded.reduce((sum, s) => sum + s.tokens!, 0);
  return {
    sessionCount: graph.sessions.length,
    tokenCount: recorded.length && Number.isSafeInteger(total) ? total : null,
    tokensPartial: recorded.length > 0 && recorded.length < graph.sessions.length,
  };
}

export function publicSummary(graph: PublicGraph) {
  const stats = publicGraphStats(graph), values = [`${stats.sessionCount.toLocaleString()} sessions`];
  if (graph.settings.tokens) values.push(stats.tokenCount === null ? 'Tokens unavailable' : `${stats.tokenCount.toLocaleString()} recorded tokens${stats.tokensPartial ? ' (partial coverage)' : ''}`);
  if (graph.settings.messageCounts) {
    const known = graph.sessions.filter(s => s.messages?.count != null);
    values.push(known.length ? `${known.reduce((sum, s) => sum + s.messages!.count!, 0).toLocaleString()} recorded messages${known.length < graph.sessions.length || graph.sessions.some(s => s.messages?.partial) ? ' (partial history)' : ''}` : 'Message counts unavailable');
  }
  return values.join(' · ');
}
