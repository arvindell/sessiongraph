const hour = 3_600_000;

// A reproducible shape for the landing video, separate from the uniform load fixture.
function organicHistory(end) {
  let seed = 0x37ab12;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const profiles = [
    // Directory, session count, activity bursts (days ago), branch probability
    ['sessiongraph', 96, [16, 11, 4, 1], .43],
    ['web-studio', 50, [14, 8, 3], .28],
    ['timeline', 34, [10, 5], .58],
    ['desktop', 26, [12, 2], .34],
    ['search', 19, [8, 2], .49],
    ['notes', 14, [15, 6, 1], .08],
    ['data-import', 11, [5], .42],
    ['design-system', 8, [12, 7], .13],
    ['tiny-tools', 6, [3], .14],
    ['weekend-prototype', 4, [13], .22],
    ['dotfiles', 3, [17, 9], 0],
    ['scratchpad', 2, [7, 1], 0],
  ];
  const sessions = profiles.flatMap(([name, count, bursts, branchRate], lane) => {
    const starts = Array.from({ length: count }, () => {
      const day = bursts[Math.floor(random() * bursts.length)];
      const jitter = (random() + random() + random() - 1.5) * 1.7;
      return end - Math.max(.1, random() < .15 ? random() * 18 : day + jitter) * 24 * hour;
    }).sort((a, b) => a - b);
    const depths = [];
    return starts.map((created, i) => {
      const sourceRoll = random(), lengthRoll = random();
      const recent = starts.slice(Math.max(0, i - 7), i).map((_, j) => Math.max(0, i - 7) + j)
        .filter(j => depths[j] < 3 && created - starts[j] < 30 * hour);
      const parent = recent.length && random() < branchRate ? recent[Math.floor(random() * recent.length)] : undefined;
      depths.push(parent === undefined ? 0 : depths[parent] + 1);
      const duration = lengthRoll < .18 ? 8 + random() * 52
        : lengthRoll < .88 ? (1 + 12 * random() ** 2) * 60
          : (14 + random() * 38) * 60;
      const sourceIndex = sourceRoll < .76 ? [2, 1, 0, 3][(lane + (random() < .32 ? 1 : 0)) % 4]
        : Math.floor(random() * 12);
      const lastMessageAt = Math.min(end, created + duration * 60_000);
      return { name, lane, i, sourceIndex, created, lastMessageAt, parent, fork: random() < .57,
        tokens: Math.round(1900 * 1000 ** random()) };
    });
  });
  return { lanes: profiles.map(([name]) => name), sessions };
}

