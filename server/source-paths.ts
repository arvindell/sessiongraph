import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionAdapter } from './adapters/types';

const paths = new AsyncLocalStorage<Record<string, string>>();
/** Per-library overrides, isolated across concurrent discovery and imports. */
export const sourcePath = (id: string) => paths.getStore()?.[id];
export function withSourcePaths(adapter: SessionAdapter, configured: () => Record<string, string>): SessionAdapter {
  return { ...adapter,
    detect: () => paths.run(configured(), () => adapter.detect()),
    discover: () => paths.run(configured(), async () => {
      const result = await adapter.discover();
      if (!sourcePath(adapter.id)) return result;
      // An archive can be imported without existing in the harness's active home.
      return { ...result, sessions: result.sessions.map(candidate => ({ ...candidate, session: { ...candidate.session, nativeResume: false } })) };
    }),
    read: (candidate, cursor) => paths.run(configured(), async () => {
      const result = await adapter.read(candidate, cursor);
      if (sourcePath(adapter.id)) candidate.session.nativeResume = false;
      return result;
    }),
  };
}

export function sourcePathHint(id: string) {
  const hints: Record<string, string> = {
    opencode: 'Uses authenticated loopback service discovery; no history path override.',
    'claude-code': 'Claude home containing projects/ and transcripts/ (normally ~/.claude).',
    codex: 'Codex home containing sessions/ and archived_sessions/ (normally ~/.codex).',
    't3-code': 'T3 home containing its local server history (normally ~/.t3).',
    cursor: 'Cursor CLI home (normally ~/.cursor); IDE data still uses SESSIONGRAPH_CURSOR_USER_DATA_DIR.',
    gemini: 'Gemini home containing tmp/ (normally ~/.gemini).',
    'qwen-code': 'Qwen home containing projects/ (normally ~/.qwen).',
    pi: 'Pi sessions directory (normally ~/.pi/agent/sessions).',
    copilot: 'Copilot home containing session-state/ (normally ~/.copilot).',
    'copilot-chat': 'VS Code user-data directory containing User/.',
    cline: 'Extension home containing tasks/, or CLI home containing data/sessions/.',
    'roo-code': 'Extension global-storage directory containing tasks/.',
    'kilo-code': 'Extension global-storage directory containing tasks/.',
    continue: 'Continue home containing sessions/ (normally ~/.continue).',
  };
  return hints[id] || 'History root, as for SESSIONGRAPH_<SOURCE_ID>_HISTORY_DIR; native formats and discovery bounds still apply.';
}
