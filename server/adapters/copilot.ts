import { homedir } from 'node:os';
import { join } from 'node:path';
import { addText, blankMessage } from './common';
import { eventFor, eventText } from '../events';
import { jsonLines, localFileAdapter, object, text, time } from './local-files';

export const copilotAdapter = localFileAdapter({
  id: 'copilot', name: 'GitHub Copilot CLI', description: 'Local session event logs · conversations and completed file edits',
  capabilities: { history: true, forks: false, children: true, files: true },
  roots: () => [join(process.env.SESSIONGRAPH_COPILOT_HOME || join(homedir(), '.copilot'), 'session-state')],
  match: path => /(?:^|\/)events\.jsonl$/.test(path),
  parse(path, files) {
    const { rows, partial } = jsonLines(files.get(path)!);
    const start = rows.find(r => r.type === 'session.start'), meta = object(start?.data);
    if (!text(meta.sessionId)) throw new Error('Unsupported Copilot event log.');
    const toolNames = new Map(rows.filter(r => r.type === 'tool.execution_start').map(r => [r.data?.toolCallId, text(r.data?.toolName)]));
    const messages = rows.filter(r => !r.ephemeral && !['assistant.message_delta', 'assistant.reasoning_delta'].includes(r.type)).map((raw, index) => {
      const data = object(raw.data), kind = text(raw.type), human = kind === 'user.message' && !data.isAutopilotContinuation && !data.source;
      const message = blankMessage(text(raw.id) || `record:${index}`, time(raw.timestamp), human ? 'user' : kind === 'assistant.message' ? 'assistant' : kind.startsWith('tool.') ? 'tool' : 'system');
      if (['user.message', 'assistant.message'].includes(kind)) {
        const content = text(data.content);
        message.events = [eventFor(message, 'message', human || kind === 'assistant.message' ? 'message' : 'event', human ? 'User message' : kind === 'assistant.message' ? 'Assistant message' : 'Injected message', content, { nativeID: text(data.messageId) || undefined, nativeType: kind })];
        addText(message, content, human ? 'You' : kind === 'assistant.message' ? 'Assistant' : 'Tool');
        if (data.attachments?.length || data.encryptedContent || data.reasoningOpaque) message.partial = true;
      } else if (kind === 'tool.execution_start' || kind === 'tool.execution_complete') {
        const call = kind === 'tool.execution_start', name = text(data.toolName) || toolNames.get(data.toolCallId) || 'Tool';
        message.events = [eventFor(message, call ? 'call' : 'result', call ? 'tool_call' : 'tool_result', name, '', { callID: text(data.toolCallId) || undefined, nativeType: kind,
          ...(call ? { input: eventText(data.arguments) } : { output: eventText(data.error || data.result?.detailedContent || data.result?.content) }), status: call ? 'unknown' : data.success === true ? 'completed' : data.success === false ? 'failed' : 'unknown' })];
        if (call) message.tools.push(name);
        addText(message, message.events[0].input || message.events[0].output, 'Tool');
        // fileEdits is the authoritative list of mutations that actually committed,
        // including partial-success executions. Do not infer edits from arguments.
        if (!call) for (const edit of Array.isArray(data.fileEdits) ? data.fileEdits : []) if (text(edit.path)) { message.files.push({ path: edit.path, source: 'file change', steps: 1 }); addText(message, edit.path, 'File'); }
      } else message.events = [eventFor(message, 'event', kind.includes('compaction') ? 'compaction' : kind.includes('reasoning') ? 'reasoning' : kind === 'session.error' ? 'error' : 'event', kind || 'Copilot event', eventText(data), { nativeType: kind, parentID: text(raw.parentId) || undefined })];
      return message;
    });
    const latest = [...rows].reverse();
    return { nativeID: meta.sessionId, messages, partial, parent: text(meta.detachedFromSpawningParentSessionId) || undefined,
      session: { directory: text(meta.context?.cwd), created: time(meta.startTime || start?.timestamp), title: text(latest.find(r => r.type === 'session.title_changed')?.data?.title), model: text(latest.find(r => r.type === 'session.model_change')?.data?.newModel) || text(meta.selectedModel) || 'Unknown model', provider: text(meta.providerId), nativeResume: Boolean(meta.context?.cwd) && !process.env.SESSIONGRAPH_COPILOT_HOME },
      note: 'Persisted Copilot CLI events only. Streaming deltas are excluded in favor of final messages. Tool-call parents are event correlations, not session ancestry. Cloud-only sessions and binary assets are unavailable.' };
  },
});
