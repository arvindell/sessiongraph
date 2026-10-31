import { basename, dirname, join } from 'node:path';
import { blankMessage } from './common';
import { eventFor, eventText } from '../events';
import { json, jsonLines, object, text, time, type LocalHistory, type Raw } from './local-files';
import { conversationMessage } from './local-messages';
import { piHistory } from './pi';
import type { ImportedMessage } from './types';

export const nativeText = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : text(v);
export const seconds = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : time(v);
export const fileID = (path: string) => basename(path).replace(/\.jsonl(?:\..*)?$|\.json$/, '');
export const sidecar = (files: Map<string, string>, path: string) => object(files.has(path) ? json(files.get(path)!) : undefined);
const roles = ['user', 'assistant', 'system', 'tool', 'toolResult', 'model'];

/** Only a recorded role and content establish a conversation turn. */
export function message(raw: Raw, id: string, timestamp?: unknown): ImportedMessage | undefined {
  if (!roles.includes(raw.role)) return;
  if (raw.content == null && !Array.isArray(raw.toolCalls ?? raw.tool_calls)) return;
  return conversationMessage({ ...raw, id: nativeText(raw.id) || id, timestamp: timestamp ?? raw.timestamp ?? raw.createdAt, toolCalls: raw.toolCalls ?? raw.tool_calls }, id);
}
export function recordEvent(raw: Raw, id: string, kind: string, timestamp: unknown, content?: unknown) {
  const m = blankMessage(id, time(timestamp), 'system');
  m.events = [eventFor(m, 'record', /compact|summary/i.test(kind) ? 'compaction' : /error/i.test(kind) ? 'error' : 'event', kind || 'Source event', eventText(content), { nativeType: kind, partial: true })];
  m.partial = true;
  return m;
}

/** Claude-style envelopes used by several independent clients, including flat legacy messages. */
export function envelopeHistory(path: string, value: string): LocalHistory {
  const { rows, partial } = jsonLines(value);
  if (rows[0]?.type === 'session' && rows.some(r => r.type === 'message' && r.message?.role)) return piHistory(value);
  const nativeIDs = new Set(rows.map(r => text(r.sessionId || r.session_id)).filter(Boolean));
  if (nativeIDs.size > 1) throw new Error('Multiple native sessions in one transcript are not supported.');
  const header = rows.find(r => r.type === 'session' || r.type === 'session_start' || r.type === 'session_startup') || {};
  const nativeID = [...nativeIDs][0] || text(header.id || header.sessionId) || fileID(path);
  const messages = rows.flatMap((r, i) => {
    const body = object(r.message), role = body.role || r.role || (['user', 'assistant', 'system'].includes(r.type) ? r.type : undefined);
    const m = message({ ...body, id: text(r.uuid || r.id) || body.id, role, content: body.content ?? r.content ?? r.text }, `record:${i}`, r.timestamp ?? body.timestamp);
    return m ? [m] : [];
  });
  if (!messages.length) throw new Error('No readable conversation records.');
  const meta = rows.find(r => r.cwd) || header;
  const last = [...rows].reverse().find(r => r.message?.model || typeof r.model === 'string');
  return { nativeID, messages, partial: true,
    session: { directory: text(meta.cwd), created: time(header.timestamp), title: text(header.title), model: text(last?.message?.model || last?.model) || 'Unknown model' },
    note: `Local conversation envelopes; source-native message IDs are retained. Context-only records, opaque attachments, and unsupported branches may be absent.${partial ? ' Malformed records were skipped.' : ''}` };
}

export function ampHistory(path: string, files: Map<string, string>): LocalHistory {
  const raw = object(json(files.get(path)!));
  if (!text(raw.id) || !Array.isArray(raw.messages)) throw new Error('Unsupported Amp thread.');
  const messages = raw.messages.flatMap((m: Raw, i: number) => {
    const result = message(m, nativeText(m.messageId) || `message:${i}`, m.timestamp ?? m.usage?.timestamp);
    return result ? [result] : [];
  });
  return { nativeID: raw.id, messages, partial: true, session: { created: time(raw.created), title: text(raw.title), directory: text(raw.cwd) }, note: 'Amp local/exported thread messages. Usage-ledger ranges are not message timestamps. Export-only and missing content remain partial.' };
}

export function jcodeHistory(path: string, files: Map<string, string>): LocalHistory {
  const raw = object(json(files.get(path)!));
  if (!text(raw.id) || !Array.isArray(raw.messages)) throw new Error('Unsupported Jcode session.');
  const journal = path.replace(/\.json$/, '.journal.jsonl');
  const appended = files.has(journal) ? jsonLines(files.get(journal)!) : { rows: [], partial: false };
  const records = [...raw.messages];
  for (const row of appended.rows) {
    if (Array.isArray(row.append_messages)) records.push(...row.append_messages);
    if (row.meta) Object.assign(raw, object(row.meta));
  }
  const seen = new Set<string>();
  const messages = records.flatMap((r, i) => {
    const id = text(r.id) || `message:${i}`;
    if (seen.has(id)) return []; seen.add(id);
    const m = message(r, id); return m ? [m] : [];
  });
  return { nativeID: raw.id, messages, partial: appended.partial, session: { title: text(raw.title), directory: text(raw.working_dir), created: time(raw.created_at), model: text(raw.model) || 'Unknown model', provider: text(raw.provider_key) }, note: 'Jcode session snapshot and append journal; replayed native message IDs count once. Absent message times remain unknown.' };
}

