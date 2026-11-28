import { getSessionMessages, getSubagentMessages, type SDKSessionInfo, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { addText, blankMessage, blankSession, identity, project, toolText } from './common';
import type { Candidate, ImportedMessage, SessionAdapter } from './types';
import { blockEvents, eventFor, eventText } from '../events';
import { claudeRevision as revision, claudeSessionID, claudeTranscript, claudeTranscriptInfo, claudeTranscriptStore } from './claude-transcripts';
import { historyFiles, localFileAdapter } from './local-files';
import { envelopeHistory } from './harness-formats';
import { combineAdapters } from './sqlite-histories';
import { sourcePath } from '../source-paths';
import { executionFields, nativeCommit } from '../commit-extraction';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { anthropicUsage, messageMetadata, summarizeUsage } from '../usage';
import { activeClaudeHome, claudeLocations, type ClaudeLocations } from './claude-locations';

export function claudeMessages(rows: SessionMessage[], candidate: Candidate, times?: Map<string, number>, entries?: Map<string, SessionStoreEntry>): ImportedMessage[] {
  // Match tool results explicitly; a requested edit alone is not file evidence.
  const calls = new Map<string, { name: string; input: any }>();
  return rows.map((row) => {
    const raw = row.message as any;
    const msg = blankMessage(row.uuid, times?.get(row.uuid) ?? (Number.isFinite(Date.parse(raw?.timestamp)) ? Date.parse(raw.timestamp) : 0), row.type);
    msg.metadata = messageMetadata({ ...raw, cwd: entries?.get(row.uuid)?.cwd });
    if (row.type === 'assistant') msg.usage = anthropicUsage(raw?.usage, raw?.id);
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
    const entry = entries?.get(row.uuid), structured = (entry?.tool_use_result ?? entry?.toolUseResult) as any;
    const results = Array.isArray(raw?.content) ? raw.content.filter((p: any) => p.type === 'tool_result') : [];
    msg.events = blockEvents(msg, raw?.content).map((event) => {
      // An envelope's native result is only attributable when it has one result
      // block. Never attach it to all parallel calls in an ambiguous envelope.
      const result = event.kind === 'tool_result' && results.length === 1 ? structured : undefined;
      return { ...event, parentID: row.parent_tool_use_id || undefined,
        ...executionFields({}, { ...result, cwd: entry?.cwd }),
        gitCommit: nativeCommit(result?.gitOperation?.commit),
        partial: Boolean(event.partial || result?.interrupted || result?.backgroundTaskId || result?.backgroundedByUser || result?.timedOutAfterMs || entry?.sessionId && entry.sessionId !== (candidate.locator.parent || candidate.session.nativeID)) };
    });
    if (!msg.events.length) msg.events = [eventFor(msg, 'event', raw?.subtype === 'compact_boundary' ? 'compaction' : 'event', raw?.subtype || `${row.type} event`, eventText(raw), { nativeType: raw?.subtype || row.type, partial: true })];
    return msg;
  });
}

const context = new AsyncLocalStorage<ClaudeLocations & { activeHome: string }>();
const homes = () => context.getStore()?.homes || [];
const activeHome = () => context.getStore()?.activeHome || activeClaudeHome();
// Keep only small metadata, never a library of parsed transcript contents.
const metadata = new Map<string, { revision: string; info?: SDKSessionInfo; partial: boolean }>();
const sdkClaudeAdapter: SessionAdapter = {
  id: 'claude-code', name: 'Claude Code', description: 'Computer-wide local CLI and VS Code history · all projects and subagent transcripts',
  capabilities: { history: true, forks: false, children: true, files: true },
  async detect() { for (const home of homes()) if ((await lstat(join(home, 'projects')).catch(() => undefined))?.isDirectory()) return true; return false; },
  async discover() {
    const sessions: Candidate[] = [], warnings: string[] = [];
    // Always read metadata from the chosen transcript, never the SDK's current
    // user's home: another account/archive can contain a different copy.
    const listing = await historyFiles(homes().map(home => join(home, 'projects')), p => {
      const parts = p.split('/');
      return parts.length === 2 && parts[1].endsWith('.jsonl') && claudeSessionID(parts[1].slice(0, -6));
    });
    warnings.push(...listing.warnings);
    const files = new Map<string, { path: string; children: string; home: string; modified: number }>();
    let unreadable = 0;
    for (const path of listing.files) {
      const name = basename(path);
      const id = name.slice(0, -6), home = dirname(dirname(dirname(path)));
      try {
        const modified = (await stat(path)).mtimeMs, old = files.get(id);
        if (!old || modified > old.modified || modified === old.modified && home === resolve(activeHome()) && old.home !== home) files.set(id, { path, home, modified, children: join(dirname(path), id, 'subagents') });
      } catch { unreadable++; }
    }
    for (const [id, file] of files) {
      let info;
      try {
        const rev = await revision(file.path);
        let cached = metadata.get(file.path);
        if (!cached || cached.revision !== rev) {
          const transcript = await claudeTranscript(file.path, rev);
          cached = { revision: rev, info: claudeTranscriptInfo(transcript, id), partial: transcript.partial };
          if (metadata.size >= 20_000) metadata.delete(metadata.keys().next().value!);
          metadata.set(file.path, cached);
        }
        info = cached.info;
        if (!info && cached.partial) unreadable++;
      } catch { unreadable++; continue; }
      if (!info) continue;
      const s = { ...blankSession('claude-code', info.sessionId, info.cwd), title: info.customTitle || info.summary || info.firstPrompt || 'Untitled session', created: info.createdAt || info.lastModified, updated: info.lastModified, provider: 'anthropic', agent: 'Claude Code', nativeResume: !sourcePath('claude-code') && file.home === resolve(activeHome()) };
      if (sessions.length >= 20_000) { warnings.push('Claude Code discovery is limited to 20,000 sessions.'); break; }
      try { sessions.push({ session: s, revision: await revision(file.path), locator: { path: file.path, dir: info.cwd || '' } }); }
      catch { unreadable++; continue; }
      let children;
      try { if (!(await lstat(file.children)).isDirectory()) continue; children = await readdir(file.children, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable++; continue; }
      for (const child of children) {
        if (sessions.length >= 20_000) { warnings.push('Claude Code discovery is limited to 20,000 sessions.'); break; }
        if (!child.isFile() || !/^agent-[\w-]+\.jsonl$/.test(child.name)) continue;
        try {
          const agent = child.name.slice(6, -6), path = join(file.children, child.name), stats = await stat(path);
          sessions.push({ session: { ...s, id: identity('claude-code', `${info.sessionId}/agent/${agent}`), nativeID: `${info.sessionId}/agent/${agent}`, title: `Subagent ${agent}`, created: stats.birthtimeMs || s.created, updated: stats.mtimeMs, parentID: s.id, origin: 'automated', agent }, revision: await revision(path), locator: { path, dir: info.cwd || '', parent: info.sessionId, agent } });
        } catch { unreadable++; }
      }
    }
    if (unreadable) warnings.push(`Claude Code: Skipped ${unreadable} unavailable or oversized transcripts.`);
    return { sessions, projects: [...new Map(sessions.map((c) => { const p = project('claude-code', c.session.directory); return [p.id, p]; })).values()], warnings };
  },
  async read(candidate, cursor) {
    const offset = Number(cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history cursor.');
    const transcript = await claudeTranscript(candidate.locator.path, candidate.revision);
    if (!offset) {
      // Usage can survive outside the SDK's active context chain after compaction.
      // Count each native API identity once, but never borrow a subagent's usage.
      const owner = candidate.locator.parent || candidate.session.nativeID!;
      const usageMessages = transcript.entries.flatMap((entry) => {
        if (entry.type !== 'assistant' || entry.sessionId !== owner || !candidate.locator.agent && entry.isSidechain === true) return [];
        if (candidate.locator.agent && entry.agentId && entry.agentId !== candidate.locator.agent) return [];
        const raw = entry.message as any;
        const message = blankMessage(String(entry.uuid || ''), 0, 'assistant');
        message.usage = anthropicUsage(raw?.usage, raw?.id || entry.uuid);
        return [message];
      });
      if (usageMessages.some(message => message.usage)) {
        const usage = summarizeUsage({ ...candidate.session, usage: undefined, tokens: null, cost: null }, usageMessages, transcript.partial);
        candidate.session.usage = { ...usage, source: 'session' };
      }
    }
    // Overlap one message to retain tool-use/result evidence across page boundaries.
    const start = Math.max(0, offset - 1), count = 120 + offset - start;
    const sessionId = candidate.locator.parent || candidate.session.nativeID!;
    const options = { dir: candidate.locator.dir || undefined, offset: start, limit: count + 1, sessionStore: claudeTranscriptStore(transcript, sessionId, candidate.locator.agent) };
    const rows = candidate.locator.parent
      ? await getSubagentMessages(candidate.locator.parent, candidate.locator.agent, options)
      : await getSessionMessages(candidate.session.nativeID!, options);
    const more = rows.length > count;
    const messages = claudeMessages(rows.slice(0, count), candidate, transcript.times, transcript.byID).slice(offset - start);
    if (!offset && !messages.length && transcript.size > 100) throw new Error('SDK returned no readable conversation for this transcript.');
    if (!more && await revision(candidate.locator.path) !== candidate.revision) throw new Error('Session changed during import; import again to capture the latest messages.');
    return { messages, cursor: more ? String(offset + 120) : undefined, partial: transcript.partial, note: transcript.partial ? 'Some transcript or subagent records could not be read.' : undefined };
  },
};

// Older exported transcripts can live outside projects and use non-UUID IDs.
// Project transcripts win when both forms contain the same native session.
const exportedClaudeAdapter = localFileAdapter({
  id: 'claude-code', name: 'Claude Code', description: 'Legacy local transcript exports',
  capabilities: { history: true, forks: false, children: false, files: false },
  roots: () => homes().map(home => join(home, 'transcripts')),
  match: p => p.endsWith('.jsonl'),
  parse: (path, files) => envelopeHistory(path, files.get(path)!),
});
export function createClaudeAdapter(locations = claudeLocations, currentHome = activeClaudeHome): SessionAdapter {
  const combined = combineAdapters([sdkClaudeAdapter, exportedClaudeAdapter]);
  return { ...combined,
    async detect() {
      const found = await locations();
      // A pending search must remain selectable even before the first home is
      // found, so subsequent imports can continue searching and show warnings.
      return context.run({ ...found, activeHome: resolve(currentHome()) }, () => found.pending ? Promise.resolve(true) : combined.detect());
    },
    async discover() {
      const found = await locations();
      return context.run({ ...found, activeHome: resolve(currentHome()) }, async () => {
        const result = await combined.discover();
        // Legacy exports, like relocated native histories, are context handoffs.
        for (const candidate of result.sessions) if (candidate.locator.representation === '1') candidate.session.nativeResume = false;
        return { ...result, warnings: [...new Set([...found.warnings, ...result.warnings])] };
      });
    },
  };
}

export const claudeAdapter = createClaudeAdapter();
