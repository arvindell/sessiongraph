import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat } from 'node:fs/promises';
import { localFileAdapter, historyFiles, jsonLines, text, time } from './local-files';
import { sqliteHistoryAdapter } from './sqlite-histories';
import { envHome, harnessRoots, tokscalePath } from './harness-paths';
import type { SessionAdapter } from './types';

/** Minimal bounded protobuf wire reader for native trajectory metadata, not conversation payloads. */
export function protoFields(value: Uint8Array): Map<number, bigint | Uint8Array> {
  if (value.length > 2_000_000) throw new Error('Trajectory metadata exceeds 2 MB.');
  const fields = new Map<number, bigint | Uint8Array>(); let at = 0, count = 0;
  const varint = () => {
    let n = 0n;
    for (let i = 0; i < 10 && at < value.length; i++) { const b = value[at++]; n |= BigInt(b & 127) << BigInt(7 * i); if (!(b & 128)) return n; }
    throw new Error('Invalid protobuf varint.');
  };
  while (at < value.length) {
    if (++count > 10_000) throw new Error('Too many protobuf fields.');
    const key = Number(varint()), field = key >>> 3, wire = key & 7;
    if (!field) throw new Error('Invalid protobuf field.');
    if (wire === 0) fields.set(field, varint());
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length > value.length - at) throw new Error('Invalid protobuf length.');
      fields.set(field, value.subarray(at, at + length)); at += length;
    } else if (wire === 1 || wire === 5) { at += wire === 1 ? 8 : 4; if (at > value.length) throw new Error('Truncated protobuf field.'); }
    else throw new Error('Unsupported protobuf wire type.');
  }
  return fields;
}
const nested = (v: bigint | Uint8Array | undefined) => v instanceof Uint8Array ? protoFields(v) : new Map<number, bigint | Uint8Array>();
export const antigravityDatabaseAdapters = ['antigravity-cli', 'antigravity-extension'].map(id => sqliteHistoryAdapter({
  id, name: id === 'antigravity-cli' ? 'Antigravity CLI' : 'Antigravity IDE Extension', history: false,
  description: 'Native session metadata only · opaque protobuf conversations',
  paths: async () => (await historyFiles(harnessRoots(id, () => [envHome('GEMINI_CLI_HOME', '.gemini', id === 'antigravity-cli' ? 'antigravity-cli/conversations' : 'antigravity/conversations')])(), p => p.endsWith('.db'))).files,
  table: 'trajectory_metadata_blob', key: 'id', fields: ['id', 'data'],
  parse(db, row, path) {
    if (!(row.data instanceof Uint8Array)) throw new Error('Unsupported trajectory metadata.');
    const fields = protoFields(row.data), timestamp = nested(fields.get(2));
    const sec = timestamp.get(1), nano = timestamp.get(2);
    const created = typeof sec === 'bigint' && sec > 0n && sec < 8_640_000_000_000n ? time(Number(sec) * 1000 + (typeof nano === 'bigint' && nano < 1_000_000_000n ? Number(nano) / 1e6 : 0)) : 0;
    const uri = nested(fields.get(1)).get(1); let directory = '';
    if (uri instanceof Uint8Array) { try { directory = fileURLToPath(Buffer.from(uri).toString('utf8')); } catch { /* Unknown workspace URI. */ } }
    if (!created) throw new Error('Trajectory creation time is unavailable.');
    return { nativeID: basename(path, '.db'), messages: [], partial: true, session: { created, directory }, note: 'Native Antigravity trajectory identity and creation metadata only. Protobuf conversation/step bodies are opaque; no message text, generation-time guesses, or usage-derived turns are imported.' };
  },
}));

export const antigravityCacheAdapter = localFileAdapter({
  id: 'antigravity', name: 'Antigravity', description: 'Previously synced session metadata only · cache contains no conversations',
  capabilities: { history: false, forks: false, children: false, files: false },
  roots: harnessRoots('antigravity', () => [tokscalePath('antigravity-cache/sessions')]), match: p => p.endsWith('.jsonl'),
  parse(path, files) {
    const { rows } = jsonLines(files.get(path)!);
    const ids = new Set(rows.map(r => text(r.sessionId)).filter(Boolean));
    if (ids.size !== 1) throw new Error('Unsupported Antigravity cache identity.');
    const created = rows.map(r => time(r.timestamp)).filter(Boolean).sort((a, b) => a - b)[0];
    if (!created) throw new Error('Antigravity cache has no recorded date.');
    return { nativeID: [...ids][0], messages: [], partial: true, session: { created, model: text(rows.find(r => r.modelId)?.modelId) || 'Unknown model' }, note: 'Previously synced Antigravity session identity; placement uses earliest recorded usage date. This cache has no conversation bodies. SessionGraph never runs sync or contacts the language server.' };
  },
});

/** Account/request aggregates cannot establish native conversation identities. */
export const usageOnlyAdapters: SessionAdapter[] = [
  { id: 'reasonix', name: 'Reasonix', roots: () => [envHome('REASONIX_STATE_HOME', '.reasonix', 'stats'), envHome('REASONIX_HOME', '.reasonix', 'stats')], note: 'Request statistics lack conversation identities and text. Reasonix transcript import is not yet supported.' },
  { id: 'trae', name: 'Trae / Trae Solo', roots: () => [tokscalePath('trae-cache/sessions')], note: 'The Tokscale cache contains account usage, not local conversations.' },
  { id: 'warp', name: 'Warp / Oz', roots: () => [tokscalePath('warp-cache')], note: 'The Tokscale cache contains aggregate requests and spend, not local conversations.' },
  { id: 'lm-studio', name: 'LM Studio', roots: () => [envHome('LM_STUDIO_HOME', '.lmstudio', 'server-logs')], note: 'Server logs contain final-response usage, not retained prompts or responses.' },
  { id: 'hindsight', name: 'Hindsight', roots: () => [envHome('HINDSIGHT_HOME', '.hindsight', 'usage')], note: 'Synced memory-operation usage is not agent conversation history.' },
].map(source => ({
  id: source.id, name: source.name, description: `Detection only · ${source.note}`,
  capabilities: { history: false, forks: false, children: false, files: false },
  async detect() { for (const p of harnessRoots(source.id, source.roots)()) if ((await lstat(p).catch(() => undefined))?.isDirectory()) return true; return false; },
  async discover() { return { sessions: [], projects: [], warnings: [source.note] }; },
  async read() { throw new Error(source.note); },
}));
