import type { SourceStatus } from './types';

const sources: Record<string, { name: string; icon: string }> = {
  opencode: { name: 'OpenCode', icon: 'opencode' },
  'claude-code': { name: 'Claude Code', icon: 'claude' },
  codex: { name: 'Codex', icon: 'openai' },
  't3-code': { name: 'T3 Code', icon: 't3' },
  cursor: { name: 'Cursor', icon: 'cursor' },
  gemini: { name: 'Gemini CLI', icon: 'gemini' },
  'qwen-code': { name: 'Qwen Code', icon: 'qwen' },
  pi: { name: 'Pi', icon: 'pi' },
  copilot: { name: 'GitHub Copilot CLI', icon: 'copilot' },
  'copilot-chat': { name: 'GitHub Copilot Chat (VS Code)', icon: 'copilot' },
  cline: { name: 'Cline', icon: 'cline' },
  'roo-code': { name: 'Roo Code', icon: 'roo' },
  'kilo-code': { name: 'Kilo Code', icon: 'kilo' },
  continue: { name: 'Continue', icon: 'continue' },
  'prime-agent': { name: 'Prime Agent', icon: 'prime' },
  omp: { name: 'Oh My Pi', icon: 'pi' },
  senpi: { name: 'Senpi / OmO Native', icon: 'senpi' },
  kimchi: { name: 'Kimchi', icon: 'kimchi' },
  gajae: { name: 'Gajae-Code', icon: 'gajae' },
  openclaw: { name: 'OpenClaw', icon: 'openclaw' },
  hermes: { name: 'Hermes Agent', icon: 'hermes' },
  amp: { name: 'Amp', icon: 'amp' },
  droid: { name: 'Factory Droid', icon: 'droid' },
  codebuff: { name: 'Codebuff', icon: 'codebuff' },
  freebuff: { name: 'Freebuff', icon: 'freebuff' },
  kimi: { name: 'Kimi CLI / Code', icon: 'kimi' },
  grok: { name: 'Grok Build', icon: 'grok' },
  jcode: { name: 'Jcode', icon: 'jcode' },
  'cherry-studio': { name: 'Cherry Studio', icon: 'cherry' },
  'command-code': { name: 'Command Code', icon: 'commandcode' },
  zcode: { name: 'ZCode', icon: 'zcode' },
  codebuddy: { name: 'CodeBuddy', icon: 'codebuddy' },
  workbuddy: { name: 'WorkBuddy', icon: 'codebuddy' },
  proma: { name: 'Proma', icon: 'proma' },
  'deepseek-harness': { name: 'DeepSeek Harness', icon: 'deepseek' },
  aside: { name: 'Aside', icon: 'aside' },
  vibe: { name: 'Mistral Vibe', icon: 'mistral' },
  muse: { name: 'Muse Code', icon: 'muse' },
  junie: { name: 'Junie', icon: 'junie' },
  augment: { name: 'Augment Code', icon: 'augment' },
  fx: { name: 'Fx', icon: 'fx' },
  'minimax-code': { name: 'MiniMax Code', icon: 'minimax' },
  opencodereview: { name: 'OpenCodeReview', icon: 'opencode' },
  goose: { name: 'Goose', icon: 'goose' },
  zed: { name: 'Zed Agent', icon: 'zed' },
  devin: { name: 'Devin CLI', icon: 'devin' },
  'devin-desktop': { name: 'Devin Desktop', icon: 'devin' },
  crush: { name: 'Crush', icon: 'crush' },
  octofriend: { name: 'Octofriend', icon: 'octofriend' },
  'kilo-cli': { name: 'Kilo CLI', icon: 'kilo' },
  'mimo-code': { name: 'MiMo Code', icon: 'mimo' },
  'mimo-desktop': { name: 'Xiaomi MiMo AI', icon: 'mimo' },
  unsloth: { name: 'Unsloth Studio', icon: 'unsloth' },
  kiro: { name: 'Kiro', icon: 'kiro' },
  mux: { name: 'Mux', icon: 'mux' },
  antigravity: { name: 'Antigravity', icon: 'antigravity' },
  'antigravity-cli': { name: 'Antigravity CLI', icon: 'antigravity' },
  'antigravity-extension': { name: 'Antigravity IDE Extension', icon: 'antigravity' },
  reasonix: { name: 'Reasonix', icon: 'reasonix' },
  trae: { name: 'Trae / Trae Solo', icon: 'trae' },
  warp: { name: 'Warp / Oz', icon: 'warp' },
  'lm-studio': { name: 'LM Studio', icon: 'lmstudio' },
  hindsight: { name: 'Hindsight', icon: 'hindsight' },
};
export const sourceName = (id?: string) => sources[id || 'opencode']?.name || id || 'Unknown';
export const isKnownSource = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(sources, id);
export const sourceIcon = (id?: string) => {
  const file = sources[id || '']?.icon || 'generic';
  return `<span class="source-icon source-icon-${file}" aria-hidden="true" style="--source-icon:url('/sources/${file}.svg')"></span>`;
};

export const sortSources = (sources: SourceStatus[]) => [...sources].sort((a, b) => Number(b.selected || b.available || b.sessions > 0) - Number(a.selected || a.available || a.sessions > 0) || a.name.localeCompare(b.name));

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function sourceOption(source: SourceStatus, { checked = source.selected, disabled = false, settings = false } = {}) {
  const status = source.available ? 'Detected' : 'Not detected';
  const coverage = source.capabilities.history ? '' : source.description.startsWith('Detection only') ? 'Detection only' : 'Metadata only';
  const description = [source.description, source.lastImport ? `Last import ${new Date(source.lastImport).toLocaleString()}` : 'Not imported yet', source.error].filter(Boolean).join(' · ');
  return `<label class="import-source" data-source="${escape(source.id)}" title="${escape(description)}"><input ${settings ? 'class="settings-source"' : ''} type="checkbox" value="${escape(source.id)}" aria-label="${escape(source.name)}" aria-description="${escape(`${status}. ${source.sessions.toLocaleString()} saved sessions. ${description}`)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}/><span class="source-symbol">${sourceIcon(source.id)}</span><span class="source-copy"><strong>${escape(source.name)}</strong><small class="source-meta"><span class="source-detected ${source.available ? 'detected' : ''}">${status}</span><span>${source.sessions.toLocaleString()} saved</span>${coverage ? `<span>${coverage}</span>` : ''}</small>${source.error ? `<small class="source-error">${escape(source.error)}</small>` : ''}</span></label>`;
}
