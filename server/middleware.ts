import type { IncomingMessage, ServerResponse } from 'node:http';
import { adapters } from './adapters';
import { SessionAtlasStore } from './store';
import { Importer } from './importer';
import { getLaunchConnection, launchTerminal } from './launch';

const generation = Symbol('session-atlas-backend');
const runtime = globalThis as typeof globalThis & { sessionAtlasRuntime?: { store: SessionAtlasStore; importer: Importer; generation?: symbol } };
export function library() {
  if (runtime.sessionAtlasRuntime?.importer.status.running && runtime.sessionAtlasRuntime.generation !== generation) {
    // HMR can fix an adapter while a long import is in progress. Keep the job
    // and connection, but replace the methods it calls for subsequent pages.
    for (const live of runtime.sessionAtlasRuntime.importer.adapters) { const updated = adapters.find((adapter) => adapter.id === live.id); if (updated) Object.assign(live, updated); }
  }
  if (runtime.sessionAtlasRuntime && runtime.sessionAtlasRuntime.generation !== generation && !runtime.sessionAtlasRuntime.importer.status.running) { runtime.sessionAtlasRuntime.store.close(); runtime.sessionAtlasRuntime = undefined; }
  if (!runtime.sessionAtlasRuntime) { const store = new SessionAtlasStore(); runtime.sessionAtlasRuntime = { store, importer: new Importer(store, adapters), generation }; }
  return runtime.sessionAtlasRuntime;
}
async function body(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 512_000) throw new Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function sessionAtlasMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/session-atlas')) return next();
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  const json = (status: number, value: unknown) => { if (!res.writableEnded) { res.statusCode = status; res.end(JSON.stringify(value)); } };
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site requests are not allowed.' });
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return json(403, { error: 'Origin mismatch.' }); }
    catch { return json(403, { error: 'Invalid origin.' }); }
  }
  if (req.method !== 'GET' && typeof req.headers['x-session-atlas-action'] !== 'string') return json(403, { error: 'Use the Session Atlas application.' });
  try {
    const { store, importer } = library();
    if (url.pathname === '/api/session-atlas/sources' && req.method === 'GET') return json(200, { sources: await importer.sources(), onboarding: store.setting('selected') === undefined });
    if (url.pathname === '/api/session-atlas/import') {
      if (req.method === 'GET') return json(200, importer.status);
      if (req.method === 'POST') {
        const value = await body(req);
        if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.some((s: unknown) => typeof s !== 'string'))) return json(400, { error: 'Choose valid sources.' });
        if (importer.status.running) return json(409, { error: 'An import is already running.' });
        return json(202, importer.start(value.sources));
      }
    }
    if (url.pathname === '/api/session-atlas/index') {
      if (req.method === 'GET') return json(200, store.checkpoints(url.searchParams.get('after') || ''));
      if (req.method === 'POST') { const value = await body(req); return value.record && store.saveCheckpoint(value.record, value.epoch) ? json(200, { saved: true }) : json(409, { error: 'Index snapshot is stale.' }); }
      if (req.method === 'DELETE') { store.clearIndex(); return json(200, { cleared: true }); }
    }
    if (url.pathname === '/api/session-atlas' && req.method === 'GET') {
      const sources = adapters.map((a) => ({ id: a.id, name: a.name, description: a.description, capabilities: a.capabilities, selected: store.selected().includes(a.id), available: false, ...store.sourceInfo(a.id) }));
      return json(200, store.library(sources, importer.status.running));
    }
    const match = /^\/api\/session-atlas\/session\/([^/]+)(?:\/(content|connection|open-terminal))?$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const session = store.getSession(id);
      if (!session) return json(404, { error: 'Session not imported.' });
      if (match[2] === 'open-terminal' && req.method === 'POST') { await launchTerminal(session); return json(200, { opened: true }); }
      if (req.method !== 'GET') return json(405, { error: 'Method not allowed.' });
      if (match[2] === 'connection') return json(200, await getLaunchConnection(session));
      const cursor = url.searchParams.get('cursor') || undefined;
      if (cursor && (!/^\d{1,9}$/.test(cursor) || Number(cursor) > 50_000)) return json(400, { error: 'Invalid cursor.' });
      return json(200, match[2] === 'content' ? store.content(id, cursor) : store.detail(id, cursor));
    }
    return json(404, { error: 'Not found.' });
  } catch (error) {
    console.error('[session-atlas] Local operation failed:', error instanceof Error ? error.name : 'Unknown error');
    return json(500, { error: 'Local operation failed. Check the import status or retry.' });
  }
}
