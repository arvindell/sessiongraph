import { basename, dirname, join } from 'node:path';
import { localFileAdapter, json, jsonLines, object, text, time, type LocalHistory, type Raw } from './local-files';
import { piHistory } from './pi';
import { acpHistory, ampHistory, codebuffHistory, dshHistory, envelopeHistory, fileID, jcodeHistory, message, nativeText, recordEvent, seconds, sidecar, vibeHistory } from './harness-formats';
import { appPath, configPath, dataPath, envHome, harnessRoots, homePath, tokscalePath } from './harness-paths';
import type { SessionAdapter } from './types';
import { devinDesktopHistory, kiroHistory, muxHistory } from './harness-extra-formats';

interface FileHarness {
  id: string;
  name: string;
  roots: () => string[];
  match?: (path: string) => boolean;
  extras?: (path: string) => string[];
  parse?: (path: string, files: Map<string, string>) => LocalHistory | undefined;
  description?: string;
  history?: boolean;
}
const piParse = (path: string, files: Map<string, string>) => piHistory(files.get(path)!);
const jsonl = (path: string) => path.endsWith('.jsonl');
const piSources: FileHarness[] = [
  { id: 'prime-agent', name: 'Prime Agent', roots: () => [process.env.PRIME_AGENT_SESSION_DIR || process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR || envHome('PRIME_AGENT_CODING_AGENT_DIR', '.prime/agent', 'sessions'), envHome('PRIME_AGENT_CODING_AGENT_DIR', '.prime/agent', 'session-artifacts')] },
  { id: 'omp', name: 'Oh My Pi', roots: () => [envHome('PI_CODING_AGENT_DIR_OMP', '.omp/agent', 'sessions')] },
  { id: 'senpi', name: 'Senpi / OmO Native', roots: () => [envHome('SENPI_CODING_AGENT_DIR', '.senpi/agent', 'sessions'), homePath('.omo/agent/sessions')] },
  { id: 'kimchi', name: 'Kimchi', roots: () => [join(process.env.KIMCHI_CODING_AGENT_DIR || configPath('kimchi/harness'), 'sessions')] },
  { id: 'gajae', name: 'Gajae-Code', roots: () => [join(process.env.GJC_CODING_AGENT_DIR || (process.env.GJC_CONFIG_DIR || process.env.PI_CONFIG_DIR ? join(process.env.GJC_CONFIG_DIR || process.env.PI_CONFIG_DIR!, 'agent') : homePath('.gjc/agent')), 'sessions'), dataPath('gjc/sessions')] },
].map(s => ({ ...s, parse: piParse }));

export const openclawRoots = () => [envHome('OPENCLAW_STATE_DIR', '.openclaw', 'agents'), ...['.clawdbot', '.moltbot', '.moldbot'].map(p => homePath(p, 'agents'))];
export const promaRoots = () => ['.proma', '.proma-dev'].flatMap(p => ['agent-sessions', 'sdk-config/sessions', 'sdk-config/projects'].map(s => homePath(p, s)));

function kimiHistory(path: string, files: Map<string, string>): LocalHistory {
  const { rows } = jsonLines(files.get(path)!);
  const folder = dirname(path), id = basename(folder), agent = basename(dirname(folder)) === 'agents';
  const nativeID = agent ? `${basename(dirname(dirname(folder)))}/agent/${id}` : id;
  const wire = join(folder, 'wire.jsonl'), wireRows = files.has(wire) ? jsonLines(files.get(wire)!).rows : [];
  const messages = rows.flatMap((r, i) => { const m = message(r, nativeText(r.id) || `context:${i}`); return m ? [m] : []; });
  if (!messages.length) throw new Error('No readable Kimi context messages.');
  return { nativeID, messages, partial: true, session: { created: seconds(wireRows.find(r => r.timestamp)?.timestamp) },
    note: 'Kimi persisted context, including tool messages. Earlier compacted context and wire-only activity may be absent. Context messages carry no reliable turn times; wire times are used only for session placement.' };
}

