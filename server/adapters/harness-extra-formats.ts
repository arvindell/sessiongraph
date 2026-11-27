import { basename, dirname, join } from 'node:path';
import { json, jsonLines, object, text, time, type LocalHistory, type Raw } from './local-files';
import { acpHistory, fileID, message, recordEvent, seconds } from './harness-formats';
import { recordedCost, recordedUsage, sessionUsage, sumTokens, sumUsage } from '../usage';

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
    note: 'Earlier messages and some tool details may be missing.' };
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
  const usagePath = join(dirname(path), 'session-usage.json');
  const usage = files.has(usagePath) ? object(json(files.get(usagePath)!)) : {};
  const models = Object.values(object(usage.byModel)).slice(0, 50_000).map((value) => {
    const row = object(value), buckets = [row.input, row.cached, row.cacheCreate, row.output, row.reasoning].map(object);
    return recordedUsage({ input: row.input?.tokens, output: row.output?.tokens, cacheRead: row.cached?.tokens, cacheWrite: row.cacheCreate?.tokens,
      reasoning: row.reasoning?.tokens, total: sumTokens(buckets.map(bucket => bucket.tokens)), inputIncludesCache: false, outputIncludesReasoning: false,
      cost: buckets.every(bucket => recordedCost(bucket.cost_usd) !== null) ? buckets.reduce((sum, bucket) => sum + bucket.cost_usd, 0) : null });
  }).filter(value => value !== undefined);
  return { nativeID: basename(dirname(path)), messages, partial: true, session: { usage: sessionUsage(sumUsage(models), models.some(value => value.total === null)) } };
}

export function devinDesktopHistory(path: string, files: Map<string, string>): LocalHistory {
  const { rows } = jsonLines(files.get(path)!);
  const normalized = rows.flatMap(r => {
    const n = object(r.notification);
    return n.sessionUpdate ? [{ params: { sessionId: text(r.sessionId || n.sessionId) || fileID(path).replace(/\.ndjson$/, ''), update: n }, timestamp: n.content?.metadata?.created_at ?? n.metadata?.created_at ?? n.timestamp ?? r.timestamp }] : [];
  });
  return acpHistory(path, normalized.map(r => JSON.stringify(r)).join('\n'));
}
