import { homedir } from 'node:os';
import { join } from 'node:path';
import { blankMessage } from './common';
import { eventFor, eventText } from '../events';
import { jsonLines, localFileAdapter, text, time } from './local-files';
import { conversationMessage, successfulEdits } from './local-messages';

export const piAdapter = localFileAdapter({
  id: 'pi', name: 'Pi', description: 'Local JSONL sessions · messages, tools, compaction, and branch entries',
  capabilities: { history: true, forks: false, children: false, files: true },
  roots: () => [process.env.SESSIONGRAPH_PI_SESSIONS_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions')],
  match: path => path.endsWith('.jsonl'),
  parse(path, files) {
    const { rows, partial } = jsonLines(files.get(path)!);
    const header = rows[0]; if (header?.type !== 'session' || !text(header.id)) throw new Error('Unsupported Pi session.');
    const messages = rows.slice(1).map((raw, index) => {
      const id = text(raw.id) || `record:${index}`;
      if (raw.type === 'message' && raw.message) {
        const message = conversationMessage({ ...raw.message, id, timestamp: raw.message.timestamp ?? raw.timestamp }, id);
        for (const event of message.events || []) event.parentID = text(raw.parentId) || undefined;
        return message;
      }
      const message = blankMessage(id, time(raw.timestamp), 'system');
      message.events = [eventFor(message, 'entry', ['compaction', 'branch_summary'].includes(raw.type) ? 'compaction' : 'event', text(raw.type) || 'Pi entry', text(raw.summary) || eventText(raw), { nativeType: text(raw.type), parentID: text(raw.parentId) || undefined })];
      return message;
    });
    successfulEdits(messages, ['write', 'edit']);
    const lastModel = [...rows].reverse().find(r => r.type === 'model_change' || r.message?.model);
    return { nativeID: header.id, messages, partial,
      session: { directory: text(header.cwd), created: time(header.timestamp), title: text([...rows].reverse().find(r => r.type === 'session_info')?.name), model: text(lastModel?.modelId || lastModel?.message?.model) || 'Unknown model', provider: text(lastModel?.provider || lastModel?.message?.provider), nativeResume: Boolean(header.cwd) && !process.env.SESSIONGRAPH_PI_SESSIONS_DIR },
      note: 'Raw Pi session history includes all recorded in-file branches, not just the active model context. Entry parent IDs are preserved as event links, not session ancestry. Parent-session file paths do not establish whether a session is a fork or a child. Binary content is omitted.' };
  },
});
