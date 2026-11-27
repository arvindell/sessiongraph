import { z } from 'zod';
import type { LibraryService } from './library-service';
import { EventReadError } from './event-store';
import { invalid, LibraryError, localPath } from './library-query';

const text = z.string().min(1).max(4096);
const id = { id: text.describe('Full session ID from list_sessions or search_sessions.') };
const cursor = { cursor: text.optional().describe('nextCursor from the previous page.') };
const page = { ...cursor, limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50).') };
const filters = {
  source: text.optional(), directory: text.optional(), project: text.optional(), model: text.optional(),
  archived: z.enum(['include', 'exclude', 'only']).optional(),
  since: z.number().int().nonnegative().optional().describe('Window start in Unix milliseconds.'),
  until: z.number().int().nonnegative().optional().describe('Inclusive window end in Unix milliseconds.'),
};
function selection(v: z.infer<z.ZodObject<typeof filters>>) {
  if (v.since !== undefined && v.until !== undefined && v.since > v.until) invalid('since must not be later than until.');
  return { sources: v.source ? [v.source] : undefined, directory: v.directory && localPath(v.directory),
    project: v.project, model: v.model, archived: v.archived, since: v.since, until: v.until };
}

function query<S extends z.ZodRawShape>(name: string, path: string, description: string, fields: S,
  run: (library: LibraryService, input: z.infer<z.ZodObject<S>>) => object) {
  const schema = z.strictObject(fields);
  return { name, path, description, inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
    call(library: LibraryService, input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error.issues.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
      return run(library, parsed.data);
    } };
}

// Explicit allowlist, shared by HTTP discovery, validation and MCP tools.
export const agentQueries = [
  query('list_sessions', '/v1/sessions', 'List sessions by most recent activity.', { ...filters, ...page }, (s, v) => s.listSessions(selection(v), v)),
  query('search_sessions', '/v1/search', 'Search saved titles, messages, tools, and files. Returns ranked excerpts and coverage.', {
    query: z.string().min(1).max(300), ...filters, ...page,
  }, (s, v) => s.searchSessions(v.query, selection(v), v)),
  query('get_session', '/v1/sessions/{id}', 'Get session metadata, usage, and history coverage.', id, (s, v) => s.getSession(v.id)),
  query('list_messages', '/v1/sessions/{id}/messages', 'Read saved messages, newest first.', { ...id, ...page }, (s, v) => s.getMessages(v.id, v)),
  query('list_events', '/v1/sessions/{id}/events', 'Inspect saved events and tool results. Pass item to read an event.', {
    ...id, ...cursor, filter: z.enum(['all','messages','tools','events','untimed']).optional(), item: text.optional(), revision: text.optional(),
  }, (s, v) => s.getEvents(v.id, v)),
  query('list_commits', '/v1/sessions/{id}/commits', 'Read recorded commits and their evidence IDs.', { ...id, ...page }, (s, v) => s.getCommits(v.id, v)),
  query('list_files', '/v1/sessions/{id}/files', 'Read file-change evidence and tool counts.', { ...id, ...cursor }, (s, v) => s.getFileChanges(v.id, v.cursor)),
  query('list_relationships', '/v1/sessions/{id}/relationships', 'Find recorded parents, children, forks, and provider links.', { ...id, ...page }, (s, v) => s.getRelationships(v.id, v)),
  query('get_timeline', '/v1/sessions/{id}/timeline', 'Read recorded user-message times.', id, (s, v) => s.getTimeline(v.id)),
  query('get_stats', '/v1/stats', 'Summarize matched sessions and recorded lifetime usage.', { ...filters, ...page,
    groupBy: z.enum(['source','model','project','directory']).optional() }, (s, v) => s.getStats(selection(v), v.groupBy, v)),
];

export function queryError(error: unknown) {
  if (error instanceof LibraryError) {
    return { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'STALE_CURSOR' ? 409 : 400, code: error.code, message: error.message };
  }
  if (error instanceof EventReadError) return { status: error.status, code: error.status === 409 ? 'STALE_CURSOR' : error.status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT', message: error.message };
  return { status: 500, code: 'QUERY_FAILED', message: 'Could not read the session library.' };
}
