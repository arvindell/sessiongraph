import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { eventFor, eventText } from '../events';
import { json, localFileAdapter, object, text, time } from './local-files';
import { conversationMessage, successfulEdits } from './local-messages';
import { sumRecordedTokens } from '../../src/playback-tokens';
import { sourcePath } from '../source-paths';
import { recordedCost, recordedUsage, sessionUsage, sumTokens, sumUsage, tokenCount } from '../usage';

/** UI billing rows are native request records, not conversation turns. */
function taskUsage(value: unknown, source: string) {
  if (!Array.isArray(value)) return;
  const records = new Map<string, NonNullable<ReturnType<typeof recordedUsage>>>();
  value.forEach((row, index) => {
    if (row?.type !== 'say' || row.say !== 'api_req_started' || typeof row.text !== 'string') return;
    let payload;
    try { payload = object(JSON.parse(row.text)); } catch { return; }
    const caches = [payload.cacheReads, payload.cacheWrites];
    // Cline's buckets are disjoint. Roo/Kilo changed this schema historically;
    // without producer-version evidence, nonzero cache overlap stays unknown.
    const includesCache = source === 'cline' ? false : caches.every(value => tokenCount(value) === 0) ? true : null;
    const usage = recordedUsage({ input: payload.tokensIn, output: payload.tokensOut, cacheRead: payload.cacheReads, cacheWrite: payload.cacheWrites,
      total: tokenCount(payload.totalTokens) ?? (includesCache === false ? sumTokens([payload.tokensIn, payload.tokensOut, ...caches])
        : includesCache === true ? sumTokens([payload.tokensIn, payload.tokensOut]) : null),
      inputIncludesCache: includesCache, outputIncludesReasoning: true, cost: recordedCost(payload.cost), costEstimated: true });
    if (usage) records.set(typeof row.id === 'string' ? row.id : row.ts != null ? String(row.ts) : `row:${index}`, usage);
  });
  return sessionUsage(sumUsage([...records.values()]));
}

function editorTaskRoots(extension: string) {
  const home = homedir();
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || join(home, '.config');
  return ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'].map(app => join(base, app, 'User', 'globalStorage', extension, 'tasks'))
    .concat(['.vscode-server', '.vscode-server-insiders'].map(app => join(home, app, 'data', 'User', 'globalStorage', extension, 'tasks')));
}

function taskAdapter(id: string, name: string, extension: string, env: string) {
  const home = () => sourcePath(id) || process.env[env];
  const roots = () => home() ? [join(home()!, 'tasks'), ...(id === 'cline' ? [join(home()!, 'data', 'sessions')] : [])]
    : [...editorTaskRoots(extension), ...(id === 'cline' ? [process.env.CLINE_SESSION_DATA_DIR || join(process.env.CLINE_DATA_DIR || join(process.env.CLINE_DIR || join(homedir(), '.cline'), 'data'), 'sessions')] : [])];
  return localFileAdapter({
    id, name, description: id === 'kilo-code' ? 'VS Code extension task histories · choose Kilo CLI separately' : id === 'cline' ? 'Local extension tasks and CLI/SDK message snapshots' : 'Local VS Code extension task histories',
    capabilities: { history: true, forks: id === 'cline', children: true, files: true }, roots,
    match: path => /^[^/]+\/api_conversation_history\.json$/.test(path) || (id === 'cline' && /^[^/]+\/[^/]+\.messages\.json$/.test(path)),
    extras: path => ['history_item.json', 'task_metadata.json', 'session.json', 'ui_messages.json'].map(file => join(dirname(path), file)),
    parse(path, files) {
      const sdk = path.endsWith('.messages.json'), value = json(files.get(path)!);
      const records = sdk ? object(value).messages : value;
      if (!Array.isArray(records) || (sdk && !text(value.sessionId))) throw new Error('Unsupported task history.');
      const read = (name: string) => object(files.has(join(dirname(path), name)) ? json(files.get(join(dirname(path), name))!) : undefined);
      const history = read('history_item.json'), info = read('session.json'), task = read('task_metadata.json');
      const nativeID = sdk ? value.sessionId : basename(dirname(path));
      if (history.id && history.id !== nativeID || info.session_id && info.session_id !== nativeID) throw new Error('Task metadata identity mismatch.');
      const messages = records.map((raw, index) => {
        const row = object(raw), message = conversationMessage(row, `record:${index}`);
        if (sdk && message.role === 'assistant' && row.metrics) {
          const metrics = object(row.metrics);
          message.usage = recordedUsage({ input: metrics.inputTokens, output: metrics.outputTokens, cacheRead: metrics.cacheReadTokens, cacheWrite: metrics.cacheWriteTokens,
            total: sumTokens([metrics.inputTokens, metrics.outputTokens]), inputIncludesCache: true, outputIncludesReasoning: true,
            cost: recordedCost(metrics.cost), costEstimated: true }, 'message', row.id);
        }
        if (row.isSummary || row.isTruncationMarker || row.type === 'reasoning') {
          message.role = 'system';
          message.events = [eventFor(message, 'summary', row.type === 'reasoning' ? 'reasoning' : 'compaction', row.type === 'reasoning' ? 'Recorded reasoning' : 'Context checkpoint', eventText(row.summary ?? row.content ?? row.text), { partial: Boolean(row.encrypted_content), nativeType: row.type || 'summary' })];
        }
        if (row.reasoning_content) message.events!.push(eventFor(message, 'reasoning', 'reasoning', 'Recorded reasoning', text(row.reasoning_content)));
        if (row.encrypted_content || row.reasoning_details) message.partial = true;
        return message;
      });
      successfulEdits(messages, ['write_to_file', 'apply_diff', 'edit_file', 'write_file', 'replace_in_file', 'editor']);
      const lastModel = [...records].reverse().find(r => r.modelInfo?.id || r.model);
      return { nativeID, messages, partial: !sdk,
        parent: text(history.parentTaskId || info.parent_session_id) || undefined,
        fork: text(info.metadata?.fork?.forkedFromSessionId) || undefined,
        session: { directory: text(history.workspace || info.cwd || info.workspace_root || task.workspace), created: time(info.started_at), title: text(history.task || info.metadata?.title), model: text(lastModel?.modelInfo?.id || lastModel?.model || info.model) || 'Unknown model', provider: text(lastModel?.modelInfo?.provider || info.provider),
          usage: !sdk && files.has(join(dirname(path), 'ui_messages.json')) ? taskUsage(json(files.get(join(dirname(path), 'ui_messages.json'))!), id) : undefined },
        note: sdk ? undefined : 'Earlier and editor-only messages may be missing.' };
    },
  });
}

