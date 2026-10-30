import { api } from './opencode';
import type { ContentPage, Fragment } from '../src/search/types';

// Bound tool output before it enters either cache or the browser's search index.
// Message extraction follows opencode-search's user/assistant/tool/file fields.
export function extractContent(messages: unknown[]): Pick<ContentPage, 'fragments' | 'truncated'> {
  const fragments: Fragment[] = [];
  let remaining = 64_000;
  let truncated = false;
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, any>;
    const time = Number(message.time?.created) || 0;
    const seen = new Set<string>();
    const add = (value: unknown, kind: Fragment['kind']) => {
      if (typeof value !== 'string' || !value.trim() || value.startsWith('data:') || seen.has(value)) return;
      seen.add(value);
      const size = Math.min(8_000, remaining);
      if (value.length > size) truncated = true;
      if (size <= 0) return;
      const text = value.slice(0, size);
      remaining -= text.length;
      fragments.push({ text, kind, time });
    };
    const strings = (value: unknown, depth = 0) => {
      if (depth > 5 || remaining <= 0) { if (value != null) truncated = true; return; }
      if (typeof value === 'string') { add(value, 'Tool'); return; }
      if (Array.isArray(value)) { if (value.length > 100) truncated = true; value.slice(0, 100).forEach((part) => strings(part, depth + 1)); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, field] of Object.entries(value)) {
        if (/base64|image|binary|credential|token|secret|password/i.test(key)) continue;
        if (/^(filePath|file_path|path|filename)$/i.test(key)) add(field, 'File');
        else strings(field, depth + 1);
      }
    };
    if (['user', 'synthetic', 'system'].includes(message.type)) add(message.text, message.type === 'user' ? 'You' : 'Assistant');
    for (const file of message.files || []) { add(file.name, 'File'); add(file.uri, 'File'); }
    if (message.type === 'shell') { add(message.command, 'Tool'); add(message.output, 'Tool'); }
    if (message.type === 'compaction') { add(message.summary, 'Assistant'); add(message.recent, 'Assistant'); }
    for (const file of message.snapshot?.files || []) add(file, 'File');
    for (const part of message.content || []) {
      if (part.type === 'text') add(part.text, 'Assistant');
      if (part.type !== 'tool') continue;
      add(part.name, 'Tool');
      strings(part.state?.input);
      for (const item of part.state?.content || []) { add(item.text, 'Tool'); add(item.name, 'File'); add(item.uri, 'File'); }
      for (const item of part.state?.attachments || []) { add(item.name, 'File'); add(item.uri, 'File'); }
      for (const path of part.state?.outputPaths || []) add(path, 'File');
    }
  }
  return { fragments, truncated };
}

const pages = new Map<string, { time: number; page: ContentPage }>();
export async function getSearchPage(id: string, cursor?: string, signal?: AbortSignal, updated?: number): Promise<ContentPage> {
  const key = `${id}:${updated ?? ''}:${cursor || ''}`;
  const cached = pages.get(key);
  if (cached && Date.now() - cached.time < 60_000) return cached.page;
  const params = new URLSearchParams({ limit: '60' });
  if (cursor) params.set('cursor', cursor);
  else params.set('order', 'desc');
  const response = await api<{ data: unknown[]; cursor?: { next?: string } }>(`/api/session/${encodeURIComponent(id)}/message?${params}`, signal);
  if (!Array.isArray(response.data)) throw new Error('Unexpected message response.');
  const page = { id, ...extractContent(response.data), messages: response.data.length, nextCursor: response.cursor?.next || null };
  if (pages.size >= 80) pages.delete(pages.keys().next().value!);
  pages.set(key, { time: Date.now(), page });
  return page;
}
