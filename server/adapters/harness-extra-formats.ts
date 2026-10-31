import { basename, dirname, join } from 'node:path';
import { json, jsonLines, object, text, time, type LocalHistory, type Raw } from './local-files';
import { acpHistory, fileID, message, recordEvent, seconds } from './harness-formats';

export function kiroHistory(path: string, files: Map<string, string>): LocalHistory {
  const header = object(json(files.get(path)!));
  const ide = basename(path) === 'session.json';
  const nativeID = text(header.session_id || header.sessionId || header.id) || (ide ? basename(dirname(path)) : '');
  if (!nativeID) throw new Error('Unsupported Kiro session header.');
  const side = ide ? join(dirname(path), 'messages.jsonl') : path.replace(/\.json$/, '.jsonl');
  if (!files.has(side)) throw new Error('Kiro conversation sidecar is unavailable.');
  const { rows } = jsonLines(files.get(side)!);
  const messages = rows.flatMap((r, i) => {
    if (ide) {
      const p = object(r.payload || r);
      const role = p.type === 'human' ? 'user' : p.type === 'ai' ? 'assistant' : p.role || p.type;
      const m = message({ ...p, role }, text(p.id) || `message:${i}`, r.timestamp);
      return m ? [m] : [recordEvent(r, `event:${i}`, text(p.type) || 'Kiro event', r.timestamp, p.text)];
    }
    const data = object(r.data), role = r.kind === 'Prompt' ? 'user' : r.kind === 'AssistantMessage' ? 'assistant' : r.kind === 'ToolResults' ? 'tool' : '';
    if (!role) return [];
    const content = Array.isArray(data.content) ? data.content.map((p: Raw) => p.kind === 'text' ? { type: 'text', text: p.data } : { type: 'unsupported' }) : undefined;
    const m = message({ role, content }, text(data.message_id) || `message:${i}`, seconds(data.meta?.timestamp));
    return m ? [m] : [];
  });
  if (!messages.length) throw new Error('No readable Kiro messages.');
  return { nativeID, messages, partial: true, session: { directory: text(header.cwd) || (header.workspacePaths?.length === 1 ? text(header.workspacePaths[0]) : ''), created: time(header.createdAt), title: text(header.title), model: text(header.modelId || header.session_state?.rts_model_state?.model_info?.model_id) || 'Unknown model' },
    note: 'Kiro CLI header/JSONL and IDE session snapshots. Unsupported payload variants and compacted context may be absent. Token estimates and credit conversions are not imported.' };
}

export function muxHistory(path: string, files: Map<string, string>): LocalHistory {
  const archive = files.get(join(dirname(path), 'chat-archive.jsonl'));
  const records = [...(archive ? jsonLines(archive).rows : []), ...jsonLines(files.get(path)!).rows];
  const unique = new Map<string, Raw>();
  for (const r of records) { if (!text(r.id)) throw new Error('Mux message has no native identity.'); unique.set(r.id, r); }
  const messages = [...unique.values()].flatMap(r => {
    const parts = Array.isArray(r.parts) ? r.parts.flatMap((p: Raw) => {
      if (p.type !== 'dynamic-tool') return [p];
      const call = { type: 'tool_use', id: p.toolCallId, name: p.toolName, input: p.input };
      return p.state === 'output-available' || p.state === 'output-error' ? [call, { type: 'tool_result', tool_use_id: p.toolCallId, content: p.output ?? p.errorText, is_error: p.state === 'output-error' }] : [call];
    }) : r.content;
    if (r.metadata?.synthetic) return [recordEvent(r, r.id, 'Synthetic context', r.metadata?.timestamp, parts)];
    const m = message({ ...r, content: parts }, r.id, r.metadata?.timestamp ?? r.createdAt); return m ? [m] : [];
  });
  if (!messages.length) throw new Error('No readable Mux conversation.');
  return { nativeID: basename(dirname(path)), messages, partial: true,
    note: 'Mux durable chat archive followed by active chat, deduplicated by native message ID. In-flight partial.json and workspace ancestry are unavailable. Cumulative usage snapshots are not turns.' };
}

export function devinDesktopHistory(path: string, files: Map<string, string>): LocalHistory {
  const { rows } = jsonLines(files.get(path)!);
  const normalized = rows.flatMap(r => {
    const n = object(r.notification);
    return n.sessionUpdate ? [{ params: { sessionId: text(r.sessionId || n.sessionId) || fileID(path).replace(/\.ndjson$/, ''), update: n }, timestamp: n.content?.metadata?.created_at ?? n.metadata?.created_at ?? n.timestamp ?? r.timestamp }] : [];
  });
  const history = acpHistory(path, normalized.map(r => JSON.stringify(r)).join('\n'));
  history.note = 'Devin Desktop saved ACP notification chunks. File/native identity is preserved; titles are never used to merge desktop and CLI sessions. Tool internals and turn boundaries may be incomplete.';
  return history;
}
