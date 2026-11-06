import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { historyFiles, object, text, time, type LocalHistory, type Raw } from './local-files';
import { conversationMessage } from './local-messages';
import { message, nativeText, recordEvent, seconds } from './harness-formats';
import { existingDatabases, optionalJSON, rows, sqliteHistoryAdapter, sqliteJSON, type DatabaseHarness } from './sqlite-histories';
import { hasTable } from './sqlite-snapshot';
import { appPath, dataPath, envHome, harnessRoots, homePath } from './harness-paths';
import { openclawRoots } from './harness-files';
import { sourcePath } from '../source-paths';

const parsedContent = (v: unknown) => typeof v === 'string' && /^[\[{]/.test(v.trim()) ? optionalJSON(v) : v;
const millisOrSeconds = (v: unknown) => typeof v === 'number' && v > 0 && v < 10_000_000_000 ? seconds(v) : time(v);
function dbPaths(id: string, defaults: () => string[], match: (path: string) => boolean) {
  return async () => {
    const override = sourcePath(id) || process.env[`SESSIONGRAPH_${id.replace(/-/g, '_').toUpperCase()}_HISTORY_DIR`];
    return override ? (await historyFiles([override], match)).files : existingDatabases(defaults());
  };
}
function sessionHistory(r: Raw, messages: LocalHistory['messages'], note: string): LocalHistory {
  return { nativeID: nativeText(r.id), messages, partial: true,
    session: { title: text(r.title || r.name), directory: text(r.directory || r.cwd || r.working_directory || r.working_dir), created: time(r.created_at), updated: time(r.updated_at), model: text(r.model) || 'Unknown model', provider: text(r.provider || r.provider_name) }, note };
}

const hermes: DatabaseHarness = {
  id: 'hermes', name: 'Hermes Agent',
  paths: async () => (await historyFiles(harnessRoots('hermes', () => [envHome('HERMES_HOME', '.hermes')])(), p => p === 'state.db' || /^profiles\/[^/]+\/state\.db$/.test(p))).files,
  table: 'sessions', key: 'id', fields: ['id', 'title', 'cwd', 'model', 'billing_provider', 'started_at', 'last_activity_at', 'parent_session_id', 'source', 'model_config', 'archived'],
  parse(db, r) {
    const messages = rows(db, 'messages', ['id', 'message_uid', 'role', 'content', 'timestamp', 'tool_call_id', 'tool_calls', 'tool_name', '_compressed_summary'], ['session_id', r.id], 'id').map(m => {
      if (m._compressed_summary) return recordEvent(m, text(m.message_uid) || nativeText(m.id), 'Context summary', seconds(m.timestamp), m.content);
      return conversationMessage({ role: m.role, content: parsedContent(m.content), timestamp: seconds(m.timestamp), tool_call_id: m.tool_call_id, toolCalls: optionalJSON(m.tool_calls), toolName: m.tool_name }, text(m.message_uid) || nativeText(m.id));
    });
    const h = sessionHistory({ ...r, created_at: seconds(r.started_at), updated_at: seconds(r.last_activity_at), provider: r.billing_provider }, messages, 'Hermes saved message rows, including retained summaries. Compression/reset parent links are not subagent ancestry. Session usage aggregates are not used as message times.');
    if (r.source === 'subagent') h.parent = text(r.parent_session_id) || undefined;
    h.fork = text(optionalJSON(r.model_config)._branched_from) || undefined;
    h.session!.archived = r.archived === 1;
    return h;
  },
};

const goose: DatabaseHarness = {
  id: 'goose', name: 'Goose', paths: dbPaths('goose', () => process.env.GOOSE_PATH_ROOT && isAbsolute(process.env.GOOSE_PATH_ROOT) ? [join(process.env.GOOSE_PATH_ROOT, 'data/sessions/sessions.db')] : [dataPath('goose/sessions/sessions.db'), dataPath('Block/goose/sessions/sessions.db'), appPath('goose/sessions/sessions.db'), appPath('Block/goose/sessions/sessions.db'), appPath('Block/goose/data/sessions/sessions.db')], p => p.endsWith('sessions.db')),
  table: 'sessions', key: 'id', fields: ['id', 'name', 'description', 'working_dir', 'created_at', 'updated_at', 'model_config_json', 'provider_name', 'session_type', 'parent_session_id', 'archived_at'],
  parse(db, r) {
    const messages = rows(db, 'messages', ['id', 'message_id', 'role', 'content_json', 'created_timestamp'], ['session_id', r.id], 'id').map(m => {
      const content = sqliteJSON(m.content_json);
      return conversationMessage({ role: m.role, content, timestamp: millisOrSeconds(m.created_timestamp) }, text(m.message_id) || nativeText(m.id));
    });
    const h = sessionHistory({ ...r, name: r.name || r.description, model: optionalJSON(r.model_config_json).model_name }, messages, 'Goose saved conversation rows. Tool/content variants not represented as text are marked partial.');
    if (r.session_type === 'sub_agent') h.parent = text(r.parent_session_id) || undefined;
    h.session!.archived = Boolean(r.archived_at);
    return h;
  },
};

const openclaw: DatabaseHarness = {
  id: 'openclaw', name: 'OpenClaw', paths: async () => (await historyFiles(harnessRoots('openclaw', openclawRoots)(), p => /^[^/]+\/agent\/openclaw-agent\.sqlite$/.test(p))).files,
  table: db => hasTable(db, 'session_windows') ? 'session_windows' : 'sessions', key: 'session_id', fields: ['session_id', 'created_at', 'updated_at', 'model', 'model_provider'],
  parse(db, r) {
    const events = rows(db, 'transcript_events', ['seq', 'event_json', 'event_zstd'], ['session_id', r.session_id], 'seq');
    const messages = events.flatMap(e => {
      const raw = object(sqliteJSON(e.event_json ?? e.event_zstd));
      if (raw.type !== 'message') return [];
      const m = message(object(raw.message), text(raw.id) || `event:${e.seq}`, raw.timestamp ?? raw.message?.timestamp);
      return m ? [m] : [];
    });
    return sessionHistory({ ...r, id: r.session_id, provider: r.model_provider }, messages, 'OpenClaw authoritative transcript events, including zstd payloads. Database sessions take precedence over migrated JSONL copies. Session rollover and event-parent links are not session ancestry.');
  },
};

function forkStore(id: string, name: string, defaultPath: () => string, desktop?: boolean): DatabaseHarness {
  return { id, name, paths: dbPaths(id, () => [defaultPath()], p => /\.(db|sqlite)$/.test(p)), table: 'session', key: 'id',
    fields: ['id', 'title', 'directory', 'time_created', 'time_updated', 'version'],
    parse(db, r) {
      if (desktop !== undefined && text(r.version).startsWith('desktop-') !== desktop) return;
      const messages = rows(db, 'message', ['id', 'data', 'time_created'], ['session_id', r.id], 'time_created').map(m => {
        const body = object(sqliteJSON(m.data));
        let content = body.parts ?? body.content;
        if (hasTable(db, 'part')) content = rows(db, 'part', ['id', 'data'], ['message_id', m.id], 'id').map(p => sqliteJSON(p.data));
        if (Array.isArray(content)) content = content.flatMap(p => {
          if (p.type === 'tool') {
            const call = { type: 'tool_use', id: p.callID, name: p.tool, input: p.state?.input };
            return p.state?.status === 'completed' || p.state?.status === 'error' ? [call, { type: 'tool_result', tool_use_id: p.callID, content: p.state.output ?? p.state.error, is_error: p.state.status === 'error' }] : [call];
          }
          return [p.type === 'reasoning' ? { type: 'thinking', thinking: p.text } : p];
        });
        return conversationMessage({ ...body, content, timestamp: body.time?.created ?? m.time_created }, text(m.id));
      });
      return sessionHistory({ ...r, created_at: r.time_created, updated_at: r.time_updated }, messages, `${name} native session/message/part tables. Only this harness's database is read; ancestry semantics not explicitly exposed by this format remain unknown.`);
    },
  };
}

const zed: DatabaseHarness = {
  id: 'zed', name: 'Zed Agent', paths: dbPaths('zed', () => [process.platform === 'darwin' ? appPath('Zed/threads/threads.db') : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homePath('AppData/Local'), 'Zed/threads/threads.db') : dataPath('zed/threads/threads.db')], p => p.endsWith('threads.db')),
  table: 'threads', key: 'id', fields: ['id', 'summary', 'created_at', 'updated_at', 'data_type', 'data', 'folder_paths'],
  parse(db, r) {
    if (!['json', 'zstd'].includes(r.data_type)) throw new Error('Unsupported Zed encoding.');
    const body = object(sqliteJSON(r.data));
    if (body.imported === true) return;
    if (!Array.isArray(body.messages)) throw new Error('Unsupported Zed thread.');
    const messages = body.messages.map((raw: Raw, i: number) => {
      const user = object(raw.User), agent = object(raw.Agent), b = raw.User ? user : agent;
      if (!raw.User && !raw.Agent) return recordEvent(raw, `message:${i}`, 'Context checkpoint', 0, raw.Compaction?.Summary);
      const content = (Array.isArray(b.content) ? b.content : []).map((p: Raw) => typeof p.Text === 'string' ? { type: 'text', text: p.Text } : p.Thinking ? { type: 'thinking', thinking: p.Thinking.text } : p.ToolUse ? { type: 'tool_use', ...p.ToolUse } : { type: 'unsupported' });
      return conversationMessage({ role: raw.User ? 'user' : 'assistant', content }, text(b.id) || `message:${i}`);
    });
    const folders = optionalJSON(r.folder_paths);
    return sessionHistory({ ...r, title: r.summary || body.title, directory: Array.isArray(folders) && folders.length === 1 ? folders[0] : '', model: body.model?.model, provider: body.model?.provider }, messages, 'Zed native thread messages, JSON or zstd. Native message times are absent in this format; no timing is invented. Imported/shared copies and external ACP histories are excluded from this native-thread store.');
  },
};

const devin: DatabaseHarness = {
  id: 'devin', name: 'Devin CLI', paths: dbPaths('devin', () => [dataPath('devin/cli/sessions.db')], p => p.endsWith('sessions.db')),
  table: 'sessions', key: 'id', fields: ['id', 'working_directory', 'model', 'title', 'created_at', 'last_activity_at'],
  parse(db, r) {
    const messages = rows(db, 'message_nodes', ['node_id', 'chat_message', 'created_at'], ['session_id', r.id], 'row_id').flatMap(m => {
      const raw = object(sqliteJSON(m.chat_message)), result = message(raw, nativeText(m.node_id), millisOrSeconds(m.created_at));
      return result ? [result] : [recordEvent(raw, nativeText(m.node_id), 'Devin message node', millisOrSeconds(m.created_at))];
    });
    return sessionHistory({ ...r, created_at: millisOrSeconds(r.created_at), updated_at: millisOrSeconds(r.last_activity_at) }, messages, 'Devin saved message nodes. All retained in-session branches are included; node-parent edges are not session ancestry.');
  },
};

const crushDirectories = new Map<string, string>();
const crush: DatabaseHarness = {
  id: 'crush', name: 'Crush', table: 'sessions', key: 'id', fields: ['id', 'title', 'created_at', 'updated_at', 'cost'],
  paths: async () => {
    const override = sourcePath('crush') || process.env.SESSIONGRAPH_CRUSH_HISTORY_DIR;
    if (override) return (await historyFiles([override], p => p.endsWith('crush.db'))).files;
    const registry = join(process.env.CRUSH_GLOBAL_DATA || dataPath('crush'), 'projects.json');
    try {
      const stat = await lstat(registry); if (!stat.isFile() || stat.size > 2_000_000) throw new Error('Unsupported Crush registry.');
      const raw = JSON.parse(await readFile(registry, 'utf8'));
      const paths: string[] = [];
      for (const p of Array.isArray(raw.projects) ? raw.projects.slice(0, 20_000) : []) {
        if (!isAbsolute(text(p.path)) || !text(p.data_dir)) continue;
        const path = join(isAbsolute(p.data_dir) ? p.data_dir : join(p.path, p.data_dir), 'crush.db');
        paths.push(path); crushDirectories.set(path, p.path);
      }
      return existingDatabases(paths);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  },
  parse(db, r, path) {
    const messages = rows(db, 'messages', ['id', 'role', 'parts', 'created_at', 'is_summary_message'], ['session_id', r.id], 'created_at').map(m => {
      const parts = sqliteJSON(m.parts);
      const content = Array.isArray(parts) ? parts.map(p => p.data && typeof p.data === 'object' ? { type: p.type, ...p.data } : p) : [];
      if (m.is_summary_message) return recordEvent(m, text(m.id), 'Context summary', millisOrSeconds(m.created_at), content);
      return conversationMessage({ role: m.role, content, timestamp: millisOrSeconds(m.created_at) }, text(m.id));
    });
    const h = sessionHistory({ ...r, directory: crushDirectories.get(path) || '', created_at: millisOrSeconds(r.created_at), updated_at: millisOrSeconds(r.updated_at) }, messages, 'Crush per-project saved message parts. Session cost is retained when recorded; unreliable token counters remain unknown.');
    h.session!.cost = typeof r.cost === 'number' && r.cost >= 0 ? r.cost : null;
    return h;
  },
};

const octofriend: DatabaseHarness = {
  id: 'octofriend', name: 'Octofriend', paths: dbPaths('octofriend', () => [homePath('.local/share/octofriend/sqlite.db')], p => p.endsWith('sqlite.db')),
  table: 'trees', key: 'id', fields: ['id', 'name', 'cwd', 'updated_at'],
  parse(db, r) {
    const nodes = rows(db, 'tree_nodes', ['id', 'history_item_id', 'parent_id', 'created_at'], ['tree_id', r.id], 'id');
    const messages: LocalHistory['messages'] = []; let bytes = 0;
    for (const node of nodes) {
      const item = rows(db, 'history_items', ['llm_ir_id'], ['id', node.history_item_id], undefined, 1)[0];
      if (!item?.llm_ir_id) continue;
      const row = rows(db, 'llm_irs', ['json'], ['id', item.llm_ir_id], undefined, 1)[0];
      bytes += text(row?.json).length; if (bytes > 32_000_000) throw new Error('Octofriend session exceeds the snapshot limit.');
      const payload = object(sqliteJSON(row?.json));
      if (payload.version !== 'octo-llm-ir/v1') throw new Error('Unsupported Octofriend IR version.');
      const ir = object(payload.ir), content = Array.isArray(ir.content) ? ir.content.map((p: Raw) => p.type === 'text' ? { type: 'text', text: p.content } : p) : ir.content;
      const m = message({ ...ir, content, role: ir.role === 'tool-output' ? 'tool' : ir.role }, nativeText(node.id), node.created_at);
      messages.push(m || recordEvent(ir, nativeText(node.id), text(ir.role), node.created_at));
    }
    const h = sessionHistory({ ...r, created_at: nodes[0]?.created_at }, messages, 'Octofriend native history trees and versioned IR. Retained branches are preserved; nested subagent trajectories and unsupported IR variants are partial. Provider attribution remains with the harness.');
    return h;
  },
};

const unsloth: DatabaseHarness = {
  id: 'unsloth', name: 'Unsloth Studio', paths: dbPaths('unsloth', () => [envHome('UNSLOTH_STUDIO_HOME', '.unsloth/studio', 'studio.db')], p => p.endsWith('studio.db')),
  table: 'chat_threads', key: 'id', fields: ['id', 'title', 'model_id', 'created_at', 'updated_at', 'archived', 'forked_from_thread_id'],
  parse(db, r) {
    const messages = rows(db, 'chat_messages', ['id', 'role', 'content_json', 'created_at'], ['thread_id', r.id], 'created_at').flatMap(row => {
      const m = message({ role: row.role, content: sqliteJSON(row.content_json) }, text(row.id), seconds(row.created_at)); return m ? [m] : [];
    });
    const h = sessionHistory({ ...r, model: r.model_id, created_at: seconds(r.created_at), updated_at: seconds(r.updated_at) }, messages, 'Unsloth Studio native chat threads and message content. Content-free API usage, training runs, attachments, and unsupported tool blocks are excluded.');
    h.fork = text(r.forked_from_thread_id) || undefined; h.session!.archived = r.archived === 1;
    return h;
  },
};

const kiro: DatabaseHarness = {
  id: 'kiro', name: 'Kiro', paths: dbPaths('kiro', () => [appPath('kiro-cli/data.sqlite3'), dataPath('kiro-cli/data.sqlite3')], p => p.endsWith('data.sqlite3')),
  table: 'conversations_v2', key: 'conversation_id', fields: ['key', 'conversation_id', 'value'],
  parse(db, r) {
    const body = object(sqliteJSON(r.value));
    if (!Array.isArray(body.history)) throw new Error('Unsupported Kiro conversation.');
    const messages = body.history.flatMap((turn: Raw, i: number) => {
      const result: LocalHistory['messages'] = [], input = object(turn.user?.content), output = object(turn.assistant?.Response || turn.assistant?.ToolUse);
      if (typeof input.Prompt?.prompt === 'string') result.push(conversationMessage({ role: 'user', content: input.Prompt.prompt }, `turn:${i}:user`));
      if (input.ToolUseResults) result.push(conversationMessage({ role: 'tool', content: input.ToolUseResults }, `turn:${i}:tool`));
      if (typeof output.content === 'string') result.push(conversationMessage({ role: 'assistant', content: output.content, timestamp: turn.request_metadata?.stream_end_timestamp_ms }, `turn:${i}:assistant`));
      return result;
    });
    const created = body.history.map((t: Raw) => time(t.request_metadata?.request_start_timestamp_ms)).find(Boolean);
    return { nativeID: text(r.conversation_id), messages, partial: true, session: { directory: text(r.key), created, model: text(body.model_info?.model_id) || 'Unknown model' }, note: 'Kiro retained SQLite conversation turns. Request-start metadata places the session; untimed user prompts remain untimed. Tool-use variants and compacted context are partial.' };
  },
};

export const databaseHarnessAdapters = [hermes, goose, openclaw, zed, devin, crush, octofriend, unsloth, kiro,
  forkStore('kilo-cli', 'Kilo CLI', () => dataPath('kilo/kilo.db')),
  forkStore('mimo-code', 'MiMo Code', () => dataPath('mimocode/mimocode.db'), false),
  forkStore('mimo-desktop', 'Xiaomi MiMo AI', () => dataPath('mimocode/mimocode.db'), true),
].map(sqliteHistoryAdapter);
