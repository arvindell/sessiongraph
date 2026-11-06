import type { Session } from '@sessiongraph/core/types';

/** One map entry per unambiguous app/provider binding; saved histories stay separate. */
export function visibleSessions(sessions: Session[]): Session[] {
  const owners = new Map<string, Session[]>();
  for (const session of sessions) {
    if (session.source !== 't3-code') continue;
    // Count every claimant, including empty/pending ones, before deciding ownership.
    for (const id of new Set(session.linkedSessionIDs || [])) owners.set(id, [...(owners.get(id) || []), session]);
  }
  const unique = new Map([...owners].flatMap(([native, claims]) => {
    const owner = claims[0];
    return claims.length === 1 && ['complete', 'partial'].includes(owner.coverage?.history || '') && owner.activity?.userMessages
      ? [[native, owner.id] as const] : [];
  }));
  return sessions.filter((session) => !unique.has(session.id)).map((session) => ({
    ...session,
    parentID: session.parentID ? unique.get(session.parentID) || session.parentID : undefined,
    forkID: session.forkID ? unique.get(session.forkID) || session.forkID : undefined,
  }));
}

export function sessionMatchesSource(session: Session, source: string): boolean {
  return !source || session.source === source || Boolean(session.source === 't3-code' && session.linkedSessionIDs?.some((id) => id.startsWith(`${source}:`)));
}
