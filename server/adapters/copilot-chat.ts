import { homedir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addText, blankMessage } from './common';
import { eventFor, eventText } from '../events';
import { historyFiles, localFileAdapter, object, text, time, type Raw } from './local-files';
import type { ImportedMessage } from './types';
import type { TimelineEvent } from '@sessiongraph/core/timeline';
import { vscodeChatLog } from './vscode-chat-log';
import { sourcePath } from '../source-paths';

/** These are VS Code's own chat stores, rather than the extension's globalStorage. */
export function copilotChatRoots(platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const path = platform === 'win32' ? win32 : posix;
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA || path.join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || path.join(home, '.config');
  const override = sourcePath('copilot-chat') || env.SESSIONGRAPH_COPILOT_CHAT_USER_DATA_DIR;
  const users = override ? [path.join(override, 'User')]
    : [...['Code', 'Code - Insiders'].map(app => path.join(base, app, 'User')), ...['.vscode-server', '.vscode-server-insiders'].map(app => path.join(home, app, 'data', 'User'))];
  return users.flatMap(user => [path.join(user, 'workspaceStorage'), path.join(user, 'globalStorage', 'emptyWindowChatSessions')]);
}

/** Decode recorded local URIs independently of the machine doing the import.
 * Remote authorities stay URIs; treating their paths as local folders is unsafe.
 */
export function vscodeChatPath(value: unknown): string {
  const raw = object(value);
  if (raw.scheme) {
    if (raw.scheme !== 'file') return `${text(raw.scheme)}://${text(raw.authority)}${text(raw.path)}`;
    const path = text(raw.path);
    return raw.authority ? `\\\\${raw.authority}${path.replace(/\//g, '\\')}` : /^\/[a-z]:\//i.test(path) ? path.slice(1).replace(/\//g, '\\') : path;
  }
  const uri = text(value);
  if (!uri.startsWith('file:')) return uri;
  try {
    const url = new URL(uri);
    return fileURLToPath(url, { windows: Boolean(url.hostname && url.hostname !== 'localhost') || /^\/[a-z]:/i.test(decodeURIComponent(url.pathname)) });
  } catch { return ''; }
}

const markdown = (value: unknown) => typeof value === 'string' ? value : text(object(value).value);
const recordedTime = (value: unknown): Pick<TimelineEvent, 'time' | 'timeSource'> => ({ time: time(value) || null, timeSource: time(value) ? 'recorded' : 'unknown' });

function responsePart(message: ImportedMessage, value: unknown, index: number) {
  const part = object(value), kind = text(part.kind), id = `part:${index}`;
  const fields: Partial<TimelineEvent> = { nativeType: kind || 'markdown', nativeID: text(part.id) || undefined };
  if (typeof value === 'string' || !kind && typeof part.value === 'string' || kind === 'markdownContent' || kind === 'markdownVuln') {
    const content = markdown(kind ? part.content : value);
    message.events!.push(eventFor(message, id, 'message', 'Assistant message', content, fields));
    addText(message, content, 'Assistant');
  } else if (kind === 'thinking') {
    const content = Array.isArray(part.value) ? part.value.filter(v => typeof v === 'string').join('\n') : markdown(part.value);
    message.events!.push(eventFor(message, id, 'reasoning', 'Recorded reasoning', content, { ...fields, ...recordedTime(part.reasoningStartedAt) }));
    addText(message, content, 'Tool');
  } else if (kind === 'toolInvocationSerialized') {
    const data = object(part.toolSpecificData), command = object(data.commandLine), details = object(part.resultDetails);
    const name = text(part.toolId) || 'Tool', callID = text(part.toolCallId) || undefined;
    const input = eventText(data.rawInput ?? command.userEdited ?? command.toolEdited ?? command.original ?? details.input);
    const denied = part.isConfirmed === false || [0, 5].includes(object(part.isConfirmed).type);
    const status = denied || part.resultError ? 'failed' : part.isComplete === true ? 'completed' : 'unknown';
    const correlation = { ...fields, callID, parentID: text(part.subAgentInvocationId) || undefined };
    message.events!.push(eventFor(message, `${id}:call`, 'tool_call', name, markdown(part.invocationMessage), { ...correlation, ...recordedTime(part.startedAt), input, status: 'unknown' }));
    message.tools.push(name); addText(message, input, 'Tool');
    if (part.isComplete || part.resultError || denied) {
      const output = eventText(part.resultError || (denied ? 'Tool invocation was denied or skipped.' : details.output ?? part.resultDetails ?? markdown(part.pastTenseMessage)));
      message.events!.push(eventFor(message, `${id}:result`, 'tool_result', name, markdown(part.pastTenseMessage), { ...correlation, ...recordedTime(part.completedAt), role: 'tool', output, status }));
      addText(message, output, 'Tool');
    } else message.partial = true;
  } else {
    // References and proposed text edits describe UI state, not committed file changes.
    message.events!.push(eventFor(message, id, 'event', kind || 'Unsupported chat content', eventText(part), { ...fields, partial: true }));
    message.partial = true;
  }
}

