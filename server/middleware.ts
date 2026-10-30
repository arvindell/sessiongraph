import type { IncomingMessage, ServerResponse } from 'node:http';
import { adapters } from './adapters';
import { SessionGraphStore } from './store';
import { Importer } from './importer';
import { getLaunchConnection, prepareLaunch, launchTerminal } from './launch';
import { isHarness } from '../src/launch-links';
import { EventReadError } from './event-store';

const generation = Symbol('sessiongraph-backend');
const runtime = globalThis as typeof globalThis & { sessionGraphRuntime?: { store: SessionGraphStore; importer: Importer; generation?: symbol } };
export function library() {
  if (runtime.sessionGraphRuntime?.importer.status.running && runtime.sessionGraphRuntime.generation !== generation) {
    // HMR can fix an adapter while a long import is in progress. Keep the job
    // and connection, but replace the methods it calls for subsequent pages.
    for (const live of runtime.sessionGraphRuntime.importer.adapters) { const updated = adapters.find((adapter) => adapter.id === live.id); if (updated) Object.assign(live, updated); }
  }
  if (runtime.sessionGraphRuntime && runtime.sessionGraphRuntime.generation !== generation && !runtime.sessionGraphRuntime.importer.status.running) { runtime.sessionGraphRuntime.store.close(); runtime.sessionGraphRuntime = undefined; }
  if (!runtime.sessionGraphRuntime) { const store = new SessionGraphStore(); runtime.sessionGraphRuntime = { store, importer: new Importer(store, adapters), generation }; }
  return runtime.sessionGraphRuntime;
}
async function body(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 512_000) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function sessionGraphMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/sessiongraph')) return next();
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  const json = (status: number, value: unknown) => { if (!res.writableEnded) { res.statusCode = status; res.end(JSON.stringify(value)); } };
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site requests are not allowed.' });
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: 'Origin mismatch.' }); }
    catch { return json(403, { error: 'Invalid origin.' }); }
  }
  if (req.method !== 'GET' && typeof req.headers['x-sessiongraph-action'] !== 'string') return json(403, { error: 'Use the SessionGraph application.' });
  try {
    const { store, importer } = library();
    if (url.pathname === '/api/sessiongraph/sources' && req.method === 'GET') return json(200, { sources: await importer.sources(), onboarding: store.setting('selected') === undefined });
    if (url.pathname === '/api/sessiongraph/import') {
      if (req.method === 'GET') return json(200, importer.status);
      if (req.method === 'POST') {
        const value = await body(req);
        if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.some((s: unknown) => typeof s !== 'string'))) return json(400, { error: 'Choose valid sources.' });
        if (importer.status.running) return json(409, { error: 'An import is already running.' });
        return json(202, importer.start(value.sources));
      }
    }
    if (url.pathname === '/api/sessiongraph/index') {
      if (req.method === 'GET') return json(200, store.checkpoints(url.searchParams.get('after') || ''));
      if (req.method === 'POST') { const value = await body(req); return value.record && store.saveCheckpoint(value.record, value.epoch) ? json(200, { saved: true }) : json(409, { error: 'Index snapshot is stale.' }); }
      if (req.method === 'DELETE') { store.clearIndex(); return json(200, { cleared: true }); }
    }
    if (url.pathname === '/api/sessiongraph' && req.method === 'GET') {
      const sources = adapters.map((a) => ({ id: a.id, name: a.name, description: a.description, capabilities: a.capabilities, selected: store.selected().includes(a.id), available: false, ...store.sourceInfo(a.id) }));
      return json(200, store.library(sources, importer.status.running));
    }
    const match = /^\/api\/sessiongraph\/session\/([^/]+)(?:\/(content|timeline|events|event-markers|connection|prepare-launch|open-terminal))?$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const session = store.getSession(id);
      if (!session) return json(404, { error: 'Session not imported.' });
      if (['prepare-launch', 'open-terminal'].includes(match[2]) && req.method === 'POST') {
        const value = await body(req);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return json(400, { error: 'Invalid launch request.' });
        const target = value.target ?? session.source ?? 'opencode';
        if (!isHarness(target)) return json(400, { error: 'Choose a supported destination app.' });
        try {
          const prepared = await prepareLaunch(store, session, target, value.directory);
          if (match[2] === 'open-terminal') await launchTerminal(session, prepared);
          return json(200, prepared);
        } catch (error) { return json(400, { error: error instanceof Error ? error.message : 'Could not prepare this session.' }); }
      }
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed.' });
      if (['prepare-launch', 'open-terminal'].includes(match[2])) return json(405, { error: 'Method not allowed.' });
      if (match[2] === 'timeline') return json(200, store.timeline(id));
      if (match[2] === 'event-markers') return json(200, store.eventMarkers(id));
      if (match[2] === 'events') return json(200, store.events(id, Object.fromEntries(['cursor', 'item', 'filter', 'revision'].flatMap((key) => url.searchParams.has(key) ? [[key, url.searchParams.get(key)!]] : []))));
      if (match[2] === 'connection') return json(200, await getLaunchConnection(session));
      const cursor = url.searchParams.get('cursor') || undefined;
      if (cursor && (!/^\d{1,9}$/.test(cursor) || Number(cursor) > 50_000)) return json(400, { error: 'Invalid cursor.' });
      return json(200, match[2] === 'content' ? store.content(id, cursor) : store.detail(id, cursor));
    }
    return json(404, { error: 'Not found.' });
  } catch (error) {
    if (error instanceof EventReadError) return json(error.status, { error: error.message });
    console.error('[sessiongraph] Local operation failed:', error instanceof Error ? error.name : 'Unknown error');
    return json(500, { error: 'Local operation failed. Check the import status or retry.' });
  }
}
