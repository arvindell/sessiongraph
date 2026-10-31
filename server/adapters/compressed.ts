import { gunzipSync, zstdDecompressSync } from 'node:zlib';

/** Bounds apply to expanded data too; never shell out to an installed harness. */
export function expandHistory(buffer: Buffer, maxOutputLength: number): Buffer {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0xfd2fb528) return zstdDecompressSync(buffer, { maxOutputLength });
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return gunzipSync(buffer, { maxOutputLength });
  if (buffer.length > maxOutputLength) throw new Error('Expanded history exceeds the snapshot limit.');
  return buffer;
}
