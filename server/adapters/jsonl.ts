import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { expandHistory } from './compressed';

let compressed: { path: string; stamp: string; data: Buffer } | undefined;

/** Bounded streaming JSONL reader. Cursors are byte offsets, never line counts.
 * A torn final write is reported as partial, and retried after the file changes.
 */
export async function readJSONL(path: string, offset = 0, budget = 2_000_000, limit = 200) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid transcript cursor.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const rows: { offset: number; value: any }[] = [];
  let position = offset, carry = Buffer.alloc(0), lineStart = offset, partial = false, skipping = false, eof = false;
  try {
    let data: Buffer | undefined;
    if (/\.jsonl\..+/.test(path)) {
      const s = await file.stat(), stamp = JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
      if (!s.isFile() || s.size > 128_000_000) throw new Error('Compressed history exceeds the 128 MB limit.');
      if (compressed?.path === path && compressed.stamp === stamp) data = compressed.data;
      else {
        const input = Buffer.alloc(s.size + 1); let bytes = 0;
        while (bytes < input.length) { const r = await file.read(input, bytes, input.length - bytes, bytes); if (!r.bytesRead) break; bytes += r.bytesRead; }
        const after = await file.stat();
        if (bytes !== s.size || stamp !== JSON.stringify([after.ino, after.size, after.mtimeMs, after.ctimeMs])) throw new Error('Compressed history changed during reading.');
        data = expandHistory(input.subarray(0, bytes), 128_000_000);
        compressed = { path, stamp, data };
      }
    }
    while (rows.length < limit && (position - offset < budget || lineStart === offset || skipping)) {
      if (position - offset > 64_000_000) throw new Error('Transcript contains a line larger than the 64 MB scan limit.');
      const buffer = Buffer.alloc(64_000);
      const bytesRead = data ? data.copy(buffer, 0, Math.min(position, data.length), Math.min(position + buffer.length, data.length)) : (await file.read(buffer, 0, buffer.length, position)).bytesRead;
      if (!bytesRead) { eof = true; break; }
      position += bytesRead;
      carry = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let at;
      while ((at = carry.indexOf(10)) !== -1) {
        const line = carry.subarray(0, at); carry = carry.subarray(at + 1);
        if (!skipping && line.length) { try { rows.push({ offset: lineStart, value: JSON.parse(line.toString('utf8')) }); } catch { partial = true; } }
        skipping = false; lineStart += at + 1;
        if (rows.length >= limit) return { rows, cursor: lineStart, partial };
      }
      if (carry.length > 2_000_000) { partial = true; skipping = true; lineStart += carry.length; carry = Buffer.alloc(0); }
    }
    if (eof && carry.length && !skipping) {
      try { rows.push({ offset: lineStart, value: JSON.parse(carry.toString('utf8')) }); } catch { partial = true; }
    }
    return { rows, cursor: eof ? undefined : lineStart, partial };
  } finally { await file.close(); }
}

export async function transcriptFiles(root: string, max = 20_000, match = (name: string) => name.endsWith('.jsonl')): Promise<string[]> {
  const files: string[] = [], queue = [root];
  for (let i = 0; i < queue.length && files.length < max; i++) {
    let entries;
    try { entries = await readdir(queue[i], { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      // Never follow symlinks out of the selected source's history directory.
      if (entry.isDirectory() && queue.length < 20_000) queue.push(join(queue[i], entry.name));
      if (entry.isFile() && match(entry.name)) files.push(join(queue[i], entry.name));
      if (files.length >= max) break;
    }
  }
  return files;
}
