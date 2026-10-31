import type { SourceStatus } from './types';

const sources: Record<string, { name: string; icon: string }> = {
  opencode: { name: 'OpenCode', icon: 'opencode' },
  'claude-code': { name: 'Claude Code', icon: 'claude' },
  codex: { name: 'Codex', icon: 'openai' },
  cursor: { name: 'Cursor', icon: 'cursor' },
  gemini: { name: 'Gemini CLI', icon: 'gemini' },
  'qwen-code': { name: 'Qwen Code', icon: 'qwen' },
  pi: { name: 'Pi', icon: 'pi' },
  copilot: { name: 'GitHub Copilot CLI', icon: 'copilot' },
  cline: { name: 'Cline', icon: 'cline' },
  'roo-code': { name: 'Roo Code', icon: 'roo' },
  'kilo-code': { name: 'Kilo Code', icon: 'kilo' },
  continue: { name: 'Continue', icon: 'continue' },
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
  const description = [source.description, source.lastImport ? `Last import ${new Date(source.lastImport).toLocaleString()}` : 'Not imported yet', source.error].filter(Boolean).join(' · ');
  return `<label class="import-source" data-source="${escape(source.id)}" title="${escape(description)}"><input ${settings ? 'class="settings-source"' : ''} type="checkbox" value="${escape(source.id)}" aria-label="${escape(source.name)}" aria-description="${escape(`${status}. ${source.sessions.toLocaleString()} saved sessions. ${description}`)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}/><span class="source-symbol">${sourceIcon(source.id)}</span><span class="source-copy"><strong>${escape(source.name)}</strong><small class="source-meta"><span class="source-detected ${source.available ? 'detected' : ''}">${status}</span><span>${source.sessions.toLocaleString()} saved</span></small>${source.error ? `<small class="source-error">${escape(source.error)}</small>` : ''}</span></label>`;
}
