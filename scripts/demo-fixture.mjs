/** Entirely invented demo data. Every API request is intercepted before navigation. */
export async function installDemoRoutes(page) {
  const end = Date.now() - 3_600_000, start = end - 24 * 86_400_000;
  const lanes = ['sessiongraph', 'timeline', 'search', 'desktop', 'source-adapters', 'design-system'];
  const titles = ['Build conversation search', 'Polish timeline playback', 'Add keyboard navigation', 'Explore a new layout', 'Ship the desktop app', 'Connect local session sources', 'Refine the command palette', 'Animate session branches', 'Improve search ranking', 'Design the onboarding flow', 'Trace changes across forks', 'Make the galaxy feel alive'];
  const sources = ['opencode', 'claude-code', 'codex', 'cursor'], sessions = [];
  for (let lane = 0; lane < lanes.length; lane++) for (let i = 0; i < 70 - lane * 4; i++) {
    const source = sources[(i + lane) % sources.length], id = `demo-${lane}-${i}`;
    const created = start + ((i + lane * 1.4) / 80) * (end - start);
    const parent = i > 2 && i % 6 !== 0 && i % 3 !== 0 ? `demo-${lane}-${i - i % 6}` : undefined;
    const lastMessageAt = created + (i % 7 + 1) * 6 * 3_600_000;
    sessions.push({ id, nativeID: id, source, projectID: 'demo', directory: `/demo/${lanes[lane]}`, title: titles[(i + lane * 2) % titles.length], created, updated: lastMessageAt, activity: { firstMessageAt: created, lastMessageAt, userMessages: 8, untimedUserMessages: 0 }, archived: false, model: source === 'claude-code' ? 'claude-sonnet-4-6' : 'gpt-6-astra', provider: source === 'claude-code' ? 'anthropic' : 'openai', agent: 'build', tokens: 24000 + i * 1371, cost: null, ...(i % 2 ? { forkID: parent } : { parentID: parent }), revision: 'demo', coverage: { history: 'complete', importedAt: end } });
  }
  const data = { sourceID: 'synthetic-demo', onboarding: false, importing: false, loadedAt: end, warnings: [], projects: [{ id: 'demo', name: 'sessiongraph', directory: '/demo/sessiongraph', worktrees: lanes.slice(1).map(n => '/demo/' + n) }], sources: sources.map((id, i) => ({ id, name: ['OpenCode', 'Claude Code', 'Codex', 'Cursor'][i], available: true, selected: true, sessions: sessions.filter(s => s.source === id).length, capabilities: { history: true, forks: id !== 'cursor', children: true, files: id !== 'cursor' } })), sessions };
  const events = (session) => Array.from({ length: 15 }, (_, i) => {
    const tool = i % 4 === 3;
    const text = tool ? 'Updated the timeline with smooth camera motion and keyboard navigation.' : i % 2 ? 'The timeline now follows the active cluster. Forks and child sessions stay distinct, and every message is searchable.' : 'Make the timeline easy to explore. I want to follow branches, inspect tool calls, and find the conversation where we built search.';
    return { id: `e${i}`, sessionID: session.id, messageID: `m${i}`, kind: tool ? 'tool_call' : 'message', role: i % 2 ? 'assistant' : 'user', name: tool ? 'edit' : i % 2 ? 'Assistant' : 'You', ordinal: i, text, preview: text, input: tool ? '{"path":"src/timeline.ts","change":"Add smooth half-turn playback"}' : undefined, status: tool ? 'completed' : undefined, timeSource: 'recorded', time: session.created + i / 14 * (session.activity.lastMessageAt - session.created) };
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()), parts = url.pathname.split('/');
    const session = sessions.find(s => s.id === decodeURIComponent(parts[4] || ''));
    let body;
    if (url.pathname === '/api/sessiongraph') body = data;
    else if (url.pathname.endsWith('/index')) body = { records: [], epoch: 0, saved: true };
    else if (session && url.pathname.endsWith('/event-markers')) body = { sessionID: session.id, revision: 'demo', items: events(session), total: 15, untimed: 0, outsideLifetime: 0, limited: false, partial: false };
    else if (session && url.pathname.endsWith('/events')) {
      const items = events(session), index = Math.max(0, items.findIndex(e => e.id === url.searchParams.get('item')));
      body = { sessionID: session.id, revision: 'demo', items, total: items.length, offset: 0, nextCursor: null, previousCursor: null, selected: items[index], previousItem: items[index - 1]?.id, nextItem: items[index + 1]?.id, related: [], relatedPartial: false, partial: false };
    } else if (session && url.pathname.endsWith('/content')) body = { id: session.id, fragments: events(session).map(e => ({ kind: 'message', text: e.text })), messages: 15, nextCursor: null, truncated: false };
    else if (session && parts.length === 5) body = { id: session.id, files: ['src/timeline.ts', 'src/search.ts', 'src/theme.css', 'tests/timeline.test.ts'].map((path, i) => ({ path, source: 'snapshot', steps: 8 - i })), tools: [{ name: 'edit', count: 12 }, { name: 'shell', count: 5 }], locations: [], messagesScanned: 42, snapshotSteps: 8, nextCursor: null, partial: false, loadedAt: end };
    else if (/\/(imports|sources)(\/status)?$/.test(url.pathname)) body = { sources: data.sources, running: false, discovered: sessions.length, imported: 0, unchanged: sessions.length, failed: 0, errors: [] };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic demo: endpoint unavailable' }) });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { sessions, data };
}
