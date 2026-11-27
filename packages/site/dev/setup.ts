import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { localDatabaseUrl } from './public-api';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { backfillPublicationPreviews } from '../server/publication-preview';

// Initializes only the empty, dedicated local website database. Never drops existing data.
const pool = new pg.Pool({ connectionString: localDatabaseUrl() });
try {
  const result = await pool.query(`SELECT to_regclass('sessiongraph."Publication"') AS publication, to_regclass('public."Account"') AS legacy`);
  if (result.rows[0].publication) {
    const preview = await pool.query(`SELECT to_regclass('sessiongraph."PublicationPreview"') AS preview`);
    if (!preview.rows[0].preview) {
      const sql = await readFile(new URL('../prisma/migrations/202611270001_publication_previews/migration.sql', import.meta.url), 'utf8');
      await pool.query(sql.replaceAll('INDEX ASYNC', 'INDEX'));
    }
    console.log('Local website database is initialized.');
  }
  else {
    if (result.rows[0].legacy) throw new Error('An existing partial schema needs migration before local setup can continue.');
    const root = new URL('../prisma/migrations/', import.meta.url);
    for (const directory of (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = await readFile(new URL(`${directory.name}/migration.sql`, root), 'utf8');
      await pool.query(sql.replaceAll('INDEX ASYNC', 'INDEX'));
    }
    console.log('Local website database initialized. Public gallery is ready.');
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: localDatabaseUrl() }, { schema: 'sessiongraph' }) });
  try { console.log(`Prepared ${await backfillPublicationPreviews(db)} public publication previews.`); }
  finally { await db.$disconnect(); }
} finally { await pool.end(); }
