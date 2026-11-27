import { getSessionGraph, api, getSessionInfo, summarizeMessages, type RawMessage } from '../opencode';
import { extractContent } from '../search';
import { digest, identity } from './common';
import type { ImportedMessage, SessionAdapter } from './types';
import { opencodeEvents } from './opencode-events';
import { messageMetadata, openCodeUsage } from '../usage';

export function openCodeMessage(raw: RawMessage, sessionID: string): ImportedMessage {
  const content = extractContent([raw]), detail = summarizeMessages(sessionID, [raw], null);
  const message: ImportedMessage = { id: raw.id, time: raw.time?.created || 0, role: raw.type === 'user' ? 'user' : raw.type === 'assistant' ? 'assistant' : 'system',
    fragments: content.fragments, files: detail.files, tools: detail.tools.map(tool => tool.name), snapshots: detail.snapshotSteps, partial: content.truncated };
  message.metadata = messageMetadata({ ...raw, stopReason: raw.finish });
  if (raw.type === 'assistant') message.usage = openCodeUsage(raw.tokens, raw.cost, raw.id);
  if (detail.locations.length) message.locations = detail.locations;
  message.events = opencodeEvents(raw, message);
  return message;
}

export const opencodeAdapter: SessionAdapter = {
  id: 'opencode', name: 'OpenCode', description: 'Local authenticated service · sessions, forks, children, and snapshots',
  capabilities: { history: true, forks: true, children: true, files: true },
  async detect() { try { await api('/api/info', AbortSignal.timeout(3000)); return true; } catch { return false; } },
  async discover() {
    const data = await getSessionGraph(true);
    return {
      projects: data.projects.map((p) => ({ ...p, id: identity('opencode', p.id) })), warnings: data.warnings,
      sessions: data.sessions.map((s) => ({ locator: {}, revision: digest([5, s.updated, s.created, s.directory, s.tokens, s.cost, s.usage]), session: {
        ...s, source: 'opencode', nativeID: s.id, id: identity('opencode', s.id), projectID: identity('opencode', s.projectID),
        parentID: s.parentID ? identity('opencode', s.parentID) : undefined, forkID: s.forkID ? identity('opencode', s.forkID) : undefined,
      } })),
    };
  },
  async read(candidate, cursor) {
    const params = new URLSearchParams({ limit: '60' });
    if (cursor) params.set('cursor', cursor); else params.set('order', 'desc');
    const page = await api<{ data: RawMessage[]; cursor?: { next?: string } }>(`/api/session/${encodeURIComponent(candidate.session.nativeID!)}/message?${params}`);
    if (!Array.isArray(page.data)) throw new Error('Unsupported OpenCode history response');
    if (!page.cursor?.next) {
      const current = await getSessionInfo(candidate.session.nativeID!);
      if (current.time.updated !== candidate.session.updated) throw new Error('Session changed during import; import again to capture its latest messages.');
    }
    return { cursor: page.cursor?.next || undefined, messages: page.data.map(raw => openCodeMessage(raw, candidate.session.id)) };
  },
};
