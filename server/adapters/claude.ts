import { listSessions, getSessionMessages, getSubagentMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addText, blankMessage, blankSession, identity, project, toolText } from './common';
import type { Candidate, ImportedMessage, SessionAdapter } from './types';
import { blockEvents, eventFor, eventText } from '../events';
import { claudeRevision as revision, claudeSessionID, claudeTranscript, claudeTranscriptInfo, claudeTranscriptStore } from './claude-transcripts';
import { localFileAdapter } from './local-files';
import { envelopeHistory } from './harness-formats';
import { combineAdapters } from './sqlite-histories';

const root = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

export function claudeMessages(rows: SessionMessage[], candidate: Candidate, times?: Map<string, number>): ImportedMessage[] {
  // Match tool results explicitly; a requested edit alone is not file evidence.
  const calls = new Map<string, { name: string; input: any }>();
  return rows.map((row) => {
    const raw = row.message as any;
    const msg = blankMessage(row.uuid, times?.get(row.uuid) ?? (Number.isFinite(Date.parse(raw?.timestamp)) ? Date.parse(raw.timestamp) : 0), row.type);
    if (raw?.model) candidate.session.model = raw.model;
    if (row.parent_agent_id && candidate.locator.parent) candidate.session.parentID = identity('claude-code', `${candidate.locator.parent}/agent/${row.parent_agent_id}`);
    if (typeof raw?.content === 'string') addText(msg, raw.content, row.type === 'user' ? 'You' : 'Assistant');
    for (const part of Array.isArray(raw?.content) ? raw.content : []) {
      if (part.type === 'text') addText(msg, part.text, row.type === 'user' ? 'You' : 'Assistant');
      if (part.type === 'tool_use') {
        calls.set(part.id, { name: part.name, input: part.input });
        msg.tools.push(part.name); addText(msg, part.name, 'Tool'); toolText(msg, part.input);
      }
      if (part.type === 'tool_result') {
        toolText(msg, part.content);
        const call = calls.get(part.tool_use_id);
        if (!part.is_error && call && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(call.name)) {
          const path = call.input?.file_path || call.input?.notebook_path;
          if (typeof path === 'string') msg.files.push({ path, source: 'edit tool', steps: 1 });
        }
      }
    }
    msg.events = blockEvents(msg, raw?.content).map((event) => ({ ...event, parentID: row.parent_tool_use_id || undefined }));
    if (!msg.events.length) msg.events = [eventFor(msg, 'event', raw?.subtype === 'compact_boundary' ? 'compaction' : 'event', raw?.subtype || `${row.type} event`, eventText(raw), { nativeType: raw?.subtype || row.type, partial: true })];
    return msg;
  });
}