/** Entirely invented demo data. Every API request is intercepted before navigation. */
export async function installDemoRoutes(page, options = {}) {
  const end = (options.now ?? Date.now()) - hour, start = end - 24 * 86_400_000;
  const organic = options.organic ? organicHistory(end) : null;
  const lanes = organic?.lanes ?? ['sessiongraph', 'timeline', 'search', 'desktop', 'source-adapters', 'design-system'];
  const titles = ['Build conversation search', 'Polish timeline playback', 'Add keyboard navigation', 'Explore a new layout', 'Ship the desktop app', 'Connect local session sources', 'Refine the command palette', 'Animate session branches', 'Improve search ranking', 'Design the onboarding flow', 'Trace changes across forks', 'Make the galaxy feel alive'];
  const sources = ['opencode', 'claude-code', 'codex', 'cursor', 'gemini', 'qwen-code', 'pi', 'copilot', 'cline', 'roo-code', 'kilo-code', 'continue'], sessions = [];
  const names = ['OpenCode', 'Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'Qwen Code', 'Pi', 'GitHub Copilot CLI', 'Cline', 'Roo Code', 'Kilo Code', 'Continue'];
  const history = organic?.sessions ?? lanes.flatMap((name, lane) => Array.from({ length: options.perLane ?? 70 - lane * 4 }, (_, i) => {
    const created = start + ((i + lane * 1.4) / (options.perLane ? options.perLane + 10 : 80)) * (end - start);
    return { name, lane, i, sourceIndex: (i + lane) % sources.length, created, lastMessageAt: created + (i % 7 + 1) * 6 * hour,
      parent: i > 2 && i % 6 !== 0 && i % 3 !== 0 ? i - i % 6 : undefined, fork: i % 2, tokens: 24000 + i * 1371 };
  }));
  for (const { name, lane, i, sourceIndex, created, lastMessageAt, parent, fork, tokens } of history) {
    const source = sources[sourceIndex], id = `demo-${lane}-${i}`;
    const relation = parent === undefined ? {} : { [fork ? 'forkID' : 'parentID']: `demo-${lane}-${parent}` };
    sessions.push({ id, nativeID: id, source, projectID: 'demo', directory: `/demo/${name}`, title: titles[(i + lane * 2) % titles.length], created, updated: lastMessageAt, activity: { firstMessageAt: created, lastMessageAt, userMessages: 8, untimedUserMessages: 0 }, archived: false, model: source === 'claude-code' ? 'claude-sonnet-4-6' : 'gpt-6-astra', provider: source === 'claude-code' ? 'anthropic' : 'openai', agent: 'build', tokens, cost: null, ...relation, revision: 'demo', coverage: { history: 'complete', importedAt: end } });
  }
  const data = { sourceID: 'synthetic-demo', onboarding: false, importing: false, loadedAt: end, warnings: [], projects: [{ id: 'demo', name: 'sessiongraph', directory: '/demo/sessiongraph', worktrees: lanes.slice(1).map(n => '/demo/' + n) }], sources: sources.map((id, i) => ({ id, name: names[i], description: 'Synthetic local history for this demo', available: true, selected: true, sessions: sessions.filter(s => s.source === id).length, capabilities: { history: true, forks: id !== 'cursor', children: true, files: id !== 'cursor' } })), sessions };
  if (options.preferences) data.preferences = options.preferences;
  if (options.autoImport !== undefined) data.autoImport = options.autoImport;
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
    else if (url.pathname === '/api/sessiongraph/settings') { Object.assign(data, route.request().postDataJSON()); body = { saved: true }; }
    else if (url.pathname.endsWith('/index')) body = { records: [], epoch: 0, saved: true };
    else if (session && url.pathname.endsWith('/event-markers')) { const items = events(session).filter(e => e.kind === 'message'); body = { sessionID: session.id, revision: 'demo', items, total: items.length, untimed: 0, outsideLifetime: 0, limited: false, partial: false }; }
    else if (session && url.pathname.endsWith('/events')) {
      const items = events(session).filter(e => url.searchParams.get('filter') !== 'messages' || e.kind === 'message'), index = Math.max(0, items.findIndex(e => e.id === url.searchParams.get('item')));
      body = { sessionID: session.id, revision: 'demo', items, total: items.length, offset: 0, nextCursor: null, previousCursor: null, selected: items[index], previousItem: items[index - 1]?.id, nextItem: items[index + 1]?.id, related: [], relatedPartial: false, partial: false };
    } else if (session && url.pathname.endsWith('/content')) body = { id: session.id, fragments: events(session).map(e => ({ kind: e.kind === 'tool_call' ? 'Tool' : e.role === 'user' ? 'You' : 'Assistant', text: e.text })), messages: 15, nextCursor: null, truncated: false };
    else if (session && url.pathname.endsWith('/commits')) body = { revision: 'demo', coverage: { state: 'indexed', count: 0 }, items: [], total: 0, nextCursor: null };
    else if (session && parts.length === 5) body = { id: session.id, files: ['src/timeline.ts', 'src/search.ts', 'src/theme.css', 'tests/timeline.test.ts'].map((path, i) => ({ path, source: 'snapshot', steps: 8 - i })), tools: [{ name: 'edit', count: 12 }, { name: 'shell', count: 5 }], locations: [], messagesScanned: 42, snapshotSteps: 8, nextCursor: null, partial: false, loadedAt: end };
    else if (/\/(import|sources)(\/status)?$/.test(url.pathname)) body = { sources: data.sources, running: false, discovered: sessions.length, imported: 0, unchanged: sessions.length, failed: 0, errors: [] };
    else return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic demo: endpoint unavailable' }) });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { sessions, data };
}
