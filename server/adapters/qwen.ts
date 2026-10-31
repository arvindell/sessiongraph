import { homedir } from 'node:os';
import { join } from 'node:path';
import { blankMessage } from './common';
import { eventFor, eventText } from '../events';
import { jsonLines, localFileAdapter, object, text, time } from './local-files';
import { googleMessage, successfulEdits } from './local-messages';

export const qwenAdapter = localFileAdapter({
  id: 'qwen-code', name: 'Qwen Code', description: 'Local project chat records · tool results, forks, and child sessions',
  capabilities: { history: true, forks: true, children: true, files: true },
  roots: () => [join(process.env.SESSIONGRAPH_QWEN_HOME || process.env.QWEN_RUNTIME_DIR || process.env.QWEN_HOME || join(homedir(), '.qwen'), 'projects')],
  match: path => /^[^/]+\/chats\/[^/]+\.jsonl$/.test(path),
  parse(path, files) {
    const { rows, partial } = jsonLines(files.get(path)!);
    const first = rows.find(r => text(r.sessionId)); if (!first) throw new Error('Unsupported Qwen history.');
    if (rows.some(r => r.sessionId && r.sessionId !== first.sessionId)) throw new Error('Mixed session identities.');
    const messages = rows.map((raw, index) => {
      const id = text(raw.uuid) || `record:${index}`;
      if (raw.message && !['agent_message', 'agent_mention', 'notification'].includes(raw.subtype)) {
        const message = googleMessage({ id, timestamp: raw.timestamp, role: raw.type === 'assistant' ? 'assistant' : raw.type === 'user' ? 'user' : 'tool', toolCallId: raw.toolCallResult?.callId, content: object(raw.message).parts }, id);
        // A Google function response alone does not prove execution succeeded.
        for (const event of message.events || []) if (event.kind === 'tool_result') { event.status = raw.toolCallResult?.status === 'success' ? 'completed' : raw.toolCallResult?.status === 'error' ? 'failed' : 'unknown'; event.nativeType = text(raw.toolCallResult?.status); }
        return message;
      }
      const message = blankMessage(id, time(raw.timestamp), 'system');
      message.events = [eventFor(message, 'event', /compression/.test(raw.subtype) ? 'compaction' : 'event', text(raw.subtype) || text(raw.type) || 'Qwen event', eventText(raw.systemPayload ?? raw.message), { nativeType: text(raw.subtype) || text(raw.type), parentID: text(raw.parentUuid) || undefined })];
      return message;
    });
    successfulEdits(messages, ['write_file', 'edit', 'replace']);
    const latest = [...rows].reverse(), parent = rows.find(r => r.subtype === 'parent_session')?.systemPayload?.parentSessionId;
    const title = latest.find(r => r.subtype === 'custom_title')?.systemPayload?.customTitle;
    return { nativeID: first.sessionId, messages, partial, parent: text(parent) || undefined, fork: text(rows.find(r => r.forkedFrom?.sessionId)?.forkedFrom?.sessionId) || undefined,
      session: { directory: text(first.cwd), created: time(first.timestamp), title: text(title), model: text(latest.find(r => r.model)?.model) || text(latest.find(r => r.subtype === 'session_model')?.systemPayload?.modelId) || 'Unknown model', nativeResume: Boolean(first.cwd) && !process.env.SESSIONGRAPH_QWEN_HOME },
      note: 'Local Qwen chat records, including compaction and branch events in source order. Parent and fork links use recorded session IDs. Managed-daemon-only and binary history may be unavailable.' };
  },
});
