import { gzipSync, gunzipSync } from 'node:zlib';
import { database, transaction, type DB } from './db';
import { authenticate, authRoute } from './auth';
import { organizationRoute } from './organizations';
import { HttpError, digest, json, readBody, validUsername } from './security';
import { PUBLIC_GRAPH_MAX_BYTES, validatePublicGraph } from '@sessiongraph/core/public-graph';

async function limit(request: Request, db: DB, path: string) {
  // Vercel overwrites x-real-ip. Locally all callers intentionally share a bucket.
  const ip = request.headers.get('x-real-ip') || 'local';
  const bucket = Math.floor(Date.now() / 60_000);
  const key = digest(`${ip}:${bucket}:${path.startsWith('/api/profiles/') ? 'read' : 'write'}`);
  const count = await transaction(db, tx => tx.rateLimit.upsert({ where: { key }, create: { key, count: 1, expiresAt: new Date((bucket + 2) * 60_000) }, update: { count: { increment: 1 } } }));
  if (count.count > (path.startsWith('/api/profiles/') ? 120 : 60)) throw new HttpError(429, 'Too many requests. Please try again in a minute.');
}
export async function handle(request: Request, provided?: DB): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (path === '/api/health' && request.method === 'GET') return json({ ready: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.AUTH_SECRET && process.env.DSQL_ENDPOINT) });
    const db = provided ?? database();
    if (path === '/api/maintenance' && request.method === 'GET') {
      if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Unauthorized.');
      // DSQL limits rows modified per transaction. Keep each cleanup batch bounded.
      const removed: Record<string, number> = {};
      for (const [name, model, key] of [
        ['rateLimits', db.rateLimit, 'key'], ['sessions', db.loginSession, 'hash'],
        ['devices', db.deviceGrant, 'challenge'], ['invitations', db.invitation, 'id'],
      ] as const) {
        removed[name] = 0;
        for (let batch = 0; batch < 20; batch++) {
          const delegate = model as unknown as { findMany(args: object): Promise<Record<string, unknown>[]>; deleteMany(args: object): Promise<{ count: number }> };
          const rows = await delegate.findMany({ where: { expiresAt: { lt: new Date() } }, take: 1000, select: { [key]: true } });
          if (!rows.length) break;
          removed[name] += (await delegate.deleteMany({ where: { [key]: { in: rows.map(row => row[key]) } } })).count;
        }
      }
      return json({ removed });
    }
    await limit(request, db, path);
    const auth = await authRoute(request, db, path); if (auth) return auth;
    const org = await organizationRoute(request, db, path); if (org) return org;
    const profile = /^\/api\/profiles\/([^/]+)$/.exec(path);
    if (profile && request.method === 'GET') {
      if (!validUsername(profile[1])) throw new HttpError(404, 'Profile not found.');
      const account = await db.account.findUnique({ where: { username: profile[1].toLowerCase() } });
      const publication = account && await db.publication.findUnique({ where: { accountId: account.id } });
      if (!publication) throw new HttpError(404, 'This profile has no published graph.');
      const graph = validatePublicGraph(JSON.parse(gunzipSync(publication.graph, { maxOutputLength: PUBLIC_GRAPH_MAX_BYTES }).toString()));
      return json({ username: account!.username, graph, updatedAt: publication.updatedAt });
    }
    if (path === '/api/account' && request.method === 'GET') {
      const { account } = await authenticate(request, db);
      const publication = await db.publication.findUnique({ where: { accountId: account.id }, select: { updatedAt: true } });
      return json({ username: account.username, publication });
    }
    if (path === '/api/publication') {
      const { account } = await authenticate(request, db);
      if (request.method === 'PUT') {
        const body = await readBody(request, PUBLIC_GRAPH_MAX_BYTES + 100);
        if (body?.confirmed !== true || Object.keys(body).sort().join(',') !== 'confirmed,graph') throw new HttpError(400, 'Confirm publishing from the preview.');
        let graph;
        try { graph = validatePublicGraph(body.graph); } catch (error) { throw new HttpError(400, (error as Error).message); }
        const compressed = gzipSync(JSON.stringify(graph));
        if (compressed.length > 1_000_000) throw new HttpError(413, 'This graph is too large. Choose a smaller date range.');
        const publication = await transaction(db, tx => tx.publication.upsert({ where: { accountId: account.id }, create: { accountId: account.id, graph: compressed }, update: { graph: compressed }, select: { updatedAt: true } }));
        return json({ username: account.username, publication });
      }
      if (request.method === 'DELETE') {
        await db.publication.deleteMany({ where: { accountId: account.id } });
        return json({ unpublished: true });
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    throw new HttpError(404, 'Not found.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if ((error as { code?: string }).code === 'P2002') return json({ error: 'That name or invitation already exists.' }, 409);
    console.error('[sessiongraph-public]', error instanceof Error ? error.name : 'Unknown error');
    return json({ error: 'The service is temporarily unavailable. Please try again.' }, 503);
  }
}
