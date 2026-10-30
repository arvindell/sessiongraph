import { SessionSearchIndex } from './engine';
import type { Session } from '../types';
import type { ContentPage, Fragment, SearchRequest, SearchResponse } from './types';
import { contentVersion, MAX_CHARACTERS, SESSION_CHARACTERS } from './persistence';
import { SQLiteSearchCache } from './sqlite-cache';

const index = new SessionSearchIndex();
const cache = new SQLiteSearchCache();
type State = { session: Session; cursor?: string; pages: number; characters: number; partial: boolean; complete: boolean; capped: boolean; failed: number; inflight: boolean };
const states = new Map<string, State>();
const restored = new Set<string>();
let enabled = false, running = 0, characters = 0, revision = 0;
let ready = false;
let data: Extract<SearchRequest, { type: 'data' }> | undefined;
let query: Extract<SearchRequest, { type: 'query' }> | undefined;
let priority: string[] = [];
let updateTimer: ReturnType<typeof setTimeout> | undefined;
let queriedAt = 0;
const controllers = new Set<AbortController>();
const send = (message: SearchResponse) => postMessage(message);

function results() {
  if (!query) return;
  const started = performance.now();
  const result = index.search(query.text, query.viewOnly, query.limit);
  priority = result.hits.slice(0, 12).map((hit) => hit.id);
  send({ type: 'results', request: query.request, ...result, elapsed: performance.now() - started });
}
function status() {
  const values = [...states.values()];
  send({ type: 'status', status: { indexed: values.filter((s) => s.pages > 0).length, complete: values.filter((s) => s.complete).length, total: states.size, characters, active: enabled && running > 0, limited: characters >= MAX_CHARACTERS || values.some((s) => s.partial || s.capped), failed: values.filter((s) => s.failed > 0).length, restored: restored.size, storage: !ready ? 'restoring' : data?.sourceID && cache.available ? 'local' : 'memory' } });
}
function scheduleUpdate() {
  if (!updateTimer) updateTimer = setTimeout(() => { updateTimer = undefined; results(); status(); }, 200);
}
function next(): State | undefined {
  const available = (state?: State): state is State => Boolean(state && !state.inflight && !state.complete && !state.capped && state.failed < 1);
  for (const id of priority) { const state = states.get(id); if (available(state) && state.pages < 2) return state; }
  let chosen: State | undefined;
  for (const state of states.values()) if (available(state) && (!chosen || state.pages < chosen.pages)) chosen = state;
  return chosen;
}
function pump() {
  if (!ready || !enabled || characters >= MAX_CHARACTERS) { status(); return; }
  while (running < 2) {
    const state = next();
    if (!state) break;
    state.inflight = true;
    running++;
    const version = revision;
    const controller = new AbortController();
    controllers.add(controller);
    void (async () => {
      try {
        const params = new URLSearchParams({ updated: String(state.session.updated) });
        if (state.cursor) params.set('cursor', state.cursor);
        const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(state.session.id)}/content?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Conversation unavailable');
        const page = await response.json() as ContentPage;
        if (version !== revision || controller.signal.aborted) return;
        if (page.id !== state.session.id) throw new Error('Unexpected conversation');
        // Reserve a fair share for older sessions instead of spending the entire
        // memory budget on a few recent, tool-heavy conversations.
        const quota = Math.min(SESSION_CHARACTERS, Math.floor(MAX_CHARACTERS / Math.max(1, states.size)));
        let remaining = Math.min(quota - state.characters, MAX_CHARACTERS - characters);
        const fragments: Fragment[] = [];
        const ordered = [...page.fragments].sort((a, b) => Number(b.kind === 'File' || b.kind === 'You') - Number(a.kind === 'File' || a.kind === 'You'));
        const perFragment = Math.max(160, Math.min(2_000, Math.floor(remaining / Math.max(1, ordered.length))));
        let sampled = false;
        for (const fragment of ordered) {
          if (remaining <= 0) { sampled = true; break; }
          const text = fragment.text.slice(0, Math.min(remaining, perFragment));
          sampled ||= text.length < fragment.text.length;
          fragments.push({ ...fragment, text });
          remaining -= text.length;
          state.characters += text.length;
          characters += text.length;
        }
        index.addContent(state.session.id, fragments);
        state.pages++;
        // Coverage is cumulative: a small final page cannot repair earlier gaps.
        state.partial ||= page.truncated || sampled;
        state.complete = !page.nextCursor && !state.partial;
        state.capped = !state.complete && (!page.nextCursor || state.characters >= quota || state.pages >= 8);
        state.cursor = page.nextCursor || undefined;
        scheduleUpdate();
        if (data?.sourceID) await cache.save({ id: state.session.id, version: contentVersion(state.session), fragments: index.content(state.session.id), pages: state.pages, characters: state.characters, partial: state.partial, complete: state.complete, capped: state.capped, cursor: state.cursor });
      } catch {
        if (!controller.signal.aborted && version === revision) state.failed++;
      } finally {
        state.inflight = false;
        controllers.delete(controller);
        running--;
        if (enabled) setTimeout(pump, performance.now() - queriedAt < 150 ? 150 : 35);
        else status();
      }
    })();
  }
  status();
}

