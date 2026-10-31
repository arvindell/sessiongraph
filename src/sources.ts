export const sourceName = (id?: string) => ({ opencode: 'OpenCode', 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', 'qwen-code': 'Qwen Code', pi: 'Pi', copilot: 'GitHub Copilot CLI', cline: 'Cline', 'roo-code': 'Roo Code', 'kilo-code': 'Kilo Code', continue: 'Continue' })[id || 'opencode'] || id || 'Unknown';
export const sourceIcon = (id?: string) => {
  const file = ({ opencode: 'opencode', 'claude-code': 'claude', codex: 'openai', cursor: 'cursor' })[id || ''] || 'generic';
  return `<span class="source-icon source-icon-${file}" aria-hidden="true" style="--source-icon:url('/sources/${file}.svg')"></span>`;
};
import type { SourceStatus } from './types';

export const sortSources = (sources: SourceStatus[]) => [...sources].sort((a, b) => Number(b.selected || b.available || b.sessions > 0) - Number(a.selected || a.available || a.sessions > 0) || a.name.localeCompare(b.name));
