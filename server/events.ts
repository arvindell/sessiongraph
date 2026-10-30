import { digest } from './adapters/common';
import { messageTime } from './activity';
import type { ImportedMessage } from './adapters/types';
import type { TimelineEvent, TimelineItem } from '../src/timeline';

/** Keep JSON readable while bounding payloads and excluding binary/credential fields. */
export function eventText(value: unknown, limit = 32_000): string {
  const bounded = (text: string) => text.length > limit ? `${text.slice(0, limit - 16)}\n[shortened]` : text;
  if (typeof value === 'string') return bounded(value);
  let remaining = limit, visited = 0;
  const clean = (v: unknown, depth = 0): unknown => {
    if (++visited > 1000 || depth > 6 || remaining <= 0) return '[omitted]';
    if (typeof v === 'string') { const text = v.slice(0, Math.max(0, remaining)); remaining -= text.length; return text.length < v.length ? `${text}[shortened]` : text; }
    if (Array.isArray(v)) return [...v.slice(0, 100).map((x) => clean(x, depth + 1)), ...(v.length > 100 ? ['[omitted]'] : [])];
    if (v && typeof v === 'object') return Object.fromEntries([...Object.entries(v).slice(0, 100).map(([key, x]) => [key, /base64|image|binary|credential|secret|password|authorization|api.?key/i.test(key) ? '[omitted]' : clean(x, depth + 1)]), ...(Object.keys(v).length > 100 ? [['…', '[omitted]']] : [])]);
    return v;
  };
  try { return bounded(JSON.stringify(clean(value), null, 2) || ''); } catch { return '[unavailable]'; }
}
export function eventFor(message: ImportedMessage, id: string, kind: TimelineEvent['kind'], name: string, text = '', fields: Partial<TimelineEvent> = {}): TimelineEvent {
  const time = messageTime(message.time);
  const event = { id, kind, name, role: message.role, time, timeSource: time ? 'message' as const : 'unknown' as const, text: eventText(text, 64_000), ...fields };
  event.partial ||= [event.text, event.input, event.output].some((value) => /\[(shortened|omitted|unavailable)\]/.test(value || '')) || text.length > 64_000;
  return event;
}
export function messageEvent(message: ImportedMessage, text: string, id = 'message'): TimelineEvent {
  return eventFor(message, id, 'message', message.role === 'user' ? 'User message' : message.role === 'assistant' ? 'Assistant message' : `${message.role} message`, text,
    { nativeID: message.id, timeSource: messageTime(message.time) ? 'recorded' : 'unknown', partial: message.partial });
}

/** Bound structured payloads before they enter the saved message snapshot too. */
export function boundEventPayloads(message: ImportedMessage, budget: number): number {
  if (!message.events) return 0;
  let remaining = Math.min(budget, 128_000);
  const start = remaining;
  if (message.events.length > 200) message.partial = true;
  message.events = message.events.slice(0, 200).flatMap((event) => {
    if (remaining <= 0) { message.partial = true; return []; }
    const bounded = { ...event };
    for (const key of ['text', 'input', 'output', 'name', 'id', 'nativeID', 'nativeType', 'callID', 'parentID'] as const) {
      if (bounded[key] === undefined) continue;
      const value = String(bounded[key]), size = key === 'text' || key === 'output' ? 64_000 : key === 'input' ? 32_000 : 512;
      bounded[key] = value.slice(0, Math.max(0, Math.min(remaining, size)));
      remaining -= bounded[key]!.length;
      if (bounded[key]!.length < value.length) { bounded.partial = true; message.partial = true; }
    }
    return [bounded];
  });
  return start - remaining;
}

