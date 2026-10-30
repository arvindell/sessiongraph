import type { ImportedMessage } from './adapters/types';

export const messageTime = (time: number) => Number.isFinite(time) && time > 0 && time <= 8.64e15 ? time : null;
// Claude's tool-result envelopes also have role=user; only human-text fragments
// count as user turns. Keep simultaneous messages separate by native identity.
export const isUserMessage = (message: ImportedMessage) => message.role === 'user' && message.fragments.some((f) => f.kind === 'You' && f.text.trim());

export const activitySQL = `SELECT min(time) AS firstMessageAt, max(time) AS lastMessageAt,
  coalesce(sum(is_user), 0) AS userMessages,
  coalesce(sum(CASE WHEN is_user=1 AND time IS NULL THEN 1 ELSE 0 END), 0) AS untimedUserMessages
  FROM messages WHERE session_id=?`;
