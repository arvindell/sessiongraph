import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { Session } from '@sessiongraph/core/types';
import { sessionEnd } from '@sessiongraph/core/layout';
import { sessionMatchesSource } from '../src/session-links';

export class LibraryError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1) { super(message); }
}
export function invalid(message: string): never { throw new LibraryError('INVALID_ARGUMENT', message, 2); }
export const localPath = (path: string) => resolve(path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface PageOptions { cursor?: string; limit?: number }
export function pageLimit(value = 50) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) invalid('Limit must be an integer from 1 to 200.');
  return value;
}
export function pageOffset(cursor: string | undefined, key: string) {
  if (!cursor) return 0;
  let parsed: { key: string; offset: number };
  try {
    if (cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error();
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!parsed || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || typeof parsed.key !== 'string') throw new Error();
  } catch { return invalid('Invalid cursor. Use nextCursor from the previous response.'); }
  if (parsed.key !== key) throw new LibraryError('STALE_CURSOR', 'Saved history or query changed. Restart without --cursor.');
  return parsed.offset;
}
export const nextCursor = (key: string, offset: number) => Buffer.from(JSON.stringify({ key, offset })).toString('base64url');
export function page<T>(items: T[], key: string, options: PageOptions = {}) {
  const limit = pageLimit(options.limit), offset = pageOffset(options.cursor, key);
  return { items: items.slice(offset, offset + limit), total: items.length, nextCursor: offset + limit < items.length ? nextCursor(key, offset + limit) : null };
}

export interface SessionFilters {
  sources?: string[]; directory?: string; project?: string; model?: string;
  since?: number; until?: number; archived?: 'include' | 'exclude' | 'only'; raw?: boolean;
}
export function filterSessions(sessions: Session[], filters: SessionFilters = {}) {
  return sessions.filter(session => {
    if (filters.sources?.length && !filters.sources.some(source => sessionMatchesSource(session, source))) return false;
    if (filters.directory) {
      if (!session.directory || !isAbsolute(session.directory)) return false;
      const path = relative(filters.directory, resolve(session.directory));
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
    }
    if (filters.project && session.projectID !== filters.project) return false;
    if (filters.model && session.model !== filters.model) return false;
    if (filters.archived === 'exclude' && session.archived || filters.archived === 'only' && !session.archived) return false;
    const end = sessionEnd(session);
    return !(filters.since !== undefined && end < filters.since || filters.until !== undefined && session.created > filters.until);
  }).sort((a, b) => sessionEnd(b) - sessionEnd(a) || a.id.localeCompare(b.id));
}

/** CLI windows select overlapping sessions; usage totals remain lifetime totals. */
export function parseDate(value: string, now: number, endOfDay = false) {
  const ago = /^(\d+)([mhdw])$/.exec(value);
  if (ago) {
    const result = now - Number(ago[1]) * ({ m: 60_000, h: 3600_000, d: 86400_000, w: 604800_000 }[ago[2]]!);
    if (!Number.isFinite(result) || result < 0) invalid('Relative date is out of range.');
    return result;
  }
  if (value === 'today' || value === 'yesterday') {
    const date = new Date(now); date.setUTCHours(0, 0, 0, 0);
    return date.getTime() - (value === 'yesterday' ? 86400_000 : 0) + (endOfDay ? 86400_000 - 1 : 0);
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const time = Date.parse(dateOnly ? `${value}T00:00:00Z` : value);
  const calendar = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(time) || !Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== value.slice(0, 10) || !dateOnly && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid('Use YYYY-MM-DD (UTC), an ISO timestamp with timezone, today, yesterday, or a duration such as 7d.');
  return time + (dateOnly && endOfDay ? 86400_000 - 1 : 0);
}
