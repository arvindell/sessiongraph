import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { addText, blankMessage, blankSession, digest, identity, project, toolText } from './common';
import { readJSONL, transcriptFiles } from './jsonl';
import type { Candidate, SessionAdapter } from './types';
import { blockEvents, eventFor, eventText } from '../events';

const root = () => process.env.CODEX_HOME || join(homedir(), '.codex');
const revision = async (path: string) => { const s = await stat(path); return digest([7, s.mtimeMs, s.size]); };
function changedPaths(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const changes = Array.isArray(value) ? value : Object.entries(value).map(([path, change]) => ({ ...(change && typeof change === 'object' ? change : {}), path }));
  return changes.flatMap((change) => [change.path, change.move_path, change.kind?.move_path].filter((path): path is string => typeof path === 'string'));
}

export function codexUserText(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (/^# (?:AGENTS\.md|Instructions for)/i.test(text)) return '';
  // Desktop app context arrives in user-role messages too. These wrappers are
  // protocol scaffolding, not the user's prompt or a useful session title.
  text = text.replace(/<(environment_context|permissions|user_instructions|turn_aborted|external_codex_[\w-]+)>[\s\S]*?<\/\1>/g, '').trim();
  if (/^<(?:environment_context|permissions|user_instructions|turn_aborted|external_codex_[\w-]+)(?:>|\s)/.test(text)) return '';
  return text;
}

async function sessionNames() {
  const names = new Map<string, string>();
  let cursor: number | undefined, count = 0;
  try {
    do {
      const page = await readJSONL(join(root(), 'session_index.jsonl'), cursor, 2_000_000, 1000);
      for (const { value } of page.rows) if (typeof value.id === 'string' && typeof value.thread_name === 'string' && value.thread_name.trim()) names.set(value.id, value.thread_name.trim().slice(0, 300));
      cursor = page.cursor; count += page.rows.length;
    } while (cursor !== undefined && count < 100_000);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return names;
}

export function codexRecord(raw: any, offset: number, candidate: Candidate) {
  const p = raw.payload;
  if (!p || typeof p !== 'object') return;
  if (raw.type === 'turn_context' && typeof p.model === 'string') candidate.session.model = p.model;
  if (raw.type === 'event_msg' && p.type === 'item_completed' && ['FileChange', 'fileChange'].includes(p.item?.type)) {
    const msg = blankMessage(`event:${p.item.id || raw.ordinal || offset}`, p.completed_at_ms || Date.parse(raw.timestamp) || 0, 'tool');
    msg.events = [eventFor(msg, 'change', 'event', 'File-change result', eventText(p.item), { nativeType: p.type, status: ['completed', 'Completed'].includes(p.item.status) ? 'completed' : 'unknown' })];
    if (['completed', 'Completed'].includes(p.item.status)) for (const path of changedPaths(p.item.changes)) {
      msg.files.push({ path, source: 'file change', steps: 1 }); addText(msg, path, 'File');
    }
    return msg;
  }
  // response_item is the canonical transcript. event_msg mirrors user/assistant
  // text; importing both would duplicate it. Keep only completed edit evidence.
  if (raw.type === 'event_msg' && p.type === 'patch_apply_end') {
    const msg = blankMessage(`event:${p.call_id || raw.ordinal || offset}`, Date.parse(raw.timestamp) || 0, 'tool');
    msg.events = [eventFor(msg, 'patch', 'tool_result', 'apply_patch', '', { callID: p.call_id, output: eventText(p), nativeType: p.type, status: p.success === true ? 'completed' : p.success === false ? 'failed' : 'unknown' })];
    if (p.success === true) for (const [path, change] of Object.entries(p.changes || {})) {
      msg.files.push({ path, source: 'file change', steps: 1 }); addText(msg, path, 'File');
      if ((change as any)?.move_path) { msg.files.push({ path: (change as any).move_path, source: 'file change', steps: 1 }); addText(msg, (change as any).move_path, 'File'); }
    }
    return msg;
  }
  if (raw.type !== 'response_item') {
    // These event_msg records mirror canonical response items. Keep lifecycle,
    // compaction and unfamiliar events without duplicating conversation text.
    if (raw.type === 'session_meta' || (raw.type === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content'].includes(p.type))) return;
    const msg = blankMessage(`event:${raw.ordinal ?? offset}`, Date.parse(raw.timestamp) || 0, 'system');
    msg.events = [eventFor(msg, 'event', /compact/.test(p.type || raw.type) ? 'compaction' : p.type === 'error' ? 'error' : 'event', p.type || raw.type, eventText(p), { nativeType: `${raw.type}:${p.type || ''}` })];
    return msg;
  }
  const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : p.type === 'message' ? 'system' : 'tool';
  // Reused call_id across request/response isn't a unique message ID.
  const msg = blankMessage(`item:${raw.ordinal ?? offset}`, Date.parse(raw.timestamp) || 0, role);
  const fields = { nativeID: p.id, nativeType: p.type, callID: p.call_id };
  msg.events = p.type === 'message' ? blockEvents(msg, p.content)
    : ['function_call', 'custom_tool_call'].includes(p.type) ? [eventFor(msg, 'call', 'tool_call', p.name || 'Tool call', '', { ...fields, role: 'assistant', input: eventText(p.arguments ?? p.input), status: 'unknown' })]
    : ['function_call_output', 'custom_tool_call_output'].includes(p.type) ? [eventFor(msg, 'result', 'tool_result', 'Tool result', '', { ...fields, output: eventText(p.output, 64_000), status: 'unknown' })]
    : [eventFor(msg, 'event', p.type === 'reasoning' ? 'reasoning' : 'event', p.type === 'reasoning' ? 'Recorded reasoning summary' : p.type || 'Unknown event', eventText(p.type === 'reasoning' ? p.summary : p), { ...fields, partial: p.type === 'reasoning' })];
  if (role === 'user') msg.events = msg.events.map((event) => event.kind === 'message' && event.text && !codexUserText(event.text) ? { ...event, kind: 'event', role: 'system', name: 'Session context', nativeType: 'user-context' } : event);
  if (p.type === 'message') {
    for (const part of Array.isArray(p.content) ? p.content : []) if (['input_text', 'output_text', 'text'].includes(part.type)) addText(msg, role === 'user' ? codexUserText(part.text) : part.text, role === 'user' ? 'You' : 'Assistant');
  } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
    msg.tools.push(p.name || 'tool'); addText(msg, p.name, 'Tool'); toolText(msg, p.arguments || p.input);
  } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) toolText(msg, p.output);
  else if (p.type === 'file_change' || p.type === 'fileChange') {
    if (p.status === 'completed') for (const path of changedPaths(p.changes)) { msg.files.push({ path, source: 'file change', steps: 1 }); addText(msg, path, 'File'); }
  }
  return msg;
}

export const codexAdapter: SessionAdapter = {
  id: 'codex', name: 'Codex', description: 'Local active and archived rollouts · no running agent required',
  capabilities: { history: true, forks: true, children: true, files: true },
  async detect() { try { return (await stat(root())).isDirectory(); } catch { return false; } },
  async discover() {
    const found = new Map<string, Candidate>(), warnings: string[] = [];
    const names = await sessionNames();
    const paths = [...await transcriptFiles(join(root(), 'sessions')), ...await transcriptFiles(join(root(), 'archived_sessions'))];
    if (paths.length >= 20_000) warnings.push('Codex transcript listing may be partial (20,000 files per history folder).');
    let unsupported = 0;
    for (const path of paths) {
      const first = await readJSONL(path, 0, 2_000_000, 100);
      const meta = first.rows.find((r) => r.value.type === 'session_meta')?.value.payload;
      if (!meta?.id || typeof meta.id !== 'string') { unsupported++; continue; }
      const stats = await stat(path), session = blankSession('codex', meta.id, meta.cwd);
      session.title = names.get(meta.id) || (typeof meta.name === 'string' ? meta.name : 'Untitled session');
      const source = meta.source?.subagent?.thread_spawn || meta.source?.sub_agent?.thread_spawn;
      const parent = meta.parent_thread_id || source?.parent_thread_id;
      const fork = meta.forked_from_id || meta.forkedFromId;
      Object.assign(session, { created: Date.parse(meta.timestamp) || stats.birthtimeMs || stats.mtimeMs, updated: stats.mtimeMs, archived: path.includes(`${sep}archived_sessions${sep}`), provider: meta.model_provider || '', agent: 'Codex', parentID: parent ? identity('codex', parent) : undefined, forkID: fork ? identity('codex', fork) : undefined });
      const candidate = { session, locator: { path }, revision: await revision(path) };
      for (const row of first.rows) {
        const msg = codexRecord(row.value, row.offset, candidate);
        if (session.title === 'Untitled session' && msg?.role === 'user') {
          const text = msg.fragments.find((f) => f.kind === 'You')?.text;
          if (text) session.title = text.replace(/\s+/g, ' ').slice(0, 180);
        }
      }
      if (session.title === 'Untitled session') session.title = 'Codex session';
      const old = found.get(session.id);
      if (!old || session.updated > old.session.updated) found.set(session.id, candidate);
    }
    if (unsupported) warnings.push(`${unsupported} Codex files have no supported rollout metadata.`);
    warnings.push('Codex imports local JSONL rollouts. Cloud-only and store-only history are not imported.');
    const sessions = [...found.values()];
    return { sessions, projects: [...new Map(sessions.map((c) => { const p = project('codex', c.session.directory); return [p.id, p]; })).values()], warnings };
  },
  async read(candidate, cursor) {
    const page = await readJSONL(candidate.locator.path, Number(cursor || 0));
    if (page.cursor === undefined && await revision(candidate.locator.path) !== candidate.revision) throw new Error('Session changed during import; import again to capture the latest messages.');
    return { messages: page.rows.flatMap((r) => { const msg = codexRecord(r.value, r.offset, candidate); return msg ? [msg] : []; }), cursor: page.cursor === undefined ? undefined : String(page.cursor), partial: page.partial, note: 'Local rollout messages, tools, and lifecycle events. Mirrored conversation events are deduplicated. Images, encrypted reasoning, and store-only history are unavailable.' };
  },
};