function museHistory(path: string, files: Map<string, string>): LocalHistory {
  const { rows } = jsonLines(files.get(path)!);
  const meta = rows.find(r => r.payload_type === 'runtime.session.metadata');
  const ids = new Set(rows.map(r => text(r.stream?.id)).filter(Boolean));
  if (!meta || ids.size > 1) throw new Error('Unsupported Muse stream.');
  const nativeID = [...ids][0] || basename(dirname(path));
  const messages = rows.flatMap((r, i) => {
    const event = object(r.payload?.event), body = object(event.message);
    const at = typeof r.recorded_at === 'number' && r.recorded_at >= 1e15 ? r.recorded_at / 1000 : typeof r.recorded_at === 'number' && r.recorded_at < 1e12 ? seconds(r.recorded_at) : time(r.recorded_at);
    const m = message(body, nativeText(r.sequence) || `record:${i}`, at);
    if (m) return [m];
    return text(event.kind) ? [recordEvent(r, nativeText(r.sequence) || `record:${i}`, event.kind, at, event.text)] : [];
  });
  return { nativeID, messages, partial: true, session: { directory: text(meta.payload?.record?.workspace_root), model: text(meta.payload?.record?.model_id) || 'Unknown model', provider: text(meta.payload?.record?.provider_id) },
    note: 'Muse runtime session events and recognized message payloads. Unsupported event content remains partial; no session ancestry is inferred from timestamps.' };
}

function junieHistory(path: string, files: Map<string, string>): LocalHistory {
  const { rows } = jsonLines(files.get(path)!);
  const messages = rows.flatMap((r, i) => {
    const e = object(r.event?.agentEvent || r.event), kind = text(e.kind);
    if (!kind || /State|Snapshot/.test(kind)) return [];
    return [recordEvent(r, text(r.id) || `event:${i}`, kind, r.timestampMs, e.text ?? e.prompt ?? e.message)];
  });
  if (!messages.length) throw new Error('No supported Junie events.');
  return { nativeID: basename(dirname(path)), messages, partial: true, note: 'Junie recorded agent events. State snapshots and opaque event bodies are omitted; events without an authoritative message role are not counted as user turns.' };
}

function augmentHistory(path: string, files: Map<string, string>): LocalHistory {
  const r = object(json(files.get(path)!));
  if (!text(r.sessionId) || !Array.isArray(r.chatHistory)) throw new Error('Unsupported Augment session.');
  const messages = r.chatHistory.flatMap((turn: Raw, i: number) => {
    const exchange = object(turn.exchange), id = nativeText(turn.sequenceId) || `turn:${i}`;
    return [recordEvent(turn, id, turn.completed === true ? 'Completed exchange' : 'Incomplete exchange', turn.finishedAt, exchange.response_text)];
  });
  return { nativeID: r.sessionId, messages, partial: true, session: { title: text(r.title), created: time(r.created), model: text(r.agentState?.modelId) || 'Unknown model' }, note: 'Augment saved exchange records. Typed response-node payloads and absent prompts are not reconstructed into conversations.' };
}

function fxHistory(path: string, files: Map<string, string>): LocalHistory {
  const usage = object(json(files.get(path)!)), meta = sidecar(files, join(dirname(path), 'session.json'));
  const id = text(usage.session_id) || text(meta.id);
  if (!id || !usage.snapshot || meta.id && meta.id !== id) throw new Error('Unsupported Fx session metadata.');
  return { nativeID: id, messages: [], partial: true, session: { created: time(meta.created_at_ms), directory: text(meta.workspace_root), title: text(meta.title) },
    note: 'Fx session metadata only. The usage snapshot is cumulative; it contains no conversation or message timestamps.' };
}

