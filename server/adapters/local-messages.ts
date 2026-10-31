import { addText, blankMessage, toolText } from './common';
import { blockEvents, eventFor, eventText } from '../events';
import { object, text, time, type Raw } from './local-files';
import type { ImportedMessage } from './types';

export function conversationMessage(raw: Raw, fallbackID: string): ImportedMessage {
  const role = raw.role === 'user' ? 'user' : ['assistant', 'model', 'thinking'].includes(raw.role) ? 'assistant' : ['tool', 'toolResult'].includes(raw.role) ? 'tool' : 'system';
  const message = blankMessage(text(raw.id) || fallbackID, time(raw.timestamp ?? raw.ts), role);
  let content = raw.content;
  if (Array.isArray(content)) content = content.map(part => {
    const p = object(part);
    return p.type === 'toolCall' ? { ...p, type: 'tool_use', input: p.arguments } : p.type === 'reasoning' ? { ...p, type: 'thinking', thinking: p.text } : p;
  });
  if (raw.role === 'thinking') content = [{ type: 'thinking', thinking: raw.content }];
  message.events = blockEvents(message, content);
  if (role === 'tool' && !(Array.isArray(content) && content.some(p => p.type === 'tool_result'))) {
    message.events = [eventFor(message, 'result', 'tool_result', text(raw.toolName) || 'Tool result', '', {
      callID: text(raw.toolCallId) || text(raw.tool_call_id) || undefined, output: eventText(content), status: raw.isError === true ? 'failed' : raw.isError === false ? 'completed' : 'unknown',
    })];
  }
  for (const event of message.events) {
    if (event.kind === 'message') addText(message, event.text, role === 'user' ? 'You' : role === 'assistant' ? 'Assistant' : 'Tool');
    else if (event.kind === 'tool_call') { message.tools.push(event.name); toolText(message, event.input); }
    else if (event.kind === 'tool_result') toolText(message, event.output);
    else if (event.kind === 'reasoning') addText(message, event.text, 'Assistant');
  }
  for (const call of Array.isArray(raw.toolCalls) ? raw.toolCalls : []) {
    const f = object(call.function);
    if (!text(f.name)) continue;
    message.tools.push(f.name);
    message.events.push(eventFor(message, `call:${text(call.id) || message.events.length}`, 'tool_call', f.name, '', { callID: text(call.id) || undefined, input: eventText(f.arguments), status: 'unknown' }));
    toolText(message, f.arguments);
  }
  if (message.events.length && message.events.every(e => e.kind === 'tool_result')) message.role = 'tool';
  message.partial ||= message.events.some(e => e.partial);
  return message;
}

/** Gemini/Qwen's recorded Google API parts, with explicit call/result identities. */
export function googleMessage(raw: Raw, fallbackID: string): ImportedMessage {
  const parts = Array.isArray(raw.content) ? raw.content : raw.content != null ? [raw.content] : [];
  const content = parts.map(part => {
    if (typeof part === 'string') return { type: 'text', text: part };
    const p = object(part);
    if (typeof p.text === 'string') return p.thought ? { type: 'thinking', thinking: p.text } : { type: 'text', text: p.text };
    if (p.functionCall) return { type: 'tool_use', ...p.functionCall, input: p.functionCall.args };
    if (p.functionResponse) return { type: 'tool_result', tool_use_id: p.functionResponse.id || raw.toolCallId, name: p.functionResponse.name, content: p.functionResponse.response, is_error: p.functionResponse.response?.error != null };
    return { type: 'unsupported' };
  });
  return conversationMessage({ ...raw, content }, fallbackID);
}

/** Requests and reads alone never create file-change evidence. */
export function successfulEdits(messages: ImportedMessage[], editNames: string[]) {
  const calls = new Map<string, { name: string; input: Raw }>();
  for (const message of messages) for (const event of message.events || []) {
    if (event.kind === 'tool_call' && event.callID) {
      let input: Raw = {}; try { input = object(JSON.parse(event.input || '{}')); } catch { /* A truncated input is not evidence. */ }
      calls.set(event.callID, { name: event.name, input });
    }
    if (event.kind !== 'tool_result' || event.status !== 'completed' || !event.callID) continue;
    const call = calls.get(event.callID);
    if (!call || !editNames.includes(call.name)) continue;
    if (call.name === 'editor' && (typeof call.input.new_text !== 'string' || typeof call.input.old_text !== 'string')) continue;
    const path = text(call.input.file_path) || text(call.input.filePath) || text(call.input.path);
    if (!path || path.length > 4096) continue;
    // The result must not contain an explicit failure hidden inside a success envelope.
    try { const result = JSON.parse(event.output || '{}'); if (result?.success === false || result?.error) continue; } catch { /* Text-only success results are valid. */ }
    message.files.push({ path, source: 'edit tool', steps: 1 }); addText(message, path, 'File');
  }
}
