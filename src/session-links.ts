import type { Session } from './types';

/** An app thread owns its explicitly bound provider conversation in the map. */
export function visibleSessions(sessions: Session[]): Session[] {
  const owners = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.source !== 't3-code' || session.coverage?.history !== 'complete' || !session.activity?.userMessages) continue;
    for (const id of session.linkedSessionIDs || []) owners.set(id, [...(owners.get(id) || []), session.id]);
  }
  const unique = new Map([...owners].flatMap(([native, ids]) => ids.length === 1 ? [[native, ids[0]] as const] : []));
  return sessions.filter((session) => !unique.has(session.id)).map((session) => ({
    ...session,
    parentID: session.parentID ? unique.get(session.parentID) || session.parentID : undefined,
    forkID: session.forkID ? unique.get(session.forkID) || session.forkID : undefined,
  }));
}

export function sessionMatchesSource(session: Session, source: string): boolean {
  return !source || session.source === source || Boolean(session.source === 't3-code' && session.linkedSessionIDs?.some((id) => id.startsWith(`${source}:`)));
}
