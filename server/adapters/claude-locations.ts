import { lstat, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sourcePath } from '../source-paths';
import { claudeSessionID } from './claude-transcripts';

export interface ClaudeLocations {
  homes: string[];
  warnings: string[];
  pending: boolean;
}

/** All filesystem roots, not just the current user's home. No shell or agents. */
export async function computerRoots(platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return ['/'];
  const drives = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
  return (await Promise.all(drives.map(async drive => (await lstat(drive).catch(() => undefined))?.isDirectory() ? drive : undefined))).filter((p): p is string => Boolean(p));
}

export function excludedScanPaths(platform: NodeJS.Platform = process.platform) {
  if (platform === 'linux') return ['/dev', '/proc', '/sys', '/run'];
  // APFS exposes the same writable volume again here; /Users, /private, etc.
  // already expose its contents. Avoid duplicate mounts and virtual devices.
  if (platform === 'darwin') return ['/dev', '/System/Volumes'];
  return [];
}

interface ScanOptions {
  roots: () => Promise<string[]>;
  preferredHome: () => string;
  excluded?: string[];
  sliceMs?: number;
  maxEntries?: number;
  refreshMs?: number;
  now?: () => number;
  openDirectory?: typeof opendir;
}

/**
 * Directory names only: never opens settings, credentials, or arbitrary files.
 * A cached, resumable walk bounds each request without silently restricting
 * discovery to user homes. Refresh/import requests continue unfinished scans.
 */
export function createClaudeLocationScanner(options: ScanOptions) {
  const now = options.now || Date.now, openDirectory = options.openDirectory || opendir;
  const excluded = new Set((options.excluded || []).map(p => resolve(p)));
  const homes = new Set<string>();
  let queue: { path: string; depth: number; offset: number }[] = [], index = 0;
  let visited = new Set<string>(), skipped = new Set<string>(), limited = false, initialized = false, finishedAt: number | undefined;
  let last: ClaudeLocations | undefined, lastAt = -Infinity, job: Promise<ClaudeLocations> | undefined;
  async function scan(): Promise<ClaudeLocations> {
    const started = now();
    if (!initialized || finishedAt !== undefined && started - finishedAt >= (options.refreshMs ?? 300_000)) {
      queue = [...new Set([dirname(options.preferredHome()), ...await options.roots()])].map(path => ({ path: resolve(path), depth: 0, offset: 0 }));
      index = 0; visited = new Set(); skipped = new Set(); limited = false; initialized = true; finishedAt = undefined;
    }
    // Probe the active home even while a computer-wide scan is still pending.
    homes.add(resolve(options.preferredHome()));
    let entries = 0;
    const budget = options.maxEntries ?? 100_000, deadline = started + (options.sliceMs ?? 2_000);
    while (index < queue.length && entries < budget && now() < deadline) {
      const item = queue[index], path = item.path;
      if (excluded.has(path)) { index++; continue; }
      let complete = true;
      try {
        const info = await lstat(path);
        if (!info.isDirectory()) { index++; continue; } // Includes symlinks.
        const key = `${info.dev}:${info.ino}`;
        if (!item.offset && visited.has(key)) { index++; continue; }
        let offset = 0;
        for await (const entry of await openDirectory(path)) {
          // A slice closes its directory handle. Resume by skipping the prefix,
          // rather than holding OS handles open between import requests.
          if (offset++ < item.offset) continue;
          if (entry.isDirectory()) {
            const child = join(path, entry.name);
            if (entry.name === '.claude') addHome(child);
            if (item.depth < 128 && queue.length < 100_000) queue.push({ path: child, depth: item.depth + 1, offset: 0 });
            else limited = true;
          } else if (entry.isFile() && entry.name.endsWith('.jsonl') && claudeSessionID(entry.name.slice(0, -6)) && basename(dirname(path)) === 'projects') {
            // Also find renamed/custom Claude homes, not only ".claude".
            addHome(dirname(dirname(path)));
          }
          entries++;
          item.offset = offset;
          if (entries >= budget || now() >= deadline) { complete = false; break; }
        }
        if (complete) visited.add(key);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) skipped.add(path);
      }
      if (!complete) break;
      index++;
    }
    const pending = index < queue.length;
    if (!pending && finishedAt === undefined) finishedAt = now();
    // Recheck known homes on every slice. Missing locations never erase imports.
    const found: string[] = [];
    for (const home of homes) {
      try { if (!(await lstat(home)).isDirectory()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped.add(home); continue; }
      for (const name of ['projects', 'transcripts']) {
        try { if ((await lstat(join(home, name))).isDirectory()) { found.push(home); break; } }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) skipped.add(join(home, name)); }
      }
    }
    const warnings: string[] = [];
    if (pending) warnings.push('Claude Code: Computer-wide history search is still in progress. Refresh sessions to continue; known locations are imported now.');
    if (skipped.size) warnings.push(`Claude Code: Computer-wide search skipped ${skipped.size} unreadable or protected locations. OS permissions were not changed; use an accessible copy or a custom history path for missing sessions.`);
    if (limited) warnings.push('Claude Code: Computer-wide search reached its 100,000-directory, 1,000-location, or 128-level depth limit. Use a custom history path for locations outside this scan.');
    return { homes: found, warnings, pending };
  }
  function addHome(home: string) {
    if (homes.size < 1_000) homes.add(home);
    else limited = true;
  }
  return () => {
    if (job) return job;
    // Share a slice between detection, discovery, and concurrent libraries.
    if (last && now() - lastAt < 1_000) return Promise.resolve(last);
    job = scan().then(result => { last = result; lastAt = now(); return result; }).finally(() => { job = undefined; });
    return job;
  };
}

export const activeClaudeHome = () => resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
const scanComputer = createClaudeLocationScanner({
  roots: computerRoots, preferredHome: activeClaudeHome, excluded: excludedScanPaths(),
});

export async function claudeLocations(): Promise<ClaudeLocations> {
  // Explicit configuration narrows the scan and remains library-isolated.
  const configured = sourcePath('claude-code') || process.env.CLAUDE_CONFIG_DIR;
  if (configured) return { homes: [resolve(configured)], warnings: [], pending: false };
  return scanComputer();
}
