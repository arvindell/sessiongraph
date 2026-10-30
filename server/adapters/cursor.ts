import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankSession, digest, identity, project } from './common';
import { cursorMessage, cursorTime } from './cursor-message';
import { cursorStoreMetadata, readCursorStore } from './cursor-store';
import { readJSONL } from './jsonl';
import type { Candidate, SessionAdapter } from './types';

const LIMIT = 20_000;
const validID = (id: string) => /^[a-z\d][\w-]{0,159}$/i.test(id);
const cwd = (value: unknown): string => typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
const slug = (path: string) => path.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, drive: string) => drive.toLowerCase()).replace(/^\/+|\/+$/g, '').replace(/[/:]+/g, '-');
const hashCwd = (path: string) => createHash('md5').update(path).digest('hex');
const userData = () => process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Cursor')
  : process.platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData/Roaming'), 'Cursor')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Cursor');

async function fileStats(path: string) {
  try { const s = await lstat(path); if (s.isSymbolicLink()) throw new Error('Cursor history symlinks are not followed.'); return s.isFile() ? s : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
async function stamp(path: string) {
  const s = await fileStats(path); return s ? [s.ino, s.size, s.mtimeMs] : null;
}
async function snapshot(locator: Record<string, string>) {
  return digest(await Promise.all([stamp(locator.path), locator.kind === 'transcript' ? null : stamp(`${locator.path}-wal`), locator.meta ? stamp(locator.meta) : null]));
}
async function json(path: string) {
  const s = await fileStats(path);
  if (!s) return {};
  if (s.size > 128_000) throw new Error('Cursor metadata exceeds the 128 KB limit.');
  const value = JSON.parse(await readFile(path, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
async function entries(path: string, warnings: string[]) {
  const result: Dirent[] = [];
  try {
    if (!(await lstat(path)).isDirectory()) return result;
    for await (const entry of await opendir(path)) {
      if (!entry.isSymbolicLink()) result.push(entry);
      if (result.length === LIMIT) { warnings.push('Cursor directory listing limited to 20,000 entries.'); break; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('A Cursor history directory could not be listed. Saved imports are retained.'); }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// Directory names are lossy. Only forward-match paths explicitly recorded by
// Cursor; never turn "my-project" into an invented "my/project" directory.
async function workspacePaths(root: string, warnings: string[]) {
  const paths = new Set<string>();
  const storage = join(root, 'User/workspaceStorage');
  for (const entry of await entries(storage, warnings)) if (entry.isDirectory()) {
    try {
      const info = await json(join(storage, entry.name, 'workspace.json'));
      if (typeof info.folder === 'string' && info.folder.startsWith('file:')) {
        const path = cwd(fileURLToPath(info.folder)); if (path) paths.add(path);
      }
    } catch { warnings.push('A Cursor workspace mapping could not be read; its directory may be unknown.'); }
  }
  return [...paths];
}

export function createCursorAdapter(options: { home?: string; userData?: string } = {}): SessionAdapter {
  const root = () => options.home || process.env.SESSION_ATLAS_CURSOR_HOME || join(homedir(), '.cursor');
  return {
    id: 'cursor', name: 'Cursor', description: 'Local IDE JSONL transcripts, subagents, and CLI / ACP stores · read-only',
    capabilities: { history: true, forks: false, children: true, files: false },
    async detect() {
      for (const name of ['projects', 'chats', 'acp-sessions']) {
        try { if ((await lstat(join(root(), name))).isDirectory()) return true; } catch { /* Not installed here. */ }
      }
      return false;
    },
    async discover() {
      const warnings: string[] = [], found = new Map<string, Candidate>(), blocked = new Set<string>();
      const paths = await workspacePaths(options.userData || process.env.SESSION_ATLAS_CURSOR_USER_DATA_DIR || userData(), warnings);
      const match = (key: string, encode: (value: string) => string) => {
        const matches = paths.filter((path) => encode(path) === key); return matches.length === 1 ? matches[0] : '';
      };
      let unreadable = 0, legacy = 0, scanned = 0;
      const add = async (path: string, id: string, kind: string, directory: string, parent = '', workspaceHash = '') => {
        if (!validID(id) || ++scanned > LIMIT) return;
        try {
          const stats = await fileStats(path); if (!stats) return;
          const native = parent ? `${parent}/agent/${id}` : id;
          const locator: Record<string, string> = { path, kind };
          if (kind !== 'transcript') locator.meta = join(path, '..', 'meta.json');
          const before = await snapshot(locator);
          const extra = locator.meta ? await json(locator.meta) : {};
          const meta = kind === 'transcript' ? {} : cursorStoreMetadata(path);
          if (meta.agentId && meta.agentId !== id) throw new Error('Cursor native identity mismatch.');
          if (kind !== 'transcript' && !meta.latestRootBlobId) return; // No committed conversation yet.
          const session = blankSession('cursor', native, cwd(meta.cwd) || cwd(extra.cwd) || directory);
          session.agent = kind === 'cli' ? 'Cursor Agent' : kind === 'acp' ? 'Cursor ACP' : parent ? 'Cursor subagent' : 'Cursor IDE';
          if (parent) session.parentID = identity('cursor', parent);
          session.title = typeof meta.name === 'string' && meta.name.trim() ? meta.name : typeof extra.title === 'string' && extra.title.trim() ? extra.title : 'Cursor session';
          session.title = session.title.slice(0, 300);
          session.created = cursorTime(meta.createdAt) || cursorTime(extra.createdAtMs);
          session.updated = cursorTime(extra.updatedAtMs) || stats.mtimeMs;
          if (kind === 'transcript') {
            const page = await readJSONL(path, 0, 2_000_000, 100);
            let first = 0;
            for (const row of page.rows) {
              const message = cursorMessage(row.value, `offset:${row.offset}`);
              if (message?.time && (!first || message.time < first)) first = message.time;
              if (session.title === 'Cursor session' && message?.role === 'user') {
                const text = message.fragments.find((f) => f.kind === 'You')?.text;
                if (text) session.title = text.replace(/\s+/g, ' ').slice(0, 180);
              }
              if (!session.directory) session.directory = cwd(row.value?.cwd);
              if (!session.created) session.created = cursorTime(row.value?.sessionCreatedAt);
              const model = row.value?.message?.model || row.value?.model;
              if (typeof model === 'string') session.model = model;
            }
            if (!session.created && first) { session.created = first; locator.timeNote = 'Session start estimated from the first recorded message.'; }
          }
          if (!session.created) { session.created = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs; locator.timeNote = 'Session creation time unavailable; file creation/modification time is used for placement.'; }
          if (!session.directory) locator.directoryNote = 'Working directory is unknown; choose one when continuing.';
          session.projectID = project('cursor', session.directory).id;
          session.nativeResume = kind === 'cli' && Boolean(session.directory) && hashCwd(session.directory) === workspaceHash && root() === join(homedir(), '.cursor');
          locator.snapshot = before;
          if (await snapshot(locator) !== before) throw new Error('Cursor session changed during discovery.');
          const candidate = { session, locator, revision: digest([2, kind, path, before, session.directory, session.parentID]) };
          const previous = found.get(session.id);
          // Choose a single representation, never append overlapping exports.
          const rank = (c: Candidate) => c.locator.kind === 'transcript' ? 0 : 1;
          if (!previous || rank(candidate) > rank(previous) || (rank(candidate) === rank(previous) && session.updated > previous.session.updated)) found.set(session.id, candidate);
        } catch {
          unreadable++;
          // An unreadable primary store must not replace saved history with a
          // shorter transcript export. Retry it on the next discovery instead.
          if (kind !== 'transcript') blocked.add(identity('cursor', id));
        }
      };
      const projects = join(root(), 'projects');
      for (const dir of await entries(projects, warnings)) {
        if (!dir.isDirectory() || scanned >= LIMIT) continue;
        const transcripts = join(projects, dir.name, 'agent-transcripts'), directory = match(dir.name, slug);
        for (const entry of await entries(transcripts, warnings)) {
          if (scanned >= LIMIT) break;
          if (entry.isFile() && entry.name.endsWith('.jsonl')) await add(join(transcripts, entry.name), entry.name.slice(0, -6), 'transcript', directory);
          else if (entry.isFile() && entry.name.endsWith('.txt')) legacy++;
          else if (entry.isDirectory() && validID(entry.name)) {
            await add(join(transcripts, entry.name, `${entry.name}.jsonl`), entry.name, 'transcript', directory);
            for (const child of await entries(join(transcripts, entry.name, 'subagents'), warnings)) {
              if (child.isFile() && child.name.endsWith('.jsonl')) await add(join(transcripts, entry.name, 'subagents', child.name), child.name.slice(0, -6), 'transcript', directory, entry.name);
              if (scanned >= LIMIT) break;
            }
          }
        }
      }
      const chats = join(root(), 'chats');
      for (const bucket of await entries(chats, warnings)) {
        if (!bucket.isDirectory() || scanned >= LIMIT) continue;
        const folder = join(chats, bucket.name), directory = match(bucket.name, hashCwd);
        // Some versions use chats/<compact-uuid>/store.db directly.
        if (/^[a-f\d]{32}$/i.test(bucket.name) && await fileStats(join(folder, 'store.db'))) {
          const id = bucket.name.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
          await add(join(folder, 'store.db'), id, 'cli', '');
        }
        for (const entry of await entries(folder, warnings)) {
          if (entry.isDirectory()) await add(join(folder, entry.name, 'store.db'), entry.name, 'cli', directory, '', bucket.name);
          if (scanned >= LIMIT) break;
        }
      }
      const acp = join(root(), 'acp-sessions');
      for (const entry of await entries(acp, warnings)) {
        if (entry.isDirectory()) await add(join(acp, entry.name, 'store.db'), entry.name, 'acp', '');
        if (scanned >= LIMIT) break;
      }
      if (scanned >= LIMIT) warnings.push('Cursor discovery limited to 20,000 history files.');
      if (unreadable) warnings.push(`${unreadable} Cursor histories were unreadable or changed during discovery; saved imports are retained. Re-import to retry.`);
      if (legacy) warnings.push(`${legacy} older plain-text Cursor transcripts are not supported.`);
      warnings.push('Cursor imports local IDE JSONL and CLI/ACP stores. Legacy Composer databases, plain-text exports, cloud-only and SDK-only history are not imported. Formats are not a stable public API.');
      const sessions = [...found.values()].filter((c) => !blocked.has(c.session.id));
      return { sessions, projects: [...new Map(sessions.map((c) => { const p = project('cursor', c.session.directory); return [p.id, p]; })).values()], warnings: [...new Set(warnings)] };
    },
    async read(candidate, cursor) {
      const { locator } = candidate;
      const verify = async () => { if (await snapshot(locator) !== locator.snapshot) throw new Error('Cursor session changed during import; re-import to capture the latest history.'); };
      await verify();
      const note = [locator.kind === 'transcript' ? 'Cursor IDE JSONL export; tool results and pre-compaction history may be absent.' : 'Cursor committed conversation root; abandoned branches and system prompts are excluded.',
        'No file snapshots or inferred edit evidence. Missing message timestamps stay unknown.', locator.timeNote, locator.directoryNote].filter(Boolean).join(' ');
      if (locator.kind !== 'transcript') {
        if (cursor) throw new Error('Invalid Cursor store cursor.');
        const result = readCursorStore(locator.path);
        await verify();
        return { messages: result.messages, partial: result.partial, note: `${note}${result.partial ? ' Unsupported, missing, or bounded store records were omitted (2 MB per blob, 64 MB / 50,000 nodes / 16 million text characters per session).' : ''}` };
      }
      const offset = Number(cursor || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid Cursor transcript cursor.');
      const page = await readJSONL(locator.path, offset);
      const messages = page.rows.flatMap((row) => {
        const message = cursorMessage(row.value, `offset:${row.offset}`);
        if (!message) page.partial = true;
        return message && message.role !== 'system' ? [message] : [];
      });
      await verify();
      if (!offset && page.cursor === undefined && !messages.length) throw new Error('Cursor transcript has no readable conversation. Previous imports are retained.');
      return { messages, cursor: page.cursor === undefined ? undefined : String(page.cursor), partial: true, note: `${note}${page.partial ? ' Malformed or unsupported transcript records were skipped.' : ''}` };
    },
  };
}

export const cursorAdapter = createCursorAdapter();