export const clineAdapter = taskAdapter('cline', 'Cline', 'saoudrizwan.claude-dev', 'SESSIONGRAPH_CLINE_HOME');
export const rooAdapter = taskAdapter('roo-code', 'Roo Code', 'rooveterinaryinc.roo-cline', 'SESSIONGRAPH_ROO_HOME');
export const kiloAdapter = taskAdapter('kilo-code', 'Kilo Code', 'kilocode.kilo-code', 'SESSIONGRAPH_KILO_HOME');

export const continueAdapter = localFileAdapter({
  id: 'continue', name: 'Continue', description: 'Local IDE and CLI session JSON · recorded conversation and tool history',
  capabilities: { history: true, forks: false, children: false, files: false },
  roots: () => [join(sourcePath('continue') || process.env.SESSIONGRAPH_CONTINUE_HOME || process.env.CONTINUE_GLOBAL_DIR || join(homedir(), '.continue'), 'sessions')],
  match: path => /^[^/]+\.json$/.test(path) && path !== 'sessions.json',
  extras: path => [join(dirname(path), 'sessions.json')],
  revisionExtras: false,
  parse(path, files) {
    const value = object(json(files.get(path)!));
    if (!text(value.sessionId) || !Array.isArray(value.history)) throw new Error('Unsupported Continue session.');
    const indexPath = join(dirname(path), 'sessions.json'), index = files.has(indexPath) ? json(files.get(indexPath)!) : [];
    const meta = Array.isArray(index) ? object(index.find(r => r.sessionId === value.sessionId)) : {};
    const messages = value.history.map((item: unknown, i: number) => {
      const row = object(item), raw = object(row.message), message = conversationMessage(raw, `record:${i}`);
      if (row.reasoning?.text) message.events!.push(eventFor(message, 'reasoning', 'reasoning', 'Recorded reasoning', text(row.reasoning.text), { time: time(row.reasoning.startAt) || null, timeSource: time(row.reasoning.startAt) ? 'recorded' : 'unknown' }));
      if (row.conversationSummary) message.events!.push(eventFor(message, 'summary', 'compaction', 'Conversation summary', text(row.conversationSummary)));
      return message;
    });
    const usage = object(value.usage);
    return { nativeID: value.sessionId, messages,
      session: { directory: text(value.workspaceDirectory), title: text(value.title), created: time(meta.dateCreated), model: text(value.chatModelTitle) || 'Unknown model', cost: recordedCost(usage.totalCost), tokens: sumRecordedTokens([usage.promptTokens, usage.completionTokens]),
        usage: sessionUsage(recordedUsage({ input: usage.promptTokens, output: usage.completionTokens, total: sumTokens([usage.promptTokens, usage.completionTokens]),
          inputIncludesCache: true, outputIncludesReasoning: true, cost: recordedCost(usage.totalCost) })) },
    };
  },
});
