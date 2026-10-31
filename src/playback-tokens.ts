import type { Session } from './types';

export const validTokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function sumRecordedTokens(values: unknown[]): number | null {
  if (!values.length || !values.every(validTokenCount)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return validTokenCount(total) ? total : null;
}

/** Session totals are recorded at the saved endpoint, never interpolated across a trail. */
export function playbackTokens(sessions: Session[]) {
  const recorded = sessions.filter((session) => ['opencode', 'continue'].includes(session.source || 'opencode') && validTokenCount(session.tokens));
  const timed = recorded.filter((session) => Number.isFinite(session.activity?.lastMessageAt) && session.activity!.lastMessageAt! > 0)
    .sort((a, b) => Math.max(a.created, a.activity!.lastMessageAt!) - Math.max(b.created, b.activity!.lastMessageAt!));
  const times: number[] = [], totals = [0];
  for (const session of timed) {
    times.push(Math.max(session.created, session.activity!.lastMessageAt!));
    totals.push(totals.at(-1)! + session.tokens!);
  }
  const allTokens = recorded.reduce((total, session) => total + session.tokens!, 0);
  return {
    recorded: recorded.length,
    missing: sessions.length - recorded.length,
    untimed: recorded.length - timed.length,
    at(time: number, complete = false) {
      if (complete) return { tokens: allTokens, sessions: recorded.length };
      let low = 0, high = times.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (times[mid] <= time) low = mid + 1; else high = mid;
      }
      return { tokens: totals[low], sessions: low };
    },
  };
}
