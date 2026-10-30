import { eventFor, eventText, messageEvent } from '../events';
import { messageTime } from '../activity';
import type { ImportedMessage } from './types';
import type { TimelineEvent } from '../../src/timeline';

/** OpenCode V2 events, obtained only through its authenticated read API. */
export function opencodeEvents(raw: any, message: ImportedMessage): TimelineEvent[] {
  const fields = { nativeID: message.id, nativeType: String(raw.type), timeSource: message.time ? 'recorded' as const : 'unknown' as const };
  if (raw.type === 'user') return [messageEvent(message, typeof raw.text === 'string' ? raw.text : ''), ...(raw.files?.length ? [eventFor(message, 'attachments', 'event', 'Attachments', 'Non-text attachments are not included.', { partial: true })] : [])];
  if (raw.type !== 'assistant') {
    const status = ['pending', 'running', 'completed', 'failed'].includes(raw.status) ? raw.status : 'unknown';
    const known = ['compaction', 'system', 'synthetic', 'shell', 'model-switched', 'agent-switched', 'location-switched', 'skill', 'idle'].includes(raw.type);
    return [eventFor(message, 'event', raw.type === 'compaction' ? 'compaction' : 'event', raw.description || raw.type, eventText(raw.summary ?? raw.text ?? raw.error ?? (raw.type === 'shell' ? raw.command : raw)), { ...fields, role: 'system', status, output: raw.type === 'shell' ? eventText(raw.output?.output) : undefined, partial: !known || Boolean(raw.output?.truncated) })];
  }
  const events: TimelineEvent[] = [];
  for (const [i, part] of (Array.isArray(raw.content) ? raw.content.slice(0, 200) : []).entries()) {
    const id = `${part.type}:${part.id || i}`, native = { nativeID: part.id, nativeType: String(part.type) };
    const time = messageTime(part.time?.created);
    const timing = time ? { time, timeSource: 'recorded' as const } : {};
    if (part.type === 'text') events.push(eventFor(message, id, 'message', 'Assistant message', part.text || '', { ...native, ...timing }));
    else if (part.type === 'reasoning') events.push(eventFor(message, id, 'reasoning', 'Recorded reasoning', part.text || '', { ...native, ...timing }));
    else if (part.type === 'tool') {
      const state = part.state || {}, endTime = messageTime(part.time?.completed);
      const status = state.status === 'error' ? 'failed' : state.status === 'streaming' ? 'pending' : ['running', 'completed'].includes(state.status) ? state.status : 'unknown';
      const common = { ...native, callID: part.id, status, endTime };
      events.push(eventFor(message, `${id}:call`, 'tool_call', part.name || 'Tool call', '', { ...common, ...timing, input: eventText(state.input) }));
      if (['completed', 'error'].includes(state.status)) events.push(eventFor(message, `${id}:result`, 'tool_result', part.name || 'Tool result', '', { ...common, role: 'tool', ...(endTime ? { time: endTime, timeSource: 'recorded' as const } : {}), output: eventText(state.error ?? state.content, 64_000) }));
    } else events.push(eventFor(message, id, 'event', `${part.type || 'Unknown'} content`, 'Unsupported content.', { ...native, ...timing, partial: true }));
  }
  if (raw.error) events.push(eventFor(message, 'error', 'error', 'Assistant error', eventText(raw.error), { status: 'failed' }));
  if (!events.length) events.push(eventFor(message, 'empty', 'message', 'Assistant message', '', { ...fields, partial: true }));
  if (raw.content?.length > 200) events[0].partial = true;
  return events;
}
