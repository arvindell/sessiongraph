import type { DatabaseSync } from 'node:sqlite';
import type { Session } from '@sessiongraph/core/types';
import type { TimelineItem, TimelineSummary } from '@sessiongraph/core/timeline';
import type { CommitIndex, SessionCommit, SessionCommits } from '@sessiongraph/core/commits';
import { abbreviatedSHA } from '@sessiongraph/core/commits';
import { COMMIT_EXTRACTOR_VERSION, extractCommit } from './commit-extraction';
import { fingerprint, nextCursor, pageLimit, pageOffset, type PageOptions } from './library-query';

export const COMMIT_SCHEMA = `CREATE TABLE IF NOT EXISTS session_commits (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sha TEXT NOT NULL, repository_path TEXT NOT NULL, operation TEXT NOT NULL,
  occurred_at REAL, evidence_event_id TEXT NOT NULL,
  PRIMARY KEY(session_id,repository_path,sha,operation),
  FOREIGN KEY(session_id,evidence_event_id) REFERENCES timeline_items(session_id,id) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS session_commits_time ON session_commits(session_id,occurred_at);`;
const supported = new Set(['opencode', 't3-code', 'codex', 'claude-code']);
export const pendingCommits = (): CommitIndex => ({ version: 0, state: 'pending', count: null, note: 'Refresh sources to index recorded commit operations.' });

/** Called inside the snapshot replacement transaction, after bounded events have
 * been saved. Evidence can never point at a payload discarded by import limits. */
export function writeCommits(db: DatabaseSync, session: Session): CommitIndex {
  db.prepare('DELETE FROM session_commits WHERE session_id=?').run(session.id);
  const base = { version: COMMIT_EXTRACTOR_VERSION, indexedAt: Date.now() };
  if (!supported.has(session.source || '')) return { ...base, state: 'unavailable', count: null, note: 'Commit history unavailable for this source.' };
  const calls = new Map<string, TimelineItem | null>();
  const results = new Map<string, string | null>();
  const rows = () => db.prepare("SELECT data FROM timeline_items WHERE session_id=? AND kind IN ('tool_call','tool_result') ORDER BY ordinal").iterate(session.id);
  let tools = 0, partial = session.coverage?.history !== 'complete' || Boolean(db.prepare('SELECT partial FROM timeline_coverage WHERE session_id=?').get(session.id)?.partial);
  for (const row of rows()) {
    const item = JSON.parse(String(row.data)) as TimelineItem; tools++;
    if (item.kind === 'tool_result' && item.callID) {
      const signature = fingerprint([item.output, item.exitCode, item.status, item.gitCommit]);
      results.set(item.callID, results.has(item.callID) && results.get(item.callID) !== signature ? null : signature);
    }
    if (item.kind !== 'tool_call' || !item.callID) continue;
    // Reused call IDs are ambiguous even if their text happens to match.
    calls.set(item.callID, calls.has(item.callID) ? null : item);
  }
  const completed = new Set<string>();
  const insert = db.prepare('INSERT OR IGNORE INTO session_commits VALUES (?,?,?,?,?,?)');
  for (const row of rows()) {
    const item = JSON.parse(String(row.data)) as TimelineItem;
    if (item.kind !== 'tool_result') continue;
    const call = item.input ? item : item.callID ? calls.get(item.callID) : undefined;
    if (!call || call !== item && call.ordinal >= item.ordinal || item.callID && results.get(item.callID) === null) { partial = true; continue; }
    if (item.callID) completed.add(item.callID);
    const extracted = extractCommit(call, item);
    if (!extracted.candidate) continue;
    const time = item.endTime ?? item.time;
    // Forks can contain copied ancestors. Unknown ownership/time must not turn
    // copied executions into newly attributed child actions.
    if (time !== null && time < session.created || session.forkID && (time === null || time <= session.created || call.time === null || call.time < session.created)) { partial = true; continue; }
    if (!extracted.commit) { partial = true; continue; }
    const { sha, repositoryPath, operation } = extracted.commit;
    insert.run(session.id, sha, repositoryPath, operation, time, item.id);
  }
  for (const [id, call] of calls) if (call && !completed.has(id) && /\bgit\b[\s\S]*\b(?:commit|cherry-pick)\b/.test(call.input || '')) partial = true;
  const count = Number(db.prepare('SELECT count(*) AS n FROM session_commits WHERE session_id=?').get(session.id)!.n);
  return { ...base, state: !tools ? 'unavailable' : partial ? 'partial' : 'indexed', count: !tools ? null : count,
    note: !tools ? 'No tool executions recorded.' : partial ? 'Some commits may be missing.' : count ? 'Confirmed commits from saved tool results.' : 'No recorded commits found.' };
}
function commit(row: Record<string, unknown>): SessionCommit {
  return { sessionID: String(row.session_id), sha: String(row.sha), repositoryPath: String(row.repository_path), operation: row.operation as SessionCommit['operation'], occurredAt: row.occurred_at === null ? null : Number(row.occurred_at), evidenceEventID: String(row.evidence_event_id) };
}
export function readCommits(db: DatabaseSync, session: Session, options: PageOptions = {}): SessionCommits {
  let coverage = session.commits || pendingCommits();
  if (session.coverage?.note?.startsWith('Latest import failed:')) coverage = { ...coverage, state: coverage.count === null ? coverage.state : 'partial', note: `${session.coverage.note} ${coverage.note}` };
  const revision = String(db.prepare('SELECT revision FROM timeline_coverage WHERE session_id=?').get(session.id)?.revision || 'pending');
  const key = fingerprint(['commits', session.id, revision, coverage]), offset = pageOffset(options.cursor, key), limit = pageLimit(options.limit);
  const total = Number(db.prepare('SELECT count(*) AS n FROM session_commits WHERE session_id=?').get(session.id)!.n);
  const items = db.prepare('SELECT * FROM session_commits WHERE session_id=? ORDER BY occurred_at IS NULL,occurred_at,repository_path,sha,operation LIMIT ? OFFSET ?').all(session.id, limit, offset).map(commit);
  return { sessionID: session.id, revision, coverage, items, total, nextCursor: offset + limit < total ? nextCursor(key, offset + limit) : null };
}
export function commitMarkers(db: DatabaseSync, session: Session): TimelineSummary[] {
  const end = Math.max(session.created, session.activity?.lastMessageAt || session.created);
  return db.prepare('SELECT * FROM session_commits WHERE session_id=? AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at,sha LIMIT 2000').all(session.id, session.created, end).map((row, ordinal) => {
    const value = commit(row);
    return { id: value.evidenceEventID, kind: 'commit', name: `${value.operation} ${value.sha}`, time: value.occurredAt, timeSource: 'recorded', ordinal,
      preview: `${value.repositoryPath}\n${abbreviatedSHA(value.sha) ? 'Abbreviated SHA · ' : ''}Open recorded execution evidence` };
  });
}
