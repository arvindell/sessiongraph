import { Service } from '@opencode/client/service';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { SessionAtlasData, FileChange, Project, Session, SessionDetail } from '../src/types';
import { serviceFile } from './config';

export interface RawSession {
  id: string;
  title?: string;
  projectID: string;
  parentID?: string;
  fork?: { sessionID: string };
  location: { directory: string };
  time: { created: number; updated: number; archived?: number };
  model?: { id: string; providerID: string };
  agent?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  outcome?: string;
}

interface RawProject { id: string; name?: string; canonical: string; sandboxes?: string[] }
interface Page<T> { data: T[]; cursor: { next?: string | null } }
interface ToolPart {
  type: string;
  name?: string;
  state?: { status: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> };
}
export interface RawMessage {
  id: string;
  type: string;
  time: { created: number };
  snapshot?: { files?: string[]; start?: string; end?: string };
  content?: ToolPart[];
  location?: { directory: string };
}

// Official service discovery shares OpenCode's authenticated connection context.
// GETs only; no service startup, database access, or browser-side credentials.
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const endpoint = await Service.discover({ file: serviceFile() });
  if (!endpoint) throw new Error('No healthy OpenCode service was found.');
  const origin = new URL(endpoint.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Session Atlas only imports from a loopback OpenCode service.');
  const response = await fetch(new URL(path, endpoint.url), {
    headers: Service.headers(endpoint),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`OpenCode request failed (${response.status}).`);
  return await response.json() as T;
}

export function sessionFromResponse(value: RawSession | { data: RawSession }, id: string): RawSession {
  const session = 'data' in value ? value.data : value;
  if (session?.id !== id || !Number.isFinite(session.time?.updated)) throw new Error('Unexpected OpenCode session response.');
  return session;
}
export async function getSessionInfo(id: string) {
  return sessionFromResponse(await api<RawSession | { data: RawSession }>(`/api/session/${encodeURIComponent(id)}`), id);
}

let cache: SessionAtlasData | undefined;
let pending: Promise<SessionAtlasData> | undefined;

export async function getSessionAtlas(force = false): Promise<SessionAtlasData> {
  if (!force && cache && Date.now() - cache.loadedAt < 30_000) return cache;
  if (pending) return pending;
  pending = loadSessionAtlas().then((data) => (cache = data)).finally(() => { pending = undefined; });
  return pending;
}

async function loadSessionAtlas(): Promise<SessionAtlasData> {
  const endpoint = await Service.discover({ file: serviceFile() });
  if (!endpoint) throw new Error('No healthy OpenCode service was found.');
  // Scope the browser cache to this service without exposing its credentials.
  const sourceID = createHash('sha256').update(JSON.stringify([endpoint.url, serviceFile() || 'default'])).digest('hex');
  const rawProjects = await api<RawProject[]>('/api/project');
  const sessions = new Map<string, Session>();
  const warnings: string[] = [];
  let cursor: string | null | undefined;
  const seenCursors = new Set<string>();
  do {
    const params = new URLSearchParams({ limit: '500' });
    if (cursor) params.set('cursor', cursor);
    const page = await api<Page<RawSession>>(`/api/session?${params}`);
    if (!Array.isArray(page.data)) throw new Error('Unexpected OpenCode session response. OpenCode V2 is required.');
    for (const raw of page.data) {
      const t = raw.tokens;
      sessions.set(raw.id, {
        id: raw.id,
        title: raw.title || 'Untitled session',
        projectID: raw.projectID,
        parentID: raw.parentID,
        forkID: raw.fork?.sessionID,
        directory: raw.location?.directory || '',
        created: raw.time.created,
        updated: raw.time.updated,
        archived: Boolean(raw.time.archived),
        model: raw.model?.id || 'Unknown model',
        provider: raw.model?.providerID || '',
        agent: raw.agent || 'build',
        cost: raw.cost || 0,
        // Input + output + cache tokens; reasoning is generally part of output.
        tokens: (t?.input || 0) + (t?.output || 0) + (t?.cache?.read || 0) + (t?.cache?.write || 0),
        outcome: raw.outcome,
      });
    }
    cursor = page.cursor?.next;
    if (cursor && seenCursors.has(cursor)) throw new Error('OpenCode returned a repeated session cursor.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor && sessions.size < 20_000);
  if (cursor) warnings.push('Showing the newest 20,000 sessions. Older sessions are not loaded.');
  const projects: Project[] = rawProjects.map((p) => ({
    id: p.id,
    name: p.name || basename(p.canonical) || 'Global',
    directory: p.canonical,
    worktrees: p.sandboxes || [],
  }));
  return { sourceID, sessions: [...sessions.values()], projects, loadedAt: Date.now(), warnings };
}

// Only successful edit tools qualify as fallback evidence. Reads and failed edits
// are never described as changed files. Snapshot paths are preferred when present.
export function editedPaths(part: ToolPart): string[] {
  if (part.state?.status !== 'completed') return [];
  const name = (part.name || '').split(/[./]/).at(-1) || '';
  const input = part.state.input || {};
  if (['patch', 'apply_patch'].includes(name)) {
    const patch = input.patchText ?? input.patch ?? input.input;
    if (typeof patch !== 'string') return [];
    return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1].trim());
  }
  if (['edit', 'write', 'multiedit'].includes(name.toLowerCase())) {
    const path = input.filePath ?? input.file_path ?? input.path;
    return typeof path === 'string' ? [path] : [];
  }
  return [];
}

export function summarizeMessages(id: string, messages: RawMessage[], nextCursor: string | null): SessionDetail {
  const files = new Map<string, FileChange>();
  const tools = new Map<string, number>();
  const locations: SessionDetail['locations'] = [];
  let snapshotSteps = 0;
  for (const message of messages) {
    const stepFiles = new Map<string, FileChange['source']>();
    if (message.snapshot?.start && message.snapshot?.end) snapshotSteps++;
    for (const path of message.snapshot?.files || []) stepFiles.set(path, 'snapshot');
    for (const part of message.content || []) {
      if (part.type !== 'tool') continue;
      const name = part.name || 'unknown';
      tools.set(name, (tools.get(name) || 0) + 1);
      // A complete snapshot is authoritative for that step, including an empty list.
      if (!message.snapshot?.start || !message.snapshot?.end) {
        for (const path of editedPaths(part)) stepFiles.set(path, 'edit tool');
      }
    }
    for (const [path, source] of stepFiles) {
      const previous = files.get(path);
      files.set(path, { path, source: previous?.source === 'snapshot' ? 'snapshot' : source, steps: (previous?.steps || 0) + 1 });
    }
    if (message.type === 'location-switched' && message.location) {
      locations.push({ directory: message.location.directory, time: message.time.created });
    }
  }
  return {
    id,
    files: [...files.values()].sort((a, b) => b.steps - a.steps || a.path.localeCompare(b.path)),
    tools: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    locations,
    messagesScanned: messages.length,
    snapshotSteps,
    partial: Boolean(nextCursor),
    nextCursor,
    loadedAt: Date.now(),
  };
}

const details = new Map<string, { time: number; promise: Promise<SessionDetail> }>();

export async function getDetail(id: string, cursor?: string): Promise<SessionDetail> {
  const key = `${id}:${cursor || ''}`;
  const existing = details.get(key);
  if (existing && Date.now() - existing.time < 60_000) return existing.promise;
  const promise = loadDetail(id, cursor).catch((error) => { details.delete(key); throw error; });
  if (details.size >= 100) details.delete(details.keys().next().value!);
  details.set(key, { time: Date.now(), promise });
  return promise;
}

async function loadDetail(id: string, initialCursor?: string): Promise<SessionDetail> {
  const messages: RawMessage[] = [];
  let cursor: string | null | undefined = initialCursor;
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const params = new URLSearchParams({ limit: '30' });
    if (cursor) params.set('cursor', cursor);
    else params.set('order', 'desc');
    const page = await api<Page<RawMessage>>(`/api/session/${encodeURIComponent(id)}/message?${params}`);
    if (!Array.isArray(page.data)) throw new Error('Unexpected OpenCode message response.');
    messages.push(...page.data);
    cursor = page.cursor?.next;
    if (!cursor) break;
  }
  return summarizeMessages(id, messages, cursor || null);
}
