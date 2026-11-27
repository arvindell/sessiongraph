import { Prisma } from '../generated/prisma/client';
import type { DB } from './db';
import type { GalleryEntry, GalleryQuery, GalleryResult } from '../gallery';
import { HttpError, validUsername } from './security';
import { decodePublication } from './publication-preview';
import { galleryTag, profileTag, publicResponse } from './public-cache';
import { explorePage } from './explore-page';

export function galleryQuery(url: URL): GalleryQuery {
  const raw = url.searchParams.get('page') ?? '0';
  const q = (url.searchParams.get('q') || '').trim().replace(/^@/, '').toLowerCase();
  const sort = url.searchParams.get('sort') || 'updated';
  if (!/^\d{1,5}$/.test(raw)) throw new HttpError(400, 'Invalid page.');
  if (!/^[a-z\d-]{0,39}$/.test(q)) throw new HttpError(400, 'Search for a GitHub username.');
  if (sort !== 'updated' && sort !== 'tokens' && sort !== 'sessions') throw new HttpError(400, 'Invalid sort order.');
  return { q, sort, page: Number(raw) };
}

export async function readGallery(db: DB, query: GalleryQuery): Promise<GalleryResult> {
  const size = 12;
  const order = query.sort === 'tokens' ? Prisma.sql`s."tokenCount" DESC NULLS LAST`
    : query.sort === 'sessions' ? Prisma.sql`s."sessionCount" DESC` : Prisma.sql`s."updatedAt" DESC`;
  // Join immutable account ownership to the current username. Fetch scalar
  // metadata only, sort/filter the whole catalog, then paginate.
  const rows = await db.$queryRaw<(Omit<GalleryEntry, 'updatedAt' | 'tokenCount'> & { updatedAt: Date; tokenCount: bigint | null })[]>(Prisma.sql`
    SELECT a."username", s."updatedAt", s."sessionCount", s."tokenCount", s."tokensPartial", s."revision"
    FROM "sessiongraph"."PublicationPreview" s
    JOIN "sessiongraph"."Publication" p ON p."accountId" = s."accountId" AND p."updatedAt" = s."updatedAt"
    JOIN "sessiongraph"."Account" a ON a."id" = s."accountId"
    WHERE a."username" IS NOT NULL AND a."username" LIKE ${`%${query.q}%`}
    ORDER BY ${order}, s."accountId" ASC LIMIT ${size + 1} OFFSET ${query.page * size}
  `);
  return {
    graphs: rows.slice(0, size).map(row => ({ ...row, updatedAt: row.updatedAt.toISOString(), tokenCount: row.tokenCount === null ? null : Number(row.tokenCount) })),
    nextPage: rows.length > size ? query.page + 1 : null,
  };
}

export async function publicRoute(request: Request, db: DB, path: string) {
  if (request.method !== 'GET') return null;
  if (path === '/api/graphs' || path === '/explore') {
    const query = galleryQuery(new URL(request.url));
    const result = await readGallery(db, query);
    return path === '/explore' ? explorePage(request, result, query)
      : publicResponse(request, JSON.stringify(result), 'application/json', [galleryTag]);
  }
  const profile = /^\/api\/profiles\/([^/]+)(\/thumbnail\.svg)?$/.exec(path);
  if (!profile) return null;
  if (!validUsername(profile[1])) throw new HttpError(404, 'Profile not found.');
  const username = profile[1].toLowerCase(), tags = [profileTag(username)];
  if (profile[2]) {
    const rows = await db.$queryRaw<{ thumbnail: string }[]>(Prisma.sql`
      SELECT s."thumbnail" FROM "sessiongraph"."PublicationPreview" s
      JOIN "sessiongraph"."Publication" p ON p."accountId" = s."accountId" AND p."updatedAt" = s."updatedAt"
      JOIN "sessiongraph"."Account" a ON a."id" = s."accountId" WHERE a."username" = ${username} LIMIT 1
    `);
    if (!rows.length) throw new HttpError(404, 'This profile has no published graph.');
    return publicResponse(request, rows[0].thumbnail, 'image/svg+xml', tags);
  }
  const rows = await db.$queryRaw<{ username: string; graph: Uint8Array; updatedAt: Date }[]>(Prisma.sql`
    SELECT a."username", p."graph", p."updatedAt" FROM "sessiongraph"."Publication" p
    JOIN "sessiongraph"."Account" a ON a."id" = p."accountId" WHERE a."username" = ${username} LIMIT 1
  `);
  if (!rows.length) throw new HttpError(404, 'This profile has no published graph.');
  return publicResponse(request, JSON.stringify({ username: rows[0].username, graph: decodePublication(rows[0].graph), updatedAt: rows[0].updatedAt }), 'application/json', tags);
}
