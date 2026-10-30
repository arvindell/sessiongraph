import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Project, Session } from '../../src/types';
import type { Fragment } from '../../src/search/types';
import type { ImportedMessage } from './types';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const identity = (source: string, native: string) => `${source}:${native}`;
export const project = (source: string, directory: string): Project => ({ id: identity(source, digest(directory).slice(0, 24)), name: basename(directory) || 'Global', directory, worktrees: [] });
export const blankSession = (source: string, nativeID: string, directory = ''): Session => ({
  source, nativeID, id: identity(source, nativeID), projectID: project(source, directory).id, directory,
  title: 'Untitled session', created: 0, updated: 0, archived: false, model: 'Unknown model', provider: '', agent: '', cost: null, tokens: null,
});
export const blankMessage = (id: string, time: number, role: ImportedMessage['role']): ImportedMessage => ({ id, time, role, fragments: [], files: [], tools: [] });
export function addText(message: ImportedMessage, value: unknown, kind: Fragment['kind']) {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('data:')) return;
  const remaining = Math.max(0, 128_000 - message.fragments.reduce((n, f) => n + f.text.length, 0));
  if (value.length > remaining) message.partial = true;
  if (remaining) message.fragments.push({ text: value.slice(0, remaining), kind, time: message.time });
}
export function toolText(message: ImportedMessage, value: unknown, depth = 0) {
  if (depth > 5) { message.partial = true; return; }
  if (typeof value === 'string') return addText(message, value, 'Tool');
  if (Array.isArray(value)) { if (value.length > 100) message.partial = true; value.slice(0, 100).forEach((v) => toolText(message, v, depth + 1)); }
  else if (value && typeof value === 'object') for (const [key, val] of Object.entries(value)) {
    if (/base64|image|binary|credential|token|secret|password/i.test(key)) continue;
    if (/^(filePath|file_path|path|filename)$/i.test(key)) addText(message, val, 'File');
    else toolText(message, val, depth + 1);
  }
}
