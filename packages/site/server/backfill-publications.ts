import { database } from './db';
import { backfillPublicationPreviews } from './publication-preview';
import { purgePublicCache } from './public-cache';

const db = database();
try {
  const count = await backfillPublicationPreviews(db);
  const accounts = await db.account.findMany({ where: { username: { not: null } }, select: { username: true } });
  for (let i = 0; i < accounts.length; i += 100) await purgePublicCache(accounts.slice(i, i + 100).map(account => account.username!));
  console.log(`Prepared ${count} public publication previews.`);
} finally { await db.$disconnect(); }