async function configure(message: Extract<SearchRequest, { type: 'data' }>, clear = false) {
  const version = ++revision;
  ready = false;
  controllers.forEach((controller) => controller.abort());
  const sameSource = data?.sourceID === message.sourceID && !clear;
  const previous = sameSource ? new Map(states) : new Map<string, State>();
  if (!sameSource) { index.setData([], []); restored.clear(); }
  data = message;
  states.clear(); characters = 0;
  for (const session of [...message.sessions].sort((a, b) => b.updated - a.updated)) {
    const old = previous.get(session.id);
    const keep = old && contentVersion(old.session) === contentVersion(session);
    const state: State = keep ? { ...old, session, inflight: false } : { session, pages: 0, characters: 0, partial: false, complete: false, capped: false, failed: 0, inflight: false };
    if (!keep) restored.delete(session.id);
    states.set(session.id, state);
    characters += state.characters;
  }
  for (const id of restored) if (!states.has(id)) restored.delete(id);
  index.setData(message.sessions, message.projects);
  results(); status();
  if (clear) await cache.clear();
  if (version !== revision) return;
  if (message.sourceID) await cache.restore(message.sourceID, message.sessions, (record) => {
    if (version !== revision) return;
    const state = states.get(record.id);
    if (!state || state.pages || characters + record.characters > MAX_CHARACTERS) return;
    index.addContent(record.id, record.fragments);
    Object.assign(state, { pages: record.pages, characters: record.characters, partial: record.partial, complete: record.complete, capped: record.capped, cursor: record.cursor });
    characters += record.characters;
    restored.add(record.id);
    scheduleUpdate();
  });
  if (version !== revision) return;
  const quota = Math.min(SESSION_CHARACTERS, Math.floor(MAX_CHARACTERS / Math.max(1, states.size)));
  for (const state of states.values()) if (!state.complete && state.characters >= quota) state.capped = true;
  ready = true;
  results(); pump();
}

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  try {
    const message = event.data;
    if (message.type === 'data') {
      void configure(message).catch(() => send({ type: 'error', message: 'Search index could not load. Reload to retry.' }));
    } else if (message.type === 'scope') { index.setScope(message.ids); results(); }
    else if (message.type === 'query') { queriedAt = performance.now(); query = message; results(); }
    else if (message.type === 'clear-cache') {
      enabled = false;
      if (data) void configure(data, true).catch(() => send({ type: 'error', message: 'Search index could not reset. Reload to retry.' }));
    } else {
      enabled = message.enabled;
      if (!enabled) controllers.forEach((c) => c.abort());
      else states.forEach((state) => { state.failed = 0; });
      pump();
    }
  } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : 'Search unavailable' }); }
};