function chatMessages(requests: Raw[]): ImportedMessage[] {
  return requests.flatMap((request, index) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Unsupported VS Code chat request.');
    const requestID = text(request.requestId) || `request:${index}`;
    const injected = Boolean(request.isSystemInitiated || request.hiddenFromTranscript || request.requestHiddenFromTranscript);
    const user = blankMessage(requestID, time(request.timestamp), injected ? 'system' : 'user');
    const content = typeof request.message === 'string' ? request.message : text(object(request.message).text);
    user.events = [eventFor(user, 'message', injected ? 'event' : 'message', injected ? 'Injected message' : 'User message', content, { nativeID: requestID, ...recordedTime(request.timestamp) })];
    addText(user, content, injected ? 'Tool' : 'You');
    if (request.variableData?.variables?.length) user.partial = true;
    const messages = [user];
    if (request.response !== undefined || request.result?.errorDetails || request.responseErrorDetails || request.editedFileEvents?.length) {
      const assistant = blankMessage(text(request.responseId) || `response:${requestID}`, time(request.responseTimestamp), 'assistant');
      assistant.events = [];
      const parts = Array.isArray(request.response) ? request.response : request.response == null ? [] : [request.response];
      if (parts.length > 200) assistant.partial = true;
      parts.slice(0, 200).forEach((part, i) => responsePart(assistant, part, i));
      const error = request.result?.errorDetails || request.responseErrorDetails;
      if (error) {
        const content = markdown(error.message) || eventText(error);
        assistant.events.push(eventFor(assistant, 'error', 'error', 'Response error', content)); addText(assistant, content, 'Tool');
      }
      for (const edit of Array.isArray(request.editedFileEvents) ? request.editedFileEvents : []) {
        const path = vscodeChatPath(edit?.uri);
        // VS Code's Keep=1 is explicit acceptance. Undo and user modifications
        // are not evidence of an accepted agent edit; tool arguments never are.
        if (edit?.eventKind === 1 && path) { assistant.files.push({ path, source: 'file change', steps: 1 }); addText(assistant, path, 'File'); }
      }
      if (request.isCanceled || [0, 2, 4].includes(request.modelState?.value)) assistant.partial = true;
      messages.push(assistant);
    }
    return messages;
  });
}

const match = (path: string) => /^(?:[^/]+\/chatSessions\/)?[^/]+\.jsonl?$/.test(path) && !['index.json', 'workspace.json'].includes(path);
const roots = () => copilotChatRoots();
const filesAdapter = localFileAdapter({
  id: 'copilot-chat', name: 'GitHub Copilot Chat (VS Code)', description: 'VS Code and Insiders saved chats · local JSON snapshots and JSONL logs',
  capabilities: { history: true, forks: false, children: false, files: true }, roots, match,
  authoritativeIdentity: path => path.endsWith('.jsonl') ? basename(path, '.jsonl') : undefined,
  extras: path => [...(basename(dirname(path)) === 'chatSessions' ? [join(dirname(dirname(path)), 'workspace.json')] : []), ...(path.endsWith('.json') ? [`${path}l`] : [])],
  parse(path, files) {
    // Load the authoritative sibling even when discovering a legacy .json. A
    // damaged/newer log must never downgrade saved history to a stale snapshot.
    const log = path.endsWith('.jsonl') ? path : `${path}l`;
    const data = files.has(log) ? vscodeChatLog(files.get(log)!) : object(JSON.parse(files.get(path)!));
    if (!text(data.sessionId) || !Array.isArray(data.requests) || data.version !== undefined && ![1, 2, 3].includes(data.version)) throw new Error('Unsupported VS Code chat history.');
    if (data.sessionId !== basename(path).replace(/\.jsonl?$/, '')) throw new Error('VS Code chat identity mismatch.');
    if (!data.requests.length) return; // Empty windows and drafts are not conversations.
    if (data.requests.length > 25_000) throw new Error('Chat exceeds the 50,000-message limit.');
    const workspacePath = join(dirname(dirname(path)), 'workspace.json');
    const workspace = files.has(workspacePath) ? object(JSON.parse(files.get(workspacePath)!)) : {};
    const messages = chatMessages(data.requests);
    const model = [...data.requests].reverse().find(r => text(r.modelId));
    return { nativeID: data.sessionId, messages,
      session: { title: text(data.customTitle) || text(data.computedTitle), created: time(data.creationDate), directory: vscodeChatPath(data.workingDirectory || workspace.folder), model: text(model?.modelId) || 'Unknown model' },
      note: 'Persisted VS Code Chat UI history, including Copilot participants. Attachments, pre-compaction content, and transient UI state may be absent. Accepted-edit records provide file evidence; proposed edits and references do not. Multi-root workspaces without an explicit working directory remain unassigned. Tool subagent IDs are event correlations, not session ancestry.' };
  },
});

export const copilotChatAdapter = { ...filesAdapter, async detect() { return (await historyFiles(roots(), match)).files.length > 0; } };