/** Standard conversation blocks shared by Claude, Cursor, and similar harnesses. */
export function blockEvents(message: ImportedMessage, content: unknown, transform: (value: string) => string = (v) => v): TimelineEvent[] {
  if (typeof content === 'string') return [messageEvent(message, transform(content))];
  if (!Array.isArray(content)) return [];
  return content.slice(0, 200).flatMap((part, i): TimelineEvent[] => {
    if (!part || typeof part !== 'object') return [eventFor(message, `unknown:${i}`, 'event', 'Unsupported content', '', { partial: true })];
    const nativeID = typeof part.id === 'string' ? part.id : undefined, id = `${part.type || 'part'}:${nativeID || i}`;
    const fields = { nativeID, nativeType: String(part.type || 'unknown'), partial: content.length > 200 };
    if (['text', 'input_text', 'output_text'].includes(part.type)) { const event = messageEvent(message, transform(typeof part.text === 'string' ? part.text : ''), id); return [{ ...event, ...fields, partial: Boolean(event.partial || fields.partial) }]; }
    if (['tool_use', 'tool-call', 'tool_call'].includes(part.type)) return [eventFor(message, id, 'tool_call', part.name || part.toolName || 'Tool call', '', { ...fields, callID: part.id || part.toolCallId, input: eventText(part.input ?? part.args ?? part.arguments), status: 'unknown' })];
    if (['tool_result', 'tool-result'].includes(part.type)) return [eventFor(message, id, 'tool_result', part.name || part.toolName || 'Tool result', '', { ...fields, role: 'tool', callID: part.tool_use_id || part.toolCallId || part.tool_call_id, output: eventText(part.content ?? part.result ?? part.output), status: part.is_error === true || part.isError === true || part.error != null ? 'failed' : 'completed' })];
    if (['thinking', 'reasoning'].includes(part.type)) return [eventFor(message, id, 'reasoning', 'Recorded reasoning', eventText(part.thinking ?? part.text), fields)];
    return [eventFor(message, id, 'event', `${part.type || 'Unknown'} content`, 'This content type is not represented as text.', { ...fields, partial: true })];
  });
}

export function normalizedEvents(message: ImportedMessage, sessionID: string): Omit<TimelineItem, 'ordinal'>[] {
  let events = message.events;
  if (!events) {
    events = [];
    const speech = message.fragments.filter((f) => f.kind === 'You' || f.kind === 'Assistant').map((f) => f.text).join('\n\n');
    if (speech) events.push(messageEvent(message, speech));
    if (message.tools.length || message.fragments.some((f) => f.kind === 'Tool')) events.push(eventFor(message, 'legacy-tools', 'event', message.tools.length ? `Tool activity · ${message.tools.join(', ')}` : 'Recorded tool activity', message.fragments.filter((f) => f.kind === 'Tool').map((f) => f.text).join('\n\n'), { role: 'tool', partial: true, nativeType: 'legacy-tool-activity' }));
    if (!events.length && !message.files.length) events.push(eventFor(message, 'empty', message.role === 'user' || message.role === 'assistant' ? 'message' : 'event', `${message.role} record`, '', { partial: true }));
  }
  // File evidence is kept independently from requested tool calls.
  const files = message.files.map((file, i) => eventFor(message, `file:${i}`, 'file_change', file.path, `${file.source} · ${file.steps} recorded step(s)`, { nativeType: file.source }));
  return [...events, ...files].slice(0, 200).map((event) => {
    const text = String(event.text || '').slice(0, 64_000), input = event.input?.slice(0, 32_000), output = event.output?.slice(0, 64_000);
    const time = messageTime(event.time || 0);
    return { ...event, id: digest([message.id, event.id]), sessionID, messageID: message.id, name: String(event.name || event.kind).slice(0, 300),
      nativeID: event.nativeID ? String(event.nativeID).slice(0, 512) : undefined, nativeType: event.nativeType?.slice(0, 160), callID: event.callID ? String(event.callID).slice(0, 512) : undefined, parentID: event.parentID ? String(event.parentID).slice(0, 512) : undefined,
      endTime: messageTime(event.endTime || 0),
      time, timeSource: time ? event.timeSource : 'unknown', text, input, output,
      partial: Boolean(event.partial || message.partial || text.length < (event.text?.length || 0) || input?.length !== event.input?.length || output?.length !== event.output?.length || events.length + files.length > 200) };
  });
}
