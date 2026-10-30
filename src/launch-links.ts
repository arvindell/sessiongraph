import type { Session } from './types';
export interface LaunchConnection { webBaseUrl?: string; terminalAvailable: boolean }
export const validSessionID = (id: string) => /^ses[a-zA-Z0-9_-]+$/.test(id);

export function cliCommand(value: string | Session): string {
  const source = typeof value === 'string' ? 'opencode' : value.source || 'opencode';
  const id = typeof value === 'string' ? value : value.nativeID || value.id;
  if (source !== 'opencode') {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('This session cannot be resumed directly. Open its parent session.');
    if (source === 'codex') return `codex resume '${id}'`;
    if (source === 'claude-code') return `claude --resume '${id}'`;
    throw new Error('This source does not provide a launcher.');
  }
  if (!validSessionID(id)) throw new Error('Invalid session ID.');
  return `opencode --session '${id}'`;
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
