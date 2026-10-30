import type { DatabaseSync } from 'node:sqlite';
import type { ImportedMessage } from './adapters/types';
import type { TimelineItem, TimelineSummary } from '../src/timeline';
import { normalizedEvents } from './events';
import { randomUUID } from 'node:crypto';
import type { TimelineFilter, TimelineMarkers, TimelinePage } from '../src/timeline';
import type { Session } from '../src/types';

export const EVENT_SCHEMA = `CREATE TABLE IF NOT EXISTS timeline_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, kind TEXT NOT NULL, role TEXT, time REAL, call_id TEXT, name TEXT NOT NULL, preview TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(session_id,id));
  CREATE INDEX IF NOT EXISTS timeline_order ON timeline_items(session_id,ordinal);
  CREATE INDEX IF NOT EXISTS timeline_time ON timeline_items(session_id,time);
  CREATE INDEX IF NOT EXISTS timeline_calls ON timeline_items(session_id,call_id);
  CREATE TABLE IF NOT EXISTS timeline_coverage (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, partial INTEGER NOT NULL, note TEXT, revision TEXT NOT NULL);`;

export function writeEvents(db: DatabaseSync, id: string, rows: Iterable<Record<string, unknown>>) {
  db.prepare('DELETE FROM timeline_items WHERE session_id=?').run(id);
  const insert = db.prepare('INSERT OR IGNORE INTO timeline_items VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  let ordinal = 0, bytes = 0, partial = false, legacy = false, limited = false;
  for (const row of rows) {
    const message = JSON.parse(String(row.data)) as ImportedMessage;
    legacy ||= !message.events;
    for (const event of normalizedEvents(message, id)) {
      const item: TimelineItem = { ...event, ordinal: ordinal++ }, data = JSON.stringify(item);
      bytes += Buffer.byteLength(data);
      if (ordinal > 200_000 || bytes > 32_000_000) { limited = true; break; }
      partial ||= Boolean(item.partial);
      const preview = (item.text || item.input || item.output || item.name).replace(/\s+/g, ' ').slice(0, 180);
      insert.run(id, item.id, item.messageID, item.ordinal, item.kind, item.role || null, item.time, item.callID || null, item.name, preview, data);
    }
    if (limited) break;
  }
  const note = [legacy ? 'Some items were reconstructed from an older flattened import; tool inputs/results cannot be paired there. Refresh sources to import structured events.' : '', limited ? 'Event history limited to 200,000 items / 32 MB per session.' : '', partial ? 'Some event content is missing, unsupported, or shortened.' : ''].filter(Boolean).join(' ');
  db.prepare('INSERT OR REPLACE INTO timeline_coverage VALUES (?,?,?,?)').run(id, Number(partial || legacy || limited), note || null, randomUUID());
}

export const summaryColumns = "id,kind,role,name,time,ordinal,preview,json_extract(data,'$.timeSource') AS timeSource,json_extract(data,'$.status') AS status,json_extract(data,'$.partial') AS partial";
export function eventSummary(row: Record<string, unknown>): TimelineSummary {
  return { id: String(row.id), kind: row.kind as TimelineSummary['kind'], role: row.role as TimelineSummary['role'], name: String(row.name), time: row.time === null ? null : Number(row.time), timeSource: row.timeSource as TimelineSummary['timeSource'], ordinal: Number(row.ordinal), preview: String(row.preview), status: row.status as TimelineSummary['status'], partial: Boolean(row.partial) };
}

export class EventReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const filters: Record<TimelineFilter, string> = { all: '1', messages: "kind='message'", tools: "kind IN ('tool_call','tool_result')", events: "kind NOT IN ('message','tool_call','tool_result')", untimed: 'time IS NULL' };
function coverage(db: DatabaseSync, session: Session) {
  const row = db.prepare('SELECT * FROM timeline_coverage WHERE session_id=?').get(session.id);
  return { revision: String(row?.revision || 'pending'), partial: Boolean(row?.partial) || session.coverage?.history !== 'complete', note: [row?.note, session.coverage?.note].filter(Boolean).join(' ') || undefined };
}
export function readEventMarkers(db: DatabaseSync, session: Session): TimelineMarkers {
  const end = Math.max(session.created, session.activity?.lastMessageAt || session.created);
  const totals = db.prepare('SELECT count(*) AS total, count(*) FILTER (WHERE time IS NULL) AS untimed, count(*) FILTER (WHERE time<? OR time>?) AS outside FROM timeline_items WHERE session_id=?').get(session.created, end, session.id)!;
  const rows = db.prepare(`SELECT ${summaryColumns} FROM timeline_items WHERE session_id=? AND time>=? AND time<=? ORDER BY time DESC,ordinal DESC LIMIT 2000`).all(session.id, session.created, end);
  return { sessionID: session.id, ...coverage(db, session), items: rows.reverse().map(eventSummary), total: Number(totals.total), untimed: Number(totals.untimed), outsideLifetime: Number(totals.outside), limited: Number(totals.total) - Number(totals.untimed) - Number(totals.outside) > rows.length };
}
export function readEvents(db: DatabaseSync, session: Session, options: { cursor?: string; item?: string; filter?: string; revision?: string } = {}): TimelinePage {
  const state = coverage(db, session), filter = options.filter || 'all', size = 60;
  if (!Object.hasOwn(filters, filter)) throw new EventReadError('Invalid event filter.', 400);
  const where = filters[filter as TimelineFilter];
  if (options.revision && options.revision !== state.revision) throw new EventReadError('Saved history changed. Reload the event explorer.', 409);
  let offset = 0;
  if (options.cursor) {
    try {
      if (options.cursor.length > 512) throw new Error();
      const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 200_000 || cursor.filter !== filter || typeof cursor.revision !== 'string') throw new Error();
      if (cursor.revision !== state.revision) throw new EventReadError('Saved history changed. Reload the event explorer.', 409);
      offset = cursor.offset;
    } catch (error) { if (error instanceof EventReadError) throw error; throw new EventReadError('Invalid event cursor.', 400); }
  }
  let selected: TimelineItem | undefined;
  if (options.item) {
    const row = db.prepare(`SELECT data FROM timeline_items WHERE session_id=? AND id=? AND (${where})`).get(session.id, options.item);
    if (!row) throw new EventReadError('This event is not in the saved session or current filter.', 404);
    selected = JSON.parse(String(row.data));
    const before = Number(db.prepare(`SELECT count(*) AS n FROM timeline_items WHERE session_id=? AND ordinal<? AND (${where})`).get(session.id, selected!.ordinal)!.n);
    offset = Math.floor(before / size) * size;
  }
  const total = Number(db.prepare(`SELECT count(*) AS n FROM timeline_items WHERE session_id=? AND (${where})`).get(session.id)!.n);
  const items = db.prepare(`SELECT ${summaryColumns} FROM timeline_items WHERE session_id=? AND (${where}) ORDER BY ordinal LIMIT ? OFFSET ?`).all(session.id, size, offset).map(eventSummary);
  if (!selected && items.length) selected = JSON.parse(String(db.prepare('SELECT data FROM timeline_items WHERE session_id=? AND id=?').get(session.id, items[0].id)!.data));
  const related = selected?.callID ? db.prepare(`SELECT ${summaryColumns} FROM timeline_items WHERE session_id=? AND call_id=? AND id<>? ORDER BY ordinal LIMIT 21`).all(session.id, selected.callID, selected.id).map(eventSummary) : [];
  const previousItem = selected ? db.prepare(`SELECT id FROM timeline_items WHERE session_id=? AND ordinal<? AND (${where}) ORDER BY ordinal DESC LIMIT 1`).get(session.id, selected.ordinal)?.id : undefined;
  const nextItem = selected ? db.prepare(`SELECT id FROM timeline_items WHERE session_id=? AND ordinal>? AND (${where}) ORDER BY ordinal LIMIT 1`).get(session.id, selected.ordinal)?.id : undefined;
  const cursor = (position: number) => Buffer.from(JSON.stringify({ revision: state.revision, filter, offset: position })).toString('base64url');
  return { sessionID: session.id, ...state, items, total, offset, selected, related: related.slice(0, 20), relatedPartial: related.length > 20, previousItem: previousItem ? String(previousItem) : undefined, nextItem: nextItem ? String(nextItem) : undefined,
    nextCursor: offset + size < total ? cursor(offset + size) : null, previousCursor: offset > 0 ? cursor(Math.max(0, offset - size)) : null };
}
