import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { eventFor, eventText } from '../events';
import { json, localFileAdapter, object, text, time } from './local-files';
import { conversationMessage, successfulEdits } from './local-messages';

function editorTaskRoots(extension: string) {
  const home = homedir();
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || join(home, '.config');
  return ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'].map(app => join(base, app, 'User', 'globalStorage', extension, 'tasks'))
    .concat(['.vscode-server', '.vscode-server-insiders'].map(app => join(home, app, 'data', 'User', 'globalStorage', extension, 'tasks')));
}

function taskAdapter(id: string, name: string, extension: string, env: string) {
  const roots = () => process.env[env] ? [join(process.env[env]!, 'tasks'), ...(id === 'cline' ? [join(process.env[env]!, 'data', 'sessions')] : [])]
    : [...editorTaskRoots(extension), ...(id === 'cline' ? [process.env.CLINE_SESSION_DATA_DIR || join(process.env.CLINE_DATA_DIR || join(process.env.CLINE_DIR || join(homedir(), '.cline'), 'data'), 'sessions')] : [])];
  return localFileAdapter({
    id, name, description: id === 'kilo-code' ? 'Legacy VS Code extension task histories · current Kilo stores excluded' : id === 'cline' ? 'Local extension tasks and CLI/SDK message snapshots' : 'Local VS Code extension task histories',
    capabilities: { history: true, forks: id === 'cline', children: true, files: true }, roots,
    match: path => /^[^/]+\/api_conversation_history\.json$/.test(path) || (id === 'cline' && /^[^/]+\/[^/]+\.messages\.json$/.test(path)),
    extras: path => ['history_item.json', 'task_metadata.json', 'session.json'].map(file => join(dirname(path), file)),
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
        session: { directory: text(history.workspace || info.cwd || info.workspace_root || task.workspace), created: time(info.started_at), title: text(history.task || info.metadata?.title), model: text(lastModel?.modelInfo?.id || lastModel?.model || info.model) || 'Unknown model', provider: text(lastModel?.modelInfo?.provider || info.provider) },
        note: sdk ? 'Cline CLI/SDK message snapshots. Metadata is used when a matching session.json exists; database-only workspace, title, and lineage fields remain unknown. Binary attachments are omitted.' : `${name} API-conversation snapshots; UI-only messages, older compacted content, and binary attachments can be absent. XML tool requests alone are not successful edit evidence.${id === 'kilo-code' ? ' Current Kilo CLI and migrated database histories are not imported.' : ''}` };
    },
  });
}

export const clineAdapter = taskAdapter('cline', 'Cline', 'saoudrizwan.claude-dev', 'SESSIONGRAPH_CLINE_HOME');
export const rooAdapter = taskAdapter('roo-code', 'Roo Code', 'rooveterinaryinc.roo-cline', 'SESSIONGRAPH_ROO_HOME');
export const kiloAdapter = taskAdapter('kilo-code', 'Kilo Code', 'kilocode.kilo-code', 'SESSIONGRAPH_KILO_HOME');

export const continueAdapter = localFileAdapter({
  id: 'continue', name: 'Continue', description: 'Local IDE and CLI session JSON · recorded conversation and tool history',
  capabilities: { history: true, forks: false, children: false, files: false },
  roots: () => [join(process.env.SESSIONGRAPH_CONTINUE_HOME || process.env.CONTINUE_GLOBAL_DIR || join(homedir(), '.continue'), 'sessions')],
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
      session: { directory: text(value.workspaceDirectory), title: text(value.title), created: time(meta.dateCreated), model: text(value.chatModelTitle) || 'Unknown model', cost: typeof usage.totalCost === 'number' ? usage.totalCost : null, tokens: typeof usage.promptTokens === 'number' && typeof usage.completionTokens === 'number' ? usage.promptTokens + usage.completionTokens : null },
      note: 'Local Continue conversation snapshots. Missing message times remain unknown. Context attachments and transient tool UI state are not imported; tool outputs are retained when recorded as messages.' };
  },
});
