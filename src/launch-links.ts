import type { Session } from './types';
export const HARNESSES = [
  { id: 'opencode', name: 'OpenCode', command: 'opencode' },
  { id: 'claude-code', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'cursor', name: 'Cursor Agent', command: 'cursor-agent' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
  { id: 'qwen-code', name: 'Qwen Code', command: 'qwen' },
  { id: 'pi', name: 'Pi', command: 'pi' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot' },
] as const;
export type HarnessID = typeof HARNESSES[number]['id'];
export const isHarness = (value: unknown): value is HarnessID => HARNESSES.some((h) => h.id === value);
export interface LaunchConnection {
  webBaseUrl?: string;
  terminalAvailable: boolean;
  targets: { id: HarnessID; available: boolean }[];
}
export interface PreparedLaunch {
  command: string;
  directory: string;
  terminalAvailable: boolean;
  targetAvailable: boolean;
  mode: 'resume' | 'handoff';
  context?: { path: string; messages: number; totalMessages: number; partial: boolean; note: string };
}
export const validSessionID = (id: string) => /^ses[a-zA-Z0-9_-]+$/.test(id);

export function cliCommand(value: string | Session): string {
  const source = typeof value === 'string' ? 'opencode' : value.source || 'opencode';
  const harness = HARNESSES.find((h) => h.id === source);
  if (!harness) throw new Error('This source does not provide a launcher.');
  const args = resumeArgs(value);
  return `${harness.command} ${args.slice(0, -1).join(' ')} '${args.at(-1)}'`;
}

export function resumeArgs(value: string | Session): string[] {
  const source = typeof value === 'string' ? 'opencode' : value.source || 'opencode';
  const id = typeof value === 'string' ? value : value.nativeID || value.id;
  if (source !== 'opencode') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(id)) throw new Error('This session cannot be resumed directly.');
    if (source === 'codex') return ['resume', id];
    if (source === 'claude-code') return ['--resume', id];
    if (source === 'cursor' && typeof value !== 'string' && value.nativeResume) return ['--resume', id];
    if (['gemini', 'qwen-code', 'copilot'].includes(source) && typeof value !== 'string' && value.nativeResume) return ['--resume', id];
    if (source === 'pi' && typeof value !== 'string' && value.nativeResume) return ['--session', id];
    throw new Error('This source does not provide a launcher.');
  }
  if (!validSessionID(id)) throw new Error('Invalid session ID.');
  return ['--session', id];
}

// OpenCode V2 keys browser server routes by the UTF-8 base64url origin.
// Verified against the web UI shipped with OpenCode 2.2.x.
export function sessionWebUrl(base: string, id: string): string {
  if (!validSessionID(id)) throw new Error('Invalid session ID.');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid OpenCode URL.');
  const key = btoa(String.fromCharCode(...new TextEncoder().encode(url.origin))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${url.origin}/server/${key}/session/${encodeURIComponent(id)}`;
}
