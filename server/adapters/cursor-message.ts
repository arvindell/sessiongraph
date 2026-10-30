import { addText, blankMessage, toolText } from './common';
import type { ImportedMessage } from './types';
import { blockEvents, eventFor, eventText } from '../events';

export function cursorTime(value: unknown): number {
  const time = typeof value === 'number' ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : 0;
  return Number.isFinite(time) && time > 0 && time <= 8.64e15 ? time : 0;
}

// Only Cursor's leading, timezone-qualified envelope is a timestamp. Dates
// mentioned in ordinary conversation and filesystem mtimes are not turn times.
export function cursorEnvelopeTime(text: string): number {
  const value = text.match(/^\s*<timestamp>([^<]+)<\/timestamp>/)?.[1];
  if (!value) return 0;
  const iso = cursorTime(value);
  if (iso) return iso;
  const match = value.match(/^(?:\w+, )?([A-Za-z]+ \d{1,2}, \d{4}), (\d{1,2}:\d{2}(?::\d{2})? [AP]M) \(UTC([+-])(\d{1,2})(?::(\d{2}))?\)$/);
  if (!match || Number(match[4]) > 14 || Number(match[5] || 0) > 59) return 0;
  return cursorTime(Date.parse(`${match[1]} ${match[2]} GMT${match[3]}${match[4].padStart(2, '0')}${match[5] || '00'}`));
}

export function cursorUserText(text: string): string {
  let value = text.trim().replace(/^<timestamp>[^<]+<\/timestamp>\s*/, '');
  for (;;) {
    const stripped = value.replace(/^<(user_info|environment_context|system_reminder)>[\s\S]*?<\/\1>\s*/, '');
    if (stripped === value) break;
    value = stripped;
  }
  // Wrappers mentioned inside an ordinary prompt are part of the prompt.
  const query = value.match(/^<user_query>([\s\S]*?)<\/user_query>(?:\s*<system_reminder>[\s\S]*?<\/system_reminder>)*\s*$/);
  return (query ? query[1] : value).trim();
}

/** The IDE uses message.content; Store leaves use content directly. */
export function cursorMessage(raw: any, fallbackID: string): ImportedMessage | undefined {
  if (!raw || typeof raw !== 'object') return;
  const body = raw.message && typeof raw.message === 'object' ? raw.message : raw;
  const role = raw.role || body.role;
  if (!['user', 'assistant', 'tool', 'system'].includes(role)) return;
  const content = body.content;
  const firstText = typeof content === 'string' ? content : Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : '';
  const time = cursorTime(raw.timestamp) || cursorTime(body.timestamp) || cursorTime(body.createdAt) || (role === 'user' && typeof firstText === 'string' ? cursorEnvelopeTime(firstText) : 0);
  const native = [raw.uuid, raw.id, body.uuid, body.id].find((id) => typeof id === 'string' && id.length && id.length <= 512);
  const msg = blankMessage(native || fallbackID, time, role);
  msg.events = role === 'tool' ? [eventFor(msg, 'result', 'tool_result', body.name || 'Tool result', '', { callID: body.tool_call_id, output: eventText(content, 64_000), status: 'unknown' })] : blockEvents(msg, content);
  const kind = role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'Tool';
  const text = (value: unknown) => addText(msg, role === 'user' && typeof value === 'string' ? cursorUserText(value) : value, kind);
  if (typeof content === 'string') text(content);
  else if (Array.isArray(content)) for (const part of content) {
    if (!part || typeof part !== 'object') { msg.partial = true; continue; }
    if (['text', 'input_text', 'output_text'].includes(part.type)) text(part.text);
    else if (['tool_use', 'tool-call', 'tool_call'].includes(part.type)) {
      const name = part.name || part.toolName;
      if (typeof name === 'string') { msg.tools.push(name); addText(msg, name, 'Tool'); }
      toolText(msg, part.input ?? part.args ?? part.arguments);
    } else if (['tool_result', 'tool-result'].includes(part.type)) toolText(msg, part.content ?? part.result ?? part.output);
    else { msg.partial = true; } // Images/opaque reasoning are not text history.
  } else if (content != null) msg.partial = true;
  if (Array.isArray(body.tool_calls)) for (const call of body.tool_calls) {
    if (typeof call?.function?.name !== 'string') { msg.partial = true; continue; }
    msg.tools.push(call.function.name); addText(msg, call.function.name, 'Tool'); toolText(msg, call.function.arguments);
    msg.events.push(eventFor(msg, `call:${call.id || msg.events.length}`, 'tool_call', call.function.name, '', { nativeID: call.id, callID: call.id, input: eventText(call.function.arguments), status: 'unknown' }));
  }
  // A requested edit does not prove a successful file change. Cursor's exported
  // transcripts often omit results, so no file-change evidence is fabricated.
  if (!msg.events.length) msg.events.push(eventFor(msg, 'event', 'event', 'Unrepresented message', '', { partial: true }));
  return msg;
}
