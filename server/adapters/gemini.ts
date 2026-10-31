import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { addText } from './common';
import { eventFor, eventText } from '../events';
import { json, jsonLines, localFileAdapter, object, text, time, type Raw } from './local-files';
import { googleMessage, successfulEdits } from './local-messages';

function projectRootFile(path: string) { const parts = path.split(sep); return join(parts.slice(0, parts.lastIndexOf('chats')).join(sep), '.project_root'); }

export function geminiConversation(contents: string, lines: boolean) {
  const parsed = lines ? jsonLines(contents) : { rows: [object(json(contents))], partial: false };
  let metadata: Raw = {}; const messages = new Map<string, Raw>();
  const patch = (p: Raw) => {
    const existing = messages.get(text(p.id)); if (!existing) return;
    if (p.content !== undefined) existing.content = p.content;
    for (const update of Array.isArray(p.toolCalls) ? p.toolCalls : []) {
      const call = existing.toolCalls?.find((t: Raw) => t.id === update.id);
      if (call && 'result' in update) call.result = update.result;
    }
  };
  for (const row of parsed.rows) {
    if (typeof row.$rewindTo === 'string') {
      const ids = [...messages.keys()], index = ids.indexOf(row.$rewindTo);
      for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id);
    } else if (row.$patch) {
      const p = object(row.$patch); if (p.id) patch(p);
      for (const update of Array.isArray(p.updates) ? p.updates : []) patch(object(update));
      for (const id of Array.isArray(p.removeIds) ? p.removeIds : []) messages.delete(id);
      for (const id of Array.isArray(p.orderIds) ? p.orderIds : []) { const value = messages.get(id); if (value) { messages.delete(id); messages.set(id, value); } }
    } else if (row.$set || row.sessionId) {
      const update = row.$set ? object(row.$set) : row;
      metadata = { ...metadata, ...update };
      if (Array.isArray(update.messages)) { if (row.$set) messages.clear(); for (const message of update.messages) if (typeof message.id === 'string') messages.set(message.id, message); }
    } else if (typeof row.id === 'string' && typeof row.type === 'string') messages.set(row.id, row);
    else parsed.partial = true;
  }
  return { metadata, records: [...messages.values()], partial: parsed.partial };
}

export const geminiAdapter = localFileAdapter({
  id: 'gemini', name: 'Gemini CLI', description: 'Local JSON and JSONL chats, including recorded subagent histories',
  capabilities: { history: true, forks: false, children: true, files: true },
  roots: () => process.env.SESSIONGRAPH_GEMINI_HOME ? [join(process.env.SESSIONGRAPH_GEMINI_HOME, 'tmp')] : [join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini', 'tmp'), join(process.env.GEMINI_CLI_HOME || homedir(), '.cache', '.gemini', 'tmp')],
  match: path => /^[^/]+\/chats\/(?:[^/]+\/)?[^/]+\.jsonl?$/.test(path),
  extras: path => [projectRootFile(path)],
  parse(path, files) {
    const { metadata: meta, records, partial } = geminiConversation(files.get(path)!, path.endsWith('.jsonl'));
    if (!text(meta.sessionId)) throw new Error('Unsupported Gemini history.');
    const directory = (files.get(projectRootFile(path)) || '').trim().slice(0, 4096);
    const messages = records.map((raw, index) => {
      const message = googleMessage({ id: raw.id, timestamp: raw.timestamp, role: raw.type === 'user' ? 'user' : raw.type === 'gemini' ? 'assistant' : 'system', content: raw.content }, `record:${index}`);
      for (const [i, thought] of (Array.isArray(raw.thoughts) ? raw.thoughts : []).entries()) message.events!.push(eventFor(message, `thought:${i}`, 'reasoning', text(thought.subject) || 'Recorded reasoning', text(thought.description), { time: time(thought.timestamp) || null, timeSource: time(thought.timestamp) ? 'recorded' : 'unknown' }));
      for (const [i, call] of (Array.isArray(raw.toolCalls) ? raw.toolCalls : []).entries()) {
        const id = text(call.id) || `tool:${i}`, name = text(call.name) || 'Tool';
        message.tools.push(name);
        message.events!.push(eventFor(message, `call:${id}`, 'tool_call', name, '', { callID: id, input: eventText(call.args), status: 'unknown' }));
        if (call.result != null || ['success', 'error', 'cancelled'].includes(call.status)) {
          const output = eventText(call.result);
          message.events!.push(eventFor(message, `result:${id}`, 'tool_result', name, '', { role: 'tool', callID: id, output, nativeType: text(call.status), time: time(call.timestamp) || null, timeSource: time(call.timestamp) ? 'recorded' : 'unknown', status: call.status === 'success' ? 'completed' : call.status === 'error' ? 'failed' : 'unknown' }));
          addText(message, output, 'Tool');
        }
      }
      return message;
    });
    successfulEdits(messages, ['write_file', 'replace']);
    const parent = meta.kind === 'subagent' && basename(dirname(dirname(path))) === 'chats' ? basename(dirname(path)) : undefined;
    return { nativeID: meta.sessionId, messages, parent, partial,
      session: { directory, created: time(meta.startTime), title: text(meta.summary), model: text([...records].reverse().find(r => r.model)?.model) || 'Unknown model', provider: 'Google', nativeResume: !parent && Boolean(directory) && !process.env.SESSIONGRAPH_GEMINI_HOME && !path.includes(`${sep}.cache${sep}`) },
      note: 'Local Gemini chat records with rewind and patch reconstruction. Only explicit subagent directories form parent links; workspace paths come from the project-root marker. Binary content is omitted.' };
  },
});
