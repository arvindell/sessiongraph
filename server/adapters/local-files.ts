import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { blankSession, digest, identity, project } from './common';
import type { Candidate, ImportedMessage, SessionAdapter } from './types';
import type { Session } from '../../src/types';

export type Raw = Record<string, any>;
export const object = (value: unknown): Raw => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
export const text = (value: unknown): string => typeof value === 'string' ? value : '';
export const time = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? (/^\d{13}$/.test(value) ? Number(value) : Date.parse(value)) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const MAX_BYTES = 32_000_000, MAX_RECORDS = 50_000, MAX_FILES = 20_000;
export interface LocalHistory {
  nativeID: string;
  messages: ImportedMessage[];
  session?: Partial<Session>;
  parent?: string;
  fork?: string;
  partial?: boolean;
  note: string;
}
interface LocalSource {
  id: string;
  name: string;
  description: string;
  capabilities: SessionAdapter['capabilities'];
  roots: () => string[];
  match: (relativePath: string) => boolean;
  extras?: (path: string) => string[];
  /** Immutable creation metadata in a shared index must not invalidate every session. */
  revisionExtras?: boolean;
  parse: (path: string, files: Map<string, string>) => LocalHistory;
}

async function fileState(path: string) {
  try {
    const s = await lstat(path);
    if (!s.isFile()) throw new Error('History must be a regular file, not a symlink.');
    if (s.size > MAX_BYTES) throw new Error('History exceeds the 32 MB per-file limit.');
    return { path, signature: digest([s.size, s.mtimeMs, s.ctimeMs, s.ino]), created: s.birthtimeMs || s.mtimeMs, updated: s.mtimeMs, size: s.size };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, signature: 'missing', created: 0, updated: 0, size: 0 }; throw error; }
}

