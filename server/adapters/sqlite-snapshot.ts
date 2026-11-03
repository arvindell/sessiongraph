import { DatabaseSync } from 'node:sqlite';
import { chmodSync, constants, copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './common';

// Opening a live WAL database read-only can still create or update its SHM.
// Query a private copy instead. Keep only two copies, never a connection to the source.
const copies = new Map<string, { revision: string; directory: string; db: DatabaseSync }>();
const close = (path: string) => {
  const copy = copies.get(path); if (!copy) return;
  copies.delete(path);
  try { copy.db.close(); } finally { rmSync(copy.directory, { recursive: true, force: true }); }
};
process.once('exit', () => { for (const path of copies.keys()) close(path); });

export function sqliteRevision(path: string): string {
  return digest([path, ...[path, `${path}-wal`].map((file, i) => {
    try {
      const s = lstatSync(file);
      if (!s.isFile() || s.size > 8_000_000_000) throw new Error('History database must be a regular file below 8 GB.');
      return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
    } catch (error) { if (i && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  })]);
}

export function withSqliteSnapshot<T>(path: string, read: (db: DatabaseSync) => T, expected?: string, pinned = false): T {
  // An active source can change after discovery. A pinned copy keeps all pages
  // of that import on the same already-verified SQLite snapshot.
  const retained = copies.get(path);
  if (pinned && expected && retained?.revision === expected) return read(retained.db);
  const revision = sqliteRevision(path);
  if (expected && revision !== expected) throw new Error('History database changed during import; import again.');
  let copy = copies.get(path);
  if (copy?.revision !== revision) {
    close(path);
    while (copies.size >= 2) close(copies.keys().next().value!);
    const directory = mkdtempSync(join(tmpdir(), 'sessiongraph-history-'));
    let db: DatabaseSync | undefined;
    try {
      chmodSync(directory, 0o700);
      const destination = join(directory, 'history.db');
      for (const suffix of ['', '-wal']) {
        try {
          copyFileSync(path + suffix, destination + suffix, constants.COPYFILE_FICLONE);
          chmodSync(destination + suffix, 0o600);
        } catch (error) { if (suffix && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      }
      if (sqliteRevision(path) !== revision) throw new Error('History database changed while copying; import again.');
      db = new DatabaseSync(destination, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN;');
      copy = { revision, directory, db }; copies.set(path, copy);
    } catch (error) {
      try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      throw error;
    }
  }
  const result = read(copy.db);
  if (!pinned && sqliteRevision(path) !== revision) throw new Error('History database changed during reading; import again.');
  return result;
}

/** Names come only from our adapter definitions; views and virtual tables are excluded. */
export function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return typeof row?.sql === 'string' && !/CREATE\s+VIRTUAL/i.test(row.sql);
}

export function closeSqliteSnapshots() { for (const path of copies.keys()) close(path); }
