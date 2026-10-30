export const sourceName = (id?: string) => ({ opencode: 'OpenCode', 'claude-code': 'Claude Code', codex: 'Codex' })[id || 'opencode'] || id || 'Unknown';
export const sourceIcon = (id?: string) => {
  const file = ({ opencode: 'opencode', 'claude-code': 'claude', codex: 'openai' })[id || ''] || 'generic';
  return `<span class="source-icon source-icon-${file}" aria-hidden="true" style="--source-icon:url('/sources/${file}.svg')"></span>`;
};