const sdkClaudeAdapter: SessionAdapter = {
  id: 'claude-code', name: 'Claude Code', description: 'Local CLI and VS Code history · all projects and subagent transcripts',
  capabilities: { history: true, forks: false, children: true, files: true },
  async detect() { try { return (await stat(root())).isDirectory(); } catch { return false; } },
  async discover() {
    const sessions: Candidate[] = [], warnings: string[] = [];
    // The SDK deduplicates native session IDs across projects and worktrees.
    const infos = await listSessions({ limit: 20_000, includeProgrammatic: true });
    if (infos.length === 20_000) warnings.push('Claude Code listing is limited to 20,000 sessions.');
    const files = new Map<string, { path: string; children: string }>();
    let unreadable = 0;
    for (const dir of await readdir(root(), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const parent = join(root(), dir.name);
      let entries;
      try { entries = await readdir(parent, { withFileTypes: true }); } catch { unreadable++; continue; }
      for (const file of entries) if (file.isFile() && file.name.endsWith('.jsonl') && claudeSessionID(file.name.slice(0, -6))) {
        const id = file.name.slice(0, -6), path = join(parent, file.name);
        try {
          const old = files.get(id);
          if (!old || (await stat(path)).mtimeMs > (await stat(old.path)).mtimeMs) files.set(id, { path, children: join(parent, id, 'subagents') });
        } catch { unreadable++; }
      }
    }
    const listed = new Set(infos.map(info => info.sessionId));
    for (const [id, file] of files) {
      if (listed.has(id)) continue;
      if (infos.length >= 20_000) { warnings.push('Claude Code discovery is limited to 20,000 sessions.'); break; }
      try {
        const transcript = await claudeTranscript(file.path, await revision(file.path));
        const info = claudeTranscriptInfo(transcript, id);
        if (info) infos.push(info);
        else if (transcript.partial) unreadable++;
      } catch { unreadable++; }
    }
    for (const info of infos) {
      const file = files.get(info.sessionId);
      if (!file) continue;
      const s = { ...blankSession('claude-code', info.sessionId, info.cwd), title: info.customTitle || info.summary || info.firstPrompt || 'Untitled session', created: info.createdAt || info.lastModified, updated: info.lastModified, provider: 'anthropic', agent: 'Claude Code' };
      try { sessions.push({ session: s, revision: await revision(file.path), locator: { path: file.path, dir: info.cwd || '' } }); }
      catch { unreadable++; continue; }
      let children;
      try { children = await readdir(file.children, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable++; continue; }
      for (const child of children) {
        if (!child.isFile() || !/^agent-[\w-]+\.jsonl$/.test(child.name)) continue;
        try {
          const agent = child.name.slice(6, -6), path = join(file.children, child.name), stats = await stat(path);
          sessions.push({ session: { ...s, id: identity('claude-code', `${info.sessionId}/agent/${agent}`), nativeID: `${info.sessionId}/agent/${agent}`, title: `Subagent ${agent}`, created: stats.birthtimeMs || s.created, updated: stats.mtimeMs, parentID: s.id, agent }, revision: await revision(path), locator: { path, dir: info.cwd || '', parent: info.sessionId, agent } });
        } catch { unreadable++; }
      }
    }
    if (unreadable) warnings.push(`${unreadable} Claude Code histories unavailable or too large. Saved imports are kept.`);
    return { sessions, projects: [...new Map(sessions.map((c) => { const p = project('claude-code', c.session.directory); return [p.id, p]; })).values()], warnings };
  },
  async read(candidate, cursor) {
    const offset = Number(cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor.');
    const transcript = await claudeTranscript(candidate.locator.path, candidate.revision);
    // Overlap one message to retain tool-use/result evidence across page boundaries.
    const start = Math.max(0, offset - 1), count = 120 + offset - start;
    const sessionId = candidate.locator.parent || candidate.session.nativeID!;
    const options = { dir: candidate.locator.dir || undefined, offset: start, limit: count + 1, sessionStore: claudeTranscriptStore(transcript, sessionId, candidate.locator.agent) };
    const rows = candidate.locator.parent
      ? await getSubagentMessages(candidate.locator.parent, candidate.locator.agent, options)
      : await getSessionMessages(candidate.session.nativeID!, options);
    const more = rows.length > count;
    const messages = claudeMessages(rows.slice(0, count), candidate, transcript.times).slice(offset - start);
    if (!offset && !messages.length && transcript.size > 100) throw new Error('SDK returned no readable conversation for this transcript.');
    if (!more && await revision(candidate.locator.path) !== candidate.revision) throw new Error('Session changed during import; import again to capture the latest messages.');
    return { messages, cursor: more ? String(offset + 120) : undefined, partial: transcript.partial, note: `SDK-visible conversation chain from the local CLI/VS Code transcript; pre-compaction text and unsupported message types may be absent. Fork ancestry is unavailable.${transcript.partial ? ' Some transcript records or subagent metadata were unreadable.' : ''}` };
  },
};

// Older exported transcripts can live outside projects and use non-UUID IDs.
// Project transcripts win when both forms contain the same native session.
const exportedClaudeAdapter = localFileAdapter({
  id: 'claude-code', name: 'Claude Code', description: 'Legacy local transcript exports',
  capabilities: { history: true, forks: false, children: false, files: false },
  roots: () => [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'transcripts')],
  match: p => p.endsWith('.jsonl'),
  parse: (path, files) => envelopeHistory(path, files.get(path)!),
});
export const claudeAdapter = combineAdapters([sdkClaudeAdapter, exportedClaudeAdapter]);
