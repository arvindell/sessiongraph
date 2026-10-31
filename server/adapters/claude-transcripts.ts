import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SDKSessionInfo, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { digest } from './common';

export const claudeSessionID = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const MAX_BYTES = 128_000_000;
const sidecar = (path: string) => basename(path).startsWith('agent-') ? path.replace(/\.jsonl$/, '.meta.json') : undefined;
async function state(path: string) {
  const s = await lstat(path);
  if (!s.isFile()) throw new Error('Claude transcript must be a regular file.');
  return { size: s.size, modified: s.mtimeMs, signature: [s.dev, s.ino, s.size, s.mtimeMs] };
}
async function metadataState(path: string) {
  const file = sidecar(path);
  try { return file ? await state(file) : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function claudeRevision(path: string) {
  return digest([6, (await state(path)).signature, (await metadataState(path))?.signature]);
}
async function bytes(path: string, max: number) {
  const before = await state(path);
  if (before.size > max) throw new Error(`Claude transcript exceeds the ${max === MAX_BYTES ? '128 MB import' : 'metadata size'} limit.`);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.signature[0] || opened.ino !== before.signature[1]) throw new Error('Claude transcript changed during import; import again.');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== before.size || digest((await state(path)).signature) !== digest(before.signature)) throw new Error('Claude transcript changed during import; import again.');
    return buffer.toString('utf8', 0, length);
  } finally { await file.close(); }
}

export interface ClaudeTranscript {
  entries: SessionStoreEntry[];
  times: Map<string, number>;
  partial: boolean;
  size: number;
  modified: number;
}
let cached: { path: string; revision: string; transcript: ClaudeTranscript } | undefined;
export async function claudeTranscript(path: string, revision: string): Promise<ClaudeTranscript> {
  if (await claudeRevision(path) !== revision) throw new Error('Claude transcript changed during import; import again.');
  if (cached?.path === path && cached.revision === revision) return cached.transcript;
  const source = await bytes(path, MAX_BYTES), entries: SessionStoreEntry[] = [], times = new Map<string, number>();
  let partial = false;
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) { partial = true; continue; }
      entries.push(row);
      if (typeof row.uuid === 'string') {
        const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        times.set(row.uuid, Number.isFinite(time) && time > 0 ? time : 0);
      }
    } catch { partial = true; }
    if (entries.length > 200_000) throw new Error('Claude transcript exceeds the 200,000-record import limit.');
  }
  const metadata = sidecar(path);
  if (metadata && await metadataState(path)) {
    try { entries.push({ ...JSON.parse(await bytes(metadata, 64_000)), type: 'agent_metadata' }); }
    catch { partial = true; }
  }
  if (await claudeRevision(path) !== revision) throw new Error('Claude transcript changed during import; import again.');
  const { size, modified } = await state(path), transcript = { entries, times, partial, size, modified };
  cached = { path, revision, transcript };
  return transcript;
}

/** The SDK's title extraction can omit valid VS Code conversations with IDE-prefixed prompts. */
export function claudeTranscriptInfo(transcript: ClaudeTranscript, sessionId: string): SDKSessionInfo | undefined {
  const rows = transcript.entries;
  if (rows[0]?.isSidechain === true) return;
  const messages = rows.filter(row => (row.type === 'user' || row.type === 'assistant') && row.sessionId === sessionId && row.isSidechain !== true && typeof row.uuid === 'string' && row.message && typeof row.message === 'object');
  if (!messages.length) return;
  const firstPrompt = messages.filter(row => row.type === 'user' && !row.isMeta).map(row => {
    const content = (row.message as { content?: unknown }).content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
    return text.replace(/<(ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>/g, '').trim().replace(/\s+/g, ' ').slice(0, 180);
  }).find(Boolean);
  const title = rows.findLast(row => ['custom-title', 'ai-title', 'summary'].includes(String(row.type)) && typeof (row.customTitle || row.aiTitle || row.summary) === 'string');
  const cwd = rows.findLast(row => row.type === 'relocated' && typeof row.relocatedCwd === 'string')?.relocatedCwd || messages.find(row => typeof row.cwd === 'string')?.cwd;
  const createdAt = messages.map(row => transcript.times.get(String(row.uuid))).find(time => time && time > 0);
  return { sessionId, summary: String(title?.customTitle || title?.aiTitle || title?.summary || firstPrompt || 'Claude Code session'), firstPrompt, cwd: typeof cwd === 'string' ? cwd : undefined, createdAt, lastModified: transcript.modified, fileSize: transcript.size };
}

/** Bind the SDK's conversation-chain parser to the discovered file, independent of cwd encoding. */
export function claudeTranscriptStore(transcript: ClaudeTranscript, sessionId: string, agent?: string): SessionStore {
  return {
    async load(key) { return key.sessionId === sessionId && key.subpath === (agent ? `subagents/agent-${agent}` : undefined) ? transcript.entries : null; },
    async append() { throw new Error('Claude history is read-only.'); },
  };
}