export function codebuffHistory(path: string, files: Map<string, string>, free: boolean): LocalHistory | undefined {
  const records = json(files.get(path)!);
  if (!Array.isArray(records)) throw new Error('Unsupported Codebuff chat.');
  const isFree = records.some(m => text(m.metadata?.runState?.sessionState?.mainAgentState?.agentType).startsWith('base2-free'));
  if (isFree !== free) return;
  const messages = records.flatMap((r, i) => {
    const content = r.content ?? (Array.isArray(r.blocks) ? r.blocks.filter((b: Raw) => typeof b.content === 'string').map((b: Raw) => ({ type: 'text', text: b.content })) : undefined);
    const m = message({ ...r, role: r.role || r.type, content }, text(r.id) || `message:${i}`);
    return m ? [m] : [];
  });
  const chat = basename(dirname(path)), project = basename(dirname(dirname(dirname(path))));
  return { nativeID: `${project}/${chat}`, messages, partial: true, note: 'Codebuff/Freebuff persisted chat messages. Freebuff requires a recorded base2-free root-agent marker. Shared storage is attributed once; token counts are not estimated from text.' };
}

export function vibeHistory(path: string, files: Map<string, string>): LocalHistory {
  const raw = object(json(files.get(path)!)), legacy = basename(path) !== 'meta.json';
  const meta = legacy ? object(raw.metadata) : raw;
  const transcript = join(dirname(path), 'messages.jsonl');
  const parsed = files.has(transcript) ? jsonLines(files.get(transcript)!) : { rows: [], partial: false };
  const records = legacy ? raw.messages : parsed.rows;
  if (!text(meta.session_id) || !Array.isArray(records)) throw new Error('Unsupported Vibe session.');
  const messages = records.flatMap((r: Raw, i: number) => { const m = message(r, `message:${i}`); return m ? [m] : []; });
  return { nativeID: meta.session_id, messages, partial: parsed.partial || !messages.length,
    session: { directory: text(meta.environment?.working_directory), created: time(meta.start_time), model: text(meta.config?.active_model) || 'Unknown model', title: text(meta.title) },
    note: 'Vibe session metadata and conversation snapshot. Untimed transcript messages remain untimed; cumulative session usage is not spread across turns.' };
}

/** ACP updates are fragments, not complete turns. Group only adjacent chunks of a recorded turn. */
export function acpHistory(path: string, value: string): LocalHistory {
  const { rows } = jsonLines(value), ids = new Set<string>(), messages: ImportedMessage[] = [];
  let current: { role: string; content: string; id: string; time: number } | undefined;
  const flush = () => { if (current) { messages.push(conversationMessage({ role: current.role, content: current.content, timestamp: current.time }, current.id)); current = undefined; } };
  for (const [i, row] of rows.entries()) {
    const p = object(row.params), u = object(p.update), kind = text(u.sessionUpdate);
    if (text(p.sessionId)) ids.add(p.sessionId);
    const timestamp = time(p._meta?.agentTimestampMs) || time(row.timestamp);
    const role = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' ? 'assistant' : '';
    if (role && u.content?.type === 'text') {
      if (current?.role !== role) { flush(); current = { role, content: '', id: `chunk:${i}`, time: timestamp }; }
      current!.content += text(u.content.text);
    } else {
      flush();
      if (kind === 'agent_thought_chunk') messages.push(recordEvent(row, `record:${i}`, 'Recorded reasoning', timestamp, u.content?.text));
      else if (kind) messages.push(recordEvent(row, `record:${i}`, kind, timestamp, u.title));
    }
  }
  flush();
  if (ids.size > 1) throw new Error('Multiple sessions in one ACP event log.');
  if (!ids.size || !messages.length) throw new Error('No supported ACP session updates.');
  return { nativeID: [...ids][0], messages, partial: true, note: 'Saved ACP updates. Adjacent text chunks are grouped; missing turn boundaries, tool payloads, and metadata remain partial.' };
}

export function dshHistory(value: string): LocalHistory {
  const { rows, partial } = jsonLines(value), header = rows.find(r => r.type === 'session');
  if (!text(header?.id)) throw new Error('Unsupported DeepSeek Harness session.');
  const messages = rows.flatMap((r, i) => {
    if (!['user/message', 'assistant/message', 'tool/message'].includes(r.type)) return [];
    const body = object(r.data?.message);
    const m = message({ ...body, role: body.role || r.type.split('/')[0] }, text(body.id) || `record:${i}`, r.time);
    return m ? [m] : [];
  });
  return { nativeID: header!.id, messages, partial: true, session: { directory: text(header!.cwd), created: time(header!.createdAt ?? header!.time) }, note: `DeepSeek Harness final message records; streaming/retry bookkeeping is excluded. Context seeds and unsupported event payloads may be absent.${partial ? ' Malformed records were skipped.' : ''}` };
}
