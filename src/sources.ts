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
  cline: { name: 'Cline', icon: 'cline' },
  'roo-code': { name: 'Roo Code', icon: 'roo' },
  'kilo-code': { name: 'Kilo Code', icon: 'kilo' },
  continue: { name: 'Continue', icon: 'continue' },
  'prime-agent': { name: 'Prime Agent', icon: 'generic' },
  omp: { name: 'Oh My Pi', icon: 'pi' },
  senpi: { name: 'Senpi / OmO Native', icon: 'generic' },
  kimchi: { name: 'Kimchi', icon: 'generic' },
  gajae: { name: 'Gajae-Code', icon: 'generic' },
  openclaw: { name: 'OpenClaw', icon: 'generic' },
  hermes: { name: 'Hermes Agent', icon: 'generic' },
  amp: { name: 'Amp', icon: 'generic' },
  droid: { name: 'Factory Droid', icon: 'generic' },
  codebuff: { name: 'Codebuff', icon: 'generic' },
  freebuff: { name: 'Freebuff', icon: 'generic' },
  kimi: { name: 'Kimi CLI / Code', icon: 'generic' },
  grok: { name: 'Grok Build', icon: 'generic' },
  jcode: { name: 'Jcode', icon: 'generic' },
  'cherry-studio': { name: 'Cherry Studio', icon: 'generic' },
  'command-code': { name: 'Command Code', icon: 'generic' },
  zcode: { name: 'ZCode', icon: 'generic' },
  codebuddy: { name: 'CodeBuddy', icon: 'generic' },
  workbuddy: { name: 'WorkBuddy', icon: 'generic' },
  proma: { name: 'Proma', icon: 'generic' },
  'deepseek-harness': { name: 'DeepSeek Harness', icon: 'generic' },
  aside: { name: 'Aside', icon: 'generic' },
  vibe: { name: 'Mistral Vibe', icon: 'generic' },
  muse: { name: 'Muse Code', icon: 'generic' },
  junie: { name: 'Junie', icon: 'generic' },
  augment: { name: 'Augment Code', icon: 'generic' },
  fx: { name: 'Fx', icon: 'generic' },
  'minimax-code': { name: 'MiniMax Code', icon: 'generic' },
  opencodereview: { name: 'OpenCodeReview', icon: 'generic' },
  goose: { name: 'Goose', icon: 'generic' },
  zed: { name: 'Zed Agent', icon: 'generic' },
  devin: { name: 'Devin CLI', icon: 'generic' },
  'devin-desktop': { name: 'Devin Desktop', icon: 'generic' },
  crush: { name: 'Crush', icon: 'generic' },
  octofriend: { name: 'Octofriend', icon: 'generic' },
  'kilo-cli': { name: 'Kilo CLI', icon: 'kilo' },
  'mimo-code': { name: 'MiMo Code', icon: 'generic' },
  'mimo-desktop': { name: 'Xiaomi MiMo AI', icon: 'generic' },
  unsloth: { name: 'Unsloth Studio', icon: 'generic' },
  kiro: { name: 'Kiro', icon: 'generic' },
  mux: { name: 'Mux', icon: 'generic' },
  antigravity: { name: 'Antigravity', icon: 'generic' },
  'antigravity-cli': { name: 'Antigravity CLI', icon: 'generic' },
  'antigravity-extension': { name: 'Antigravity IDE Extension', icon: 'generic' },
  reasonix: { name: 'Reasonix', icon: 'generic' },
  trae: { name: 'Trae / Trae Solo', icon: 'generic' },
  warp: { name: 'Warp / Oz', icon: 'generic' },
  'lm-studio': { name: 'LM Studio', icon: 'generic' },
  hindsight: { name: 'Hindsight', icon: 'generic' },
};
export const sourceName = (id?: string) => sources[id || 'opencode']?.name || id || 'Unknown';
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