const definitions: FileHarness[] = [
  ...piSources,
  { id: 'kiro', name: 'Kiro', roots: () => [homePath('.kiro/sessions'), appPath('Kiro/User/globalStorage/kiro.kiroagent')], match: p => p.endsWith('/session.json') || /^cli\/[^/]+\.json$/.test(p), extras: p => [basename(p) === 'session.json' ? join(dirname(p), 'messages.jsonl') : p.replace(/\.json$/, '.jsonl')], parse: kiroHistory },
  { id: 'mux', name: 'Mux', roots: () => [envHome('MUX_ROOT', '.mux', 'sessions')], match: p => p.endsWith('/chat.jsonl'), extras: p => [join(dirname(p), 'chat-archive.jsonl')], parse: muxHistory },
  { id: 'devin-desktop', name: 'Devin Desktop', roots: () => [appPath('Devin/User/acp-events')], match: p => /\.(ndjson|jsonl)$/.test(p), parse: devinDesktopHistory },
  { id: 'openclaw', name: 'OpenClaw', roots: openclawRoots, match: p => /(?:^|\/)sessions\/.*\.jsonl(?:\.[\w.-]+)?$/.test(p) || /session-sqlite-import-archive\/.*\.jsonl\./.test(p), parse: piParse },
  { id: 'amp', name: 'Amp', roots: () => [dataPath('amp/threads'), tokscalePath('amp-cache/threads')], match: p => p.endsWith('.json'), parse: ampHistory },
  { id: 'droid', name: 'Factory Droid', roots: () => [envHome('FACTORY_HOME', '.factory', 'sessions')] },
  { id: 'codebuff', name: 'Codebuff', roots: () => process.env.CODEBUFF_DATA_DIR ? [process.env.CODEBUFF_DATA_DIR] : ['manicode', 'manicode-dev', 'manicode-staging'].map(p => configPath(p)), match: p => p.endsWith('/chat-messages.json'), parse: (p, f) => codebuffHistory(p, f, false) },
  { id: 'freebuff', name: 'Freebuff', roots: () => process.env.FREEBUFF_DATA_DIR ? [process.env.FREEBUFF_DATA_DIR] : process.env.CODEBUFF_DATA_DIR ? [process.env.CODEBUFF_DATA_DIR] : ['manicode', 'manicode-dev', 'manicode-staging'].map(p => configPath(p)), match: p => p.endsWith('/chat-messages.json'), parse: (p, f) => codebuffHistory(p, f, true) },
  { id: 'kimi', name: 'Kimi CLI / Code', roots: () => [envHome('KIMI_HOME', '.kimi', 'sessions'), envHome('KIMI_CODE_HOME', '.kimi-code', 'sessions')], match: p => p.endsWith('/context.jsonl'), extras: p => [join(dirname(p), 'wire.jsonl')], parse: kimiHistory },
  { id: 'grok', name: 'Grok Build', roots: () => [envHome('GROK_HOME', '.grok', 'sessions')], match: p => p.endsWith('/updates.jsonl'), parse: (p, f) => acpHistory(p, f.get(p)!) },
  { id: 'jcode', name: 'Jcode', roots: () => [envHome('JCODE_HOME', '.jcode', 'sessions')], match: p => /(?:^|\/)session_[^/]+\.json$/.test(p), extras: p => [p.replace(/\.json$/, '.journal.jsonl')], parse: jcodeHistory },
  { id: 'cherry-studio', name: 'Cherry Studio', roots: () => [appPath('CherryStudio/Data/Agents/.claude/projects'), appPath('CherryStudio/.claude/projects')] },
  { id: 'command-code', name: 'Command Code', roots: () => [homePath('.commandcode/projects')] },
  { id: 'zcode', name: 'ZCode', roots: () => [homePath('.zcode/projects')] },
  { id: 'codebuddy', name: 'CodeBuddy', roots: () => [homePath('.codebuddy/projects')] },
  { id: 'workbuddy', name: 'WorkBuddy', roots: () => [homePath('.workbuddy-ai/projects'), homePath('.workbuddy/projects')] },
  { id: 'proma', name: 'Proma', roots: promaRoots },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', roots: () => [envHome('DSH_HOME', '.dsh', 'sessions')], match: p => /(?:^|\/)session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(p), parse: (p, f) => dshHistory(f.get(p)!) },
  { id: 'aside', name: 'Aside', roots: () => [homePath('.aside/u')], match: p => /^[^/]+\/sessions\/[^/]+\/messages\.jsonl$/.test(p), parse(p, f) { const h = envelopeHistory(p, f.get(p)!); h.nativeID = `${basename(dirname(dirname(dirname(p))))}/${basename(dirname(p))}`; return h; } },
  { id: 'vibe', name: 'Mistral Vibe', roots: () => [envHome('VIBE_HOME', '.vibe', 'logs/session')], match: p => p.endsWith('/meta.json') || /^[^/]+\.json$/.test(p), extras: p => basename(p) === 'meta.json' ? [join(dirname(p), 'messages.jsonl')] : [], parse: vibeHistory },
  { id: 'muse', name: 'Muse Code', roots: () => [dataPath('muse/sessions')], match: p => p.endsWith('/session.jsonl'), parse: museHistory },
  { id: 'junie', name: 'Junie', roots: () => [homePath('.junie/sessions')], match: p => p.endsWith('/events.jsonl'), parse: junieHistory, description: 'Local agent event history · partial conversation coverage' },
  { id: 'augment', name: 'Augment Code', roots: () => [homePath('.augment/sessions')], match: p => p.endsWith('.json'), parse: augmentHistory, description: 'Local exchange records · partial conversation coverage' },
  { id: 'fx', name: 'Fx', roots: () => [homePath('.fx/sessions')], match: p => p.endsWith('/usage-v2.json'), extras: p => [join(dirname(p), 'session.json')], parse: fxHistory, history: false, description: 'Local native session metadata · conversation unavailable in usage snapshots' },
  { id: 'minimax-code', name: 'MiniMax Code', roots: () => [join(process.env.TOKSCALE_HEADLESS_DIR || tokscalePath('headless'), 'mcode')], parse(p, f) {
    const value = f.get(p)!, { rows } = jsonLines(value), ids = new Set(rows.map(r => text(r.sessionId)).filter(Boolean));
    if (ids.size !== 1) throw new Error('Headless capture needs one explicit session identity.');
    const messages = rows.flatMap((r, i) => { const m = message(object(r.message), text(r.message?.id) || `record:${i}`); return m ? [m] : []; });
    return { nativeID: [...ids][0], messages, partial: true, note: 'Previously captured MiniMax stream JSON only; no command is executed. User input and transient streaming records may be absent.' };
  } },
  { id: 'opencodereview', name: 'OpenCodeReview', roots: () => [homePath('.opencodereview/sessions')], parse(p, f) {
    const { rows } = jsonLines(f.get(p)!), header = rows.find(r => r.type === 'session_start');
    if (!header) throw new Error('Unsupported review session.');
    return { nativeID: text(header.session_id || header.sessionId) || fileID(p), messages: rows.filter(r => r.type === 'llm_response').map((r, i) => recordEvent(r, text(r.id) || `response:${i}`, 'Review response', r.timestamp, r.content ?? r.response)), partial: true, session: { directory: text(header.cwd), created: time(header.timestamp) }, note: 'OpenCodeReview saved response events. Usage-only records do not establish conversation text or user prompts.' };
  } },
];

export const fileHarnessAdapters: SessionAdapter[] = definitions.map(source => localFileAdapter({
  ...source, roots: harnessRoots(source.id, source.roots), match: source.match || jsonl,
  description: source.description || 'Local transcript snapshots · bounded, read-only import',
  capabilities: { history: source.history !== false, forks: false, children: false, files: false },
  parse: source.parse || ((p, f) => envelopeHistory(p, f.get(p)!)),
}));
