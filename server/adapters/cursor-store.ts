import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cursorMessage } from './cursor-message';
import { boundEventPayloads } from '../events';
import type { ImportedMessage } from './types';

const MAX_VALUE = 2_000_000, MAX_BYTES = 64_000_000, MAX_NODES = 50_000, MAX_TEXT = 16_000_000;

/** SQLite can create WAL/SHM even on a read-only connection. Open only a private
 * copy, including the WAL, and reject any source change during copying. */
function withStore<T>(path: string, read: (db: DatabaseSync) => T): T {
  const files = [path, `${path}-wal`];
  const stats = () => files.map((file) => {
    try {
      const s = lstatSync(file);
      if (!s.isFile() || s.size > 256_000_000) throw new Error('Cursor store must be a regular file below 256 MB (including each WAL).');
      return [s.ino, s.size, s.mtimeMs, s.ctimeMs];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file !== path) return null; throw error; }
  });
  const before = stats(), directory = mkdtempSync(join(tmpdir(), 'sessiongraph-cursor-'));
  let db: DatabaseSync | undefined;
  try {
    chmodSync(directory, 0o700);
    const copy = join(directory, 'store.db');
    files.forEach((file, index) => { if (before[index]) { const target = index ? `${copy}-wal` : copy; copyFileSync(file, target); chmodSync(target, 0o600); } });
    if (JSON.stringify(stats()) !== JSON.stringify(before)) throw new Error('Cursor store changed while copying; re-import to retry.');
    db = new DatabaseSync(copy, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN;');
    return read(db);
  } finally { try { db?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } }
}

function metadata(db: DatabaseSync): Record<string, any> {
  const row = db.prepare('SELECT value FROM meta WHERE key=? AND length(value)<=?').get('0', MAX_VALUE);
  if (typeof row?.value !== 'string' || !/^(?:[a-f\d]{2})+$/i.test(row.value)) throw new Error('Unsupported Cursor store metadata.');
  const value = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported Cursor store metadata.');
  return value;
}

export const cursorStoreMetadata = (path: string) => withStore(path, metadata);

// Store nodes use protobuf length-delimited hash references: field 1 is a
// message, field 2 an ordered subtree. Leaves are JSON, or JSON in field 4.
// Parse wire boundaries rather than scanning arbitrary bytes for hash patterns.
function fields(data: Buffer) {
  let at = 0;
  const values: { field: number; data: Buffer }[] = [];
  const uint = () => {
    let value = 0;
    for (let shift = 0; shift <= 49 && at < data.length; shift += 7) {
      const byte = data[at++]; value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) { if (!Number.isSafeInteger(value)) break; return value; }
    }
    throw new Error('Invalid Cursor store wire value.');
  };
  while (at < data.length) {
    const tag = uint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error('Invalid Cursor store field.');
    if (wire === 0) { uint(); continue; }
    if (wire === 1 || wire === 5) at += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const length = uint(), end = at + length;
      if (end > data.length) throw new Error('Truncated Cursor store field.');
      values.push({ field, data: data.subarray(at, end) }); at = end;
    } else throw new Error('Unsupported Cursor store field.');
    if (at > data.length) throw new Error('Truncated Cursor store field.');
  }
  return values;
}

export function readCursorStore(path: string) {
  return withStore(path, (db) => {
    const meta = metadata(db), root = meta.latestRootBlobId;
    if (!root) throw new Error('Cursor store has no committed conversation root.');
    if (typeof root !== 'string' || !/^[a-f\d]{64}$/i.test(root)) throw new Error('Unsupported Cursor conversation root.');
    const get = db.prepare('SELECT data FROM blobs WHERE id=? AND length(data)<=?');
    const messages: ImportedMessage[] = [];
    let bytes = 0, nodes = 0, text = 0, partial = false, ordinal = 0;
    const stack: { id: string; leaf: boolean; ancestors: string[] }[] = [{ id: root, leaf: false, ancestors: [] }];
    while (stack.length) {
      if (++nodes > MAX_NODES || bytes >= MAX_BYTES || text >= MAX_TEXT) { partial = true; break; }
      const item = stack.pop()!;
      if (item.ancestors.length > 128 || item.ancestors.includes(item.id)) { partial = true; continue; }
      const row = get.get(item.id, Math.min(MAX_VALUE, MAX_BYTES - bytes));
      if (!(row?.data instanceof Uint8Array)) { partial = true; continue; }
      const data = Buffer.from(row.data); bytes += data.length;
      try {
        if (item.leaf) {
          const json = data[0] === 123 ? data : fields(data).find((v) => v.field === 4)?.data;
          if (!json) { partial = true; continue; }
          const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
          // A repeated content-addressed leaf can be a distinct turn. Native
          // IDs win; otherwise preserve occurrences in conversation order.
          const msg = cursorMessage(raw, `blob:${item.id}:${ordinal++}`);
          if (!msg) { partial = true; continue; }
          if (msg.role === 'system') continue;
          let remaining = MAX_TEXT - text;
          msg.fragments = msg.fragments.flatMap((f) => {
            const value = f.text.slice(0, remaining); remaining -= value.length;
            if (value.length !== f.text.length) msg.partial = true;
            return value ? [{ ...f, text: value }] : [];
          });
          remaining -= boundEventPayloads(msg, remaining);
          text = MAX_TEXT - remaining; partial ||= Boolean(msg.partial); messages.push(msg);
        } else {
          const refs = fields(data).filter((v) => v.field === 1 || v.field === 2);
          if (!refs.length) partial = true;
          if (stack.length + refs.length > MAX_NODES) { partial = true; break; }
          for (const ref of refs.reverse()) {
            if (ref.data.length !== 32) { partial = true; continue; }
            stack.push({ id: ref.data.toString('hex'), leaf: ref.field === 1, ancestors: [...item.ancestors, item.id] });
          }
        }
      } catch { partial = true; }
    }
    if (!messages.length) throw new Error('Cursor store has no readable conversation at its saved root. Previous imports are retained.');
    return { meta, messages, partial };
  });
}
