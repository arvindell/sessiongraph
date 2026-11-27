import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { publicRoute } from '../server/publications';
import { HttpError, json } from '../server/security';
import type { Connect, ViteDevServer } from 'vite';
import { DEFAULT_PUBLISHING, validatePublicGraph } from '@sessiongraph/core/public-graph';

// An explicit dev-only profile, not a gallery entry or a saved publication.
function demoProfile() {
  const day = 86_400_000, now = Date.now();
  const sessions = Array.from({ length: 120 }, (_, id) => {
    const created = now - (120 - id) * day / 4;
    const lastMessageAt = created + (1 + id % 8) * 1_200_000;
    return {
      id, group: id % 4, parent: id >= 4 && id % 7 === 0 ? id - 4 : null, fork: null,
      timestamps: { created, lastMessageAt }, tokens: 8_000 + (id * 713) % 90_000,
      messages: { count: 2, untimed: 0, partial: false },
      messageTimes: { values: [created, lastMessageAt], limited: false },
      model: ['gpt-5', 'claude-sonnet-4', 'gemini-3-pro'][id % 3],
      harness: ['codex', 'claude-code', 'opencode'][id % 3],
    };
  });
  return { username: 'demo-preview', graph: validatePublicGraph({ version: 1, settings: DEFAULT_PUBLISHING, sessions }), updatedAt: new Date(now).toISOString() };
}

export function localDatabaseUrl() {
  const value = process.env.SESSIONGRAPH_DEV_DATABASE_URL || 'postgresql://sessiongraph@127.0.0.1:55439/sessiongraph_dev';
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/sessiongraph_dev') throw new Error('Website dev requires the local sessiongraph_dev database.');
  return value;
}

/** Only the public read routes are mounted in Vite. No local-history or account endpoints. */
export function mountPublicApi(server: ViteDevServer) {
  let db: PrismaClient | undefined;
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/api/graphs' && !path.startsWith('/api/profiles/')) return next();
    let response: Response;
    try {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      if (path === '/api/profiles/demo-preview') response = json(demoProfile());
      else {
        db ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: localDatabaseUrl() }, { schema: 'sessiongraph' }) });
        response = await publicRoute(new Request(`http://localhost${req.url}`), db, path) ?? json({ error: 'Not found.' }, 404);
      }
    } catch (error) {
      response = error instanceof HttpError ? json({ error: error.message }, error.status) : json({ error: 'Local public graph database unavailable. Run docker compose up -d --wait and pnpm --filter sessiongraph-site dev:setup.' }, 503);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  };
  server.middlewares.use(middleware);
  server.httpServer?.once('close', () => { void db?.$disconnect(); });
}