export async function historyFiles(roots: string[], match: LocalSource['match']) {
  const files: string[] = [], queue: { root: string; path: string; depth: number }[] = [];
  const warnings: string[] = [];
  for (const root of new Set(roots)) {
    try { if ((await lstat(root)).isDirectory()) queue.push({ root, path: root, depth: 0 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('A history directory could not be read.'); }
  }
  let entriesSeen = 0, limited = false;
  for (let i = 0; i < queue.length && files.length < MAX_FILES && entriesSeen < 100_000; i++) {
    const { root, path, depth } = queue[i];
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { warnings.push('A history directory could not be read.'); continue; }
    for (const entry of entries) {
      if (++entriesSeen > 100_000 || files.length >= MAX_FILES) { limited = true; break; }
      const file = join(path, entry.name);
      // Directory entries deliberately exclude symlinks, including history files.
      if (entry.isDirectory()) {
        if (depth < 6 && queue.length < MAX_FILES) queue.push({ root, path: file, depth: depth + 1 });
        else limited = true;
      }
      if (entry.isFile() && match(relative(root, file).split('\\').join('/'))) files.push(file);
    }
  }
  if (limited) warnings.push('History discovery reached its file, directory, or depth limit.');
  return { files: [...new Set(files)].sort(), warnings };
}

export function json(value: string): any { return JSON.parse(value); }
export function jsonLines(value: string) {
  const rows: Raw[] = []; let partial = false;
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    if (rows.length >= MAX_RECORDS) throw new Error('History exceeds the 50,000-record limit.');
    if (line.length > 2_000_000) throw new Error('History contains a record larger than 2 MB.');
    try { const row = json(line); if (!row || typeof row !== 'object' || Array.isArray(row)) partial = true; else rows.push(row); }
    catch { partial = true; }
  }
  return { rows, partial };
}

/** A stable, bounded snapshot with source-native identity and index-based paging.
 * Only the last parsed history is retained; discovery caches small metadata only.
 */
export function localFileAdapter(source: LocalSource): SessionAdapter {
  const metadata = new Map<string, Candidate>();
  let cached: { path: string; revision: string; history: LocalHistory } | undefined;
  const states = (path: string) => Promise.all([path, ...(source.extras?.(path) || [])].map(fileState));
  const revision = (values: Awaited<ReturnType<typeof states>>) => digest([1, ...values.filter((_, i) => i === 0 || source.revisionExtras !== false).map(s => [s.path, s.signature])]);
  async function load(path: string, expected: string, before: Awaited<ReturnType<typeof states>>) {
    if (revision(before) !== expected) throw new Error('Session changed during import; import again.');
    if (cached?.path === path && cached.revision === expected) return cached.history;
    if (before[0].signature === 'missing') throw new Error('History file is unavailable.');
    if (before.reduce((n, s) => n + s.size, 0) > MAX_BYTES) throw new Error('Combined history exceeds the 32 MB snapshot limit.');
    const files = new Map<string, string>();
    for (const s of before.filter(s => s.signature !== 'missing')) {
      const handle = await open(s.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const buffer = Buffer.alloc(s.size + 1);
        let bytes = 0;
        while (bytes < buffer.length) { const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!part.bytesRead) break; bytes += part.bytesRead; }
        if (bytes !== s.size) throw new Error('History changed while reading; import again.');
        files.set(s.path, buffer.toString('utf8', 0, bytes));
      } finally { await handle.close(); }
    }
    if (digest(await states(path)) !== digest(before)) throw new Error('History changed while reading; import again.');
    const history = source.parse(path, files);
    if (!history.nativeID || history.nativeID.length > 512) throw new Error('History has no supported native session identity.');
    if (history.messages.length > MAX_RECORDS) throw new Error('History exceeds the 50,000-message limit.');
    cached = { path, revision: expected, history };
    return history;
  }
  return {
    id: source.id, name: source.name, description: source.description, capabilities: source.capabilities,
    async detect() { for (const root of source.roots()) if ((await lstat(root).catch(() => undefined))?.isDirectory()) return true; return false; },
    async discover() {
      const listing = await historyFiles(source.roots(), source.match), found = new Map<string, Candidate>();
      let failed = 0;
      for (const path of listing.files) {
        try {
          const before = await states(path), rev = revision(before);
          let candidate = metadata.get(path);
          if (!candidate || candidate.revision !== rev) {
            const history = await load(path, rev, before);
            const session = { ...blankSession(source.id, history.nativeID), ...history.session };
            session.id = identity(source.id, history.nativeID); session.nativeID = history.nativeID; session.source = source.id;
            session.directory = text(session.directory); session.projectID = project(source.id, session.directory).id;
            session.created = time(session.created) || history.messages.map(m => time(m.time)).find(Boolean) || before[0].created;
            session.updated = before[0].updated; session.agent ||= source.name;
            session.parentID = history.parent ? identity(source.id, history.parent) : undefined;
            session.forkID = history.fork ? identity(source.id, history.fork) : undefined;
            if (session.title === 'Untitled session' || !session.title) session.title = history.messages.flatMap(m => m.role === 'user' ? m.fragments.filter(f => f.kind === 'You').map(f => f.text) : []).find(Boolean)?.replace(/\s+/g, ' ').slice(0, 180) || `${source.name} session`;
            candidate = { session, revision: rev, locator: { path } }; metadata.set(path, candidate);
          }
          const previous = found.get(candidate.session.id);
          const preferred = candidate.locator.path.endsWith('.jsonl'), previousPreferred = previous?.locator.path.endsWith('.jsonl');
          if (!previous || preferred && !previousPreferred || preferred === previousPreferred && candidate.session.updated > previous.session.updated) found.set(candidate.session.id, candidate);
        } catch { failed++; }
      }
      const listed = new Set(listing.files); for (const path of metadata.keys()) if (!listed.has(path)) metadata.delete(path);
      if (failed) listing.warnings.push(`${failed} ${source.name} histories were unreadable, changing, unsupported, or over the size limit. Saved imports are kept.`);
      const sessions = [...found.values()];
      return { sessions, projects: [...new Map(sessions.map(c => { const p = project(source.id, c.session.directory); return [p.id, p]; })).values()], warnings: listing.warnings };
    },
    async read(candidate, cursor) {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor.');
      const history = await load(candidate.locator.path, candidate.revision, await states(candidate.locator.path));
      const messages = history.messages.slice(offset, offset + 100);
      const untimed = history.messages.some(m => !time(m.time));
      return { messages, cursor: offset + messages.length < history.messages.length ? String(offset + messages.length) : undefined, partial: Boolean(history.partial || messages.some(m => m.partial)),
        note: `${history.note}${untimed ? ' Missing message timestamps remain unknown; session placement falls back to recorded metadata or file time.' : ''} File snapshots are unavailable.` };
    },
  };
}
