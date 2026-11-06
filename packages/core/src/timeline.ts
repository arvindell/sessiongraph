/** Harness-neutral event envelope. Unknown native event types use kind=event
 * and retain nativeType. IDs/relationships are scoped to one saved session. */
export type TimelineKind = 'message' | 'tool_call' | 'tool_result' | 'reasoning' | 'compaction' | 'file_change' | 'error' | 'event';
export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  role?: 'user' | 'assistant' | 'tool' | 'system';
  name: string;
  time: number | null;
  timeSource: 'recorded' | 'message' | 'unknown';
  endTime?: number | null;
  nativeID?: string;
  nativeType?: string;
  callID?: string;
  parentID?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'unknown';
  text: string;
  input?: string;
  output?: string;
  partial?: boolean;
}
export interface TimelineItem extends TimelineEvent { sessionID: string; messageID: string; ordinal: number }
export type TimelineSummary = Pick<TimelineItem, 'id' | 'kind' | 'role' | 'name' | 'time' | 'timeSource' | 'ordinal' | 'status' | 'partial'> & { preview: string };
export interface TimelinePage {
  sessionID: string;
  revision: string;
  items: TimelineSummary[];
  total: number;
  offset: number;
  nextCursor: string | null;
  previousCursor: string | null;
  selected?: TimelineItem;
  related: TimelineSummary[];
  relatedPartial: boolean;
  previousItem?: string;
  nextItem?: string;
  partial: boolean;
  note?: string;
}
export type TimelineFilter = 'all' | 'messages' | 'tools' | 'events' | 'untimed';
export const isConversationMessage = (item: Pick<TimelineEvent, 'kind' | 'role'>) => item.kind === 'message' && (item.role === 'user' || item.role === 'assistant');
export interface TimelineMarkers {
  sessionID: string;
  revision: string;
  items: TimelineSummary[];
  total: number;
  untimed: number;
  outsideLifetime: number;
  limited: boolean;
  partial: boolean;
  note?: string;
}
export const timelineColor = (item: Pick<TimelineEvent, 'kind' | 'role'>) => item.kind === 'message' ? item.role === 'user' ? '#b0e9d6' : '#9bbcff' : item.kind.startsWith('tool_') ? '#eac594' : '#d7a1f1';
export const timelineLabel = (item: Pick<TimelineEvent, 'kind' | 'role'>) => item.kind === 'message' ? item.role === 'user' ? 'You' : item.role === 'assistant' ? 'Assistant' : 'Message' : ({ tool_call: 'Tool call', tool_result: 'Tool result', reasoning: 'Reasoning', compaction: 'Compaction', file_change: 'File change', error: 'Error', event: 'Event' })[item.kind];
