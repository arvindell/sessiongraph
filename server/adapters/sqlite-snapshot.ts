import { DatabaseSync } from 'node:sqlite';
import { chmodSync, constants, copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { copyFile, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './common';

// Opening a live WAL database read-only can still create or update its SHM.
// Query a private copy instead. Keep only two copies, never a connection to the source.
const copies = new Map<string, { revision: string; directory: string; db: DatabaseSync }>();
export class SqliteSnapshotChangedError extends Error {}
export class SqliteSnapshotFileError extends Error {}
const close = (path: string) => {
  const copy = copies.get(path); if (!copy) return;
  copies.delete(path);
  try { copy.db.close(); } finally { rmSync(copy.directory, { recursive: true, force: true }); }
};
process.once('exit', () => { for (const path of copies.keys()) close(path); });

function snapshotFiles(path: string, large: boolean) {
  return [path, `${path}-wal`].map((file, i) => {
    try {
      const s = lstatSync(file);
      const kind = i ? 'History database WAL' : 'History database';
      if (!s.isFile()) throw new SqliteSnapshotFileError(`${kind} is not a regular file.`);
      if (!large && s.size > 8_000_000_000) throw new SqliteSnapshotFileError(`${kind} exceeds 8 GB.`);
      return s;
    } catch (error) { if (i && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  });
}

const fingerprint = (path: string, files: ReturnType<typeof snapshotFiles>) =>
  digest([path, ...files.map(s => s && [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs])]);

export function sqliteRevision(path: string): string {
  return fingerprint(path, snapshotFiles(path, false));
}

function openSnapshot(destination: string) {
  const db = new DatabaseSync(destination, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try { db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN;'); return db; }
  catch (error) { db.close(); throw error; }
}

/** T3 can have very large databases. Never fall back to a blocking bulk copy. */
export async function withLargeSqliteSnapshot<T>(path: string, read: (db: DatabaseSync, revision: string) => T, expected?: string): Promise<T> {
  const retained = copies.get(path);
  if (expected && retained?.revision === expected) return read(retained.db, expected);
  const files = snapshotFiles(path, true), revision = fingerprint(path, files);
  if (expected && revision !== expected) throw new SqliteSnapshotChangedError('History database changed during import; import again.');
  if (retained?.revision === revision) {
    const result = read(retained.db, revision);
    if (fingerprint(path, snapshotFiles(path, true)) !== revision) throw new SqliteSnapshotChangedError('History database changed during reading; import again.');
    return result;
  }
  close(path);
  while (copies.size >= 2) close(copies.keys().next().value!);
  const directory = mkdtempSync(join(tmpdir(), 'sessiongraph-history-'));
  const destination = join(directory, 'history.db');
  let db: DatabaseSync | undefined;
  try {
    for (const [index, suffix] of ['', '-wal'].entries()) {
      const file = files[index];
      if (!file) continue;
      try { await copyFile(path + suffix, destination + suffix, constants.COPYFILE_FICLONE_FORCE); }
      catch (error) {
        if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
        const { bavail, bsize } = await statfs(directory);
        const reserve = 512 * 1024 * 1024;
        if (bavail * bsize < file.size + reserve) throw new Error('Not enough free space for the T3 history snapshot. Free space on the temporary drive and retry.');
        await copyFile(path + suffix, destination + suffix);
      }
      chmodSync(destination + suffix, 0o600);
    }
    if (fingerprint(path, snapshotFiles(path, true)) !== revision) throw new SqliteSnapshotChangedError('History database changed while copying; import again.');
    db = openSnapshot(destination);
    const result = read(db, revision);
    if (!expected && fingerprint(path, snapshotFiles(path, true)) !== revision) throw new SqliteSnapshotChangedError('History database changed during reading; import again.');
    close(path);
    while (copies.size >= 2) close(copies.keys().next().value!);
    copies.set(path, { revision, directory, db });
    return result;
  } catch (error) {
    try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fingerprint(path, snapshotFiles(path, true)) !== revision)
      throw new SqliteSnapshotChangedError('History database changed while copying; import again.');
    throw error;
  }
}

export function withSqliteSnapshot<T>(path: string, read: (db: DatabaseSync) => T, expected?: string, pinned = false): T {
  // An active source can change after discovery. A pinned copy keeps all pages
  // of that import on the same already-verified SQLite snapshot.
  const retained = copies.get(path);
  if (pinned && expected && retained?.revision === expected) return read(retained.db);
  const revision = sqliteRevision(path);
  if (expected && revision !== expected) throw new SqliteSnapshotChangedError('History database changed during import; import again.');
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
      if (sqliteRevision(path) !== revision) throw new SqliteSnapshotChangedError('History database changed while copying; import again.');
      db = openSnapshot(destination);
      copy = { revision, directory, db }; copies.set(path, copy);
    } catch (error) {
      try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      throw error;
    }
  }
  const result = read(copy.db);
  if (!pinned && sqliteRevision(path) !== revision) throw new SqliteSnapshotChangedError('History database changed during reading; import again.');
  return result;
}

/** Names come only from our adapter definitions; views and virtual tables are excluded. */
export function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return typeof row?.sql === 'string' && !/CREATE\s+VIRTUAL/i.test(row.sql);
}

export function closeSqliteSnapshots() { for (const path of copies.keys()) close(path); }
