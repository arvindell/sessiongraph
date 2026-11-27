import { gunzipSync } from 'node:zlib';
import { PUBLIC_GRAPH_MAX_BYTES, validatePublicGraph, type PublicGraph } from '@sessiongraph/core/public-graph';
import { publicGraphStats } from '@sessiongraph/core/public-stats';
import { publicGraphThumbnail } from '@sessiongraph/core/public-thumbnail';
import { digest } from './security';
import { transaction, type DB } from './db';

export const decodePublication = (bytes: Uint8Array) => validatePublicGraph(JSON.parse(gunzipSync(bytes, { maxOutputLength: PUBLIC_GRAPH_MAX_BYTES }).toString()));

/** Generate once at publication time; neither gallery nor thumbnail reads load graph blobs. */
export function publicationPreview(graph: PublicGraph) {
  const stats = publicGraphStats(graph);
  return { ...stats, tokenCount: stats.tokenCount === null ? null : BigInt(stats.tokenCount), thumbnail: publicGraphThumbnail(graph), revision: digest(JSON.stringify(graph)) };
}

/** Backfill old snapshots in bounded batches without overwriting a newer preview. */
export async function backfillPublicationPreviews(db: DB) {
  let cursor = '', count = 0;
  for (;;) {
    const rows = await db.publication.findMany({ where: { accountId: { gt: cursor } }, orderBy: { accountId: 'asc' }, take: 20 });
    if (!rows.length) return count;
    for (const row of rows) {
      const preview = publicationPreview(decodePublication(row.graph));
      const saved = await transaction(db, async tx => {
        const current = await tx.publication.findUnique({ where: { accountId: row.accountId }, select: { updatedAt: true } });
        if (!current || current.updatedAt.getTime() !== row.updatedAt.getTime()) return false;
        const existing = await tx.publicationPreview.findUnique({ where: { accountId: row.accountId }, select: { updatedAt: true } });
        if (existing && existing.updatedAt.getTime() >= row.updatedAt.getTime()) return false;
        const data = { accountId: row.accountId, updatedAt: row.updatedAt, ...preview };
        const result = existing
          ? await tx.publicationPreview.updateMany({ where: { accountId: row.accountId, updatedAt: existing.updatedAt }, data })
          : await tx.publicationPreview.createMany({ data, skipDuplicates: true });
        // Compare-and-swap also protects local PostgreSQL's read-committed mode.
        // Public reads always join to the matching live publication.
        return result.count > 0;
      });
      if (saved) count++;
    }
    cursor = rows.at(-1)!.accountId;
  }
}
