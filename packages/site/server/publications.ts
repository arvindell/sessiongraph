import { gunzipSync } from 'node:zlib';
import { PUBLIC_GRAPH_MAX_BYTES, validatePublicGraph } from '@sessiongraph/core/public-graph';
import { publicGraphStats } from '@sessiongraph/core/public-stats';
import { publicGraphThumbnail } from '@sessiongraph/core/public-thumbnail';
import type { DB } from './db';
import { HttpError, json, validUsername } from './security';

const decode = (bytes: Uint8Array) => validatePublicGraph(JSON.parse(gunzipSync(bytes, { maxOutputLength: PUBLIC_GRAPH_MAX_BYTES }).toString()));
export async function publicRoute(request: Request, db: DB, path: string) {
  if (request.method !== 'GET') return null;
  if (path === '/api/graphs') {
    const raw = new URL(request.url).searchParams.get('page') ?? '0';
    if (!/^\d{1,5}$/.test(raw)) throw new HttpError(400, 'Invalid page.');
    const page = Number(raw), size = 12;
    const publications = await db.publication.findMany({ orderBy: [{ publishedAt: 'desc' }, { accountId: 'asc' }], skip: page * size, take: size + 1, select: { accountId: true, graph: true, updatedAt: true } });
    const rows = publications.slice(0, size);
    const accounts = await db.account.findMany({ where: { id: { in: rows.map(p => p.accountId) }, username: { not: null } }, select: { id: true, username: true } });
    const names = new Map(accounts.map(a => [a.id, a.username]));
    const graphs = rows.flatMap(publication => {
      const username = names.get(publication.accountId);
      if (!validUsername(username)) return [];
      // Never spread database records or expose account IDs, compressed payloads, or credentials.
      return [{ username, updatedAt: publication.updatedAt, ...publicGraphStats(decode(publication.graph)) }];
    });
    return json({ graphs, nextPage: publications.length > size ? page + 1 : null });
  }
  const profile = /^\/api\/profiles\/([^/]+)(\/thumbnail\.svg)?$/.exec(path);
  if (!profile) return null;
  if (!validUsername(profile[1])) throw new HttpError(404, 'Profile not found.');
  const account = await db.account.findUnique({ where: { username: profile[1].toLowerCase() }, select: { id: true, username: true } });
  const publication = account && await db.publication.findUnique({ where: { accountId: account.id }, select: { graph: true, updatedAt: true } });
  if (!publication) throw new HttpError(404, 'This profile has no published graph.');
  const graph = decode(publication.graph);
  if (profile[2]) return new Response(publicGraphThumbnail(graph), { headers: {
    'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
  return json({ username: account!.username, graph, updatedAt: publication.updatedAt });
}
