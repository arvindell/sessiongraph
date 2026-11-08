import { laneKey, makeGraph } from './layout.ts';
import { isKnownSource } from './sources.ts';
import { projectAliases } from './anonymous-projects.ts';
import type { Graph, Session } from './types';

export const PUBLIC_FIELDS = {
  tokens: 'Tokens', timestamps: 'Session times', messageCounts: 'Message counts',
  messageTimestamps: 'Message times', model: 'Models', harness: 'Apps',
} as const;
export type PublishingSettings = Record<keyof typeof PUBLIC_FIELDS, boolean>;
export const DEFAULT_PUBLISHING: PublishingSettings = { tokens: true, timestamps: true, messageCounts: true, messageTimestamps: true, model: true, harness: true };
export function publishingSettings(value: unknown): PublishingSettings {
  const result = { ...DEFAULT_PUBLISHING };
  if (object(value)) for (const key of Object.keys(result) as (keyof PublishingSettings)[]) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (!result.timestamps || !result.messageCounts) result.messageTimestamps = false;
  return result;
}

export interface PublicMessageStats {
  count: number | null;
  untimed: number | null;
  partial: boolean;
  times: number[];
  timesLimited: boolean;
}
export interface PublicSession {
  id: number; group: number; parent: number | null; fork: number | null;
  timestamps?: { created: number; lastMessageAt: number | null };
  tokens?: number | null;
  messages?: { count: number | null; untimed: number | null; partial: boolean };
  messageTimes?: { values: number[]; limited: boolean };
  model?: string | null;
  harness?: string | null;
}
/** The entire public wire format: settings determine the exact keys allowed. */
export interface PublicGraph { version: 1; settings: PublishingSettings; sessions: PublicSession[] }
export const PUBLIC_GRAPH_MAX_SESSIONS = 10_000;
export const PUBLIC_GRAPH_MAX_BYTES = 2_000_000;
export const PUBLIC_GRAPH_MAX_MESSAGE_TIMES = 100_000;
export const PUBLIC_GRAPH_DISCLOSURE = 'Visible on your profile and in Explore. Names, messages, code, paths, and costs stay private.';

// Only recognized public model identifiers; private deployment aliases and URLs stay local.
const modelPattern = /^(?:gpt-[3-6](?:\.[0-9])?(?:-(?:turbo|mini|nano|pro|codex|astra|instant|thinking|chat|latest|preview|[0-9]{4,8}))*|o[1-4](?:-(?:mini|pro|preview|[0-9]{4,8}))*|claude-(?:(?:sonnet|opus|haiku)-[3-5](?:[.-][0-9])?|[3-5](?:-[0-9])?-(?:sonnet|opus|haiku))(?:-(?:latest|thinking|[0-9]{8}))*|gemini-[1-4](?:\.[0-9])?-(?:pro|flash)(?:-(?:lite|preview|exp|latest|[0-9]{2,4}))*|deepseek-(?:chat|reasoner|v[3-4](?:\.[0-9])?|r1)|grok-[2-5](?:\.[0-9])?(?:-(?:fast|code|reasoning|non-reasoning|[0-9]))*|kimi-k[1-3](?:\.[0-9])?(?:-thinking)?|minimax-m[1-3](?:\.[0-9])?)$/i;
export const publicModel = (value: string): string | null => {
  const name = value.split('/').at(-1) || '';
  return name.length <= 100 && modelPattern.test(name) ? name.toLowerCase() : null;
};

/** Construct, never redact/spread. Message stats must already contain no content. */
export function publishableGraph(sessions: readonly Session[], settings: PublishingSettings, messages: ReadonlyMap<string, PublicMessageStats> = new Map()): PublicGraph {
  const fields = publishingSettings(settings);
  const ordered = [...sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const ids = new Map(ordered.map((session, index) => [session.id, index]));
  const groups = new Map<string, number>();
  const graph: PublicGraph = { version: 1, settings: fields, sessions: ordered.map(session => {
    const key = laneKey(session);
    if (!groups.has(key)) groups.set(key, groups.size);
    const result: PublicSession = {
      id: ids.get(session.id)!, group: groups.get(key)!,
      parent: session.parentID ? ids.get(session.parentID) ?? null : null,
      fork: session.forkID ? ids.get(session.forkID) ?? null : null,
    };
    // Native clocks (including SQLite seconds) can retain sub-millisecond precision.
    // The public wire format uses integer milliseconds, just like JavaScript Dates.
    if (fields.timestamps) result.timestamps = { created: Math.trunc(session.created), lastMessageAt: session.activity?.lastMessageAt == null ? null : Math.trunc(session.activity.lastMessageAt) };
    if (fields.tokens) result.tokens = session.tokens;
    const stats = messages.get(session.id);
    if (fields.messageCounts) result.messages = { count: stats?.count ?? null, untimed: stats?.untimed ?? null, partial: stats?.partial ?? true };
    if (fields.messageTimestamps) result.messageTimes = { values: [], limited: stats?.timesLimited ?? true };
    if (fields.model) result.model = publicModel(session.model);
    if (fields.harness) result.harness = isKnownSource(session.source) ? session.source! : null;
    return result;
  }) };
  if (fields.messageTimestamps) {
    // Reserve the metadata first. A count-only bound can still exceed the byte
    // limit on larger libraries; timestamp omissions remain explicit on the wire.
    let bytes = PUBLIC_GRAPH_MAX_BYTES - new TextEncoder().encode(JSON.stringify(graph)).length;
    let remaining = PUBLIC_GRAPH_MAX_MESSAGE_TIMES;
    for (let index = 0; index < ordered.length; index++) {
      const times = messages.get(ordered[index].id)?.times ?? [], output = graph.sessions[index].messageTimes!;
      for (const native of times) {
        const time = Math.trunc(native), size = String(time).length + (output.values.length ? 1 : 0);
        if (!remaining || output.values.length === 2000 || size > bytes) break;
        output.values.push(time); bytes -= size; remaining--;
      }
      if (output.values.length < times.length) output.limited = true;
    }
  }
  return validatePublicGraph(graph);
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const time = (value: unknown) => integer(value, Date.UTC(2100, 0, 1));
const nullableCount = (value: unknown) => value === null || integer(value);

/** No unknown keys, no free text, no disabled fields: enforced again on the website. */
export function validatePublicGraph(value: unknown): PublicGraph {
  const fail = () => { throw new Error('Invalid anonymous graph. Reopen the publishing preview and try again.'); };
  if (!exact(value, ['version', 'settings', 'sessions']) || value.version !== 1 || !Array.isArray(value.sessions)) return fail();
  if (!exact(value.settings, Object.keys(DEFAULT_PUBLISHING)) || Object.values(value.settings).some(v => typeof v !== 'boolean')) return fail();
  const settings = value.settings as PublishingSettings;
  if (settings.messageTimestamps && (!settings.timestamps || !settings.messageCounts)) return fail();
  if (value.sessions.length < 1 || value.sessions.length > PUBLIC_GRAPH_MAX_SESSIONS) throw new Error(`Choose between 1 and ${PUBLIC_GRAPH_MAX_SESSIONS.toLocaleString('en')} sessions to publish.`);
  const keys = ['id', 'group', 'parent', 'fork', ...(settings.timestamps ? ['timestamps'] : []), ...(settings.tokens ? ['tokens'] : []), ...(settings.messageCounts ? ['messages'] : []), ...(settings.messageTimestamps ? ['messageTimes'] : []), ...(settings.model ? ['model'] : []), ...(settings.harness ? ['harness'] : [])];
  let times = 0;
  for (let index = 0; index < value.sessions.length; index++) {
    const s: unknown = value.sessions[index];
    if (!exact(s, keys) || s.id !== index || !integer(s.group, value.sessions.length - 1)) return fail();
    for (const key of ['parent', 'fork']) if (s[key] !== null && (!integer(s[key], value.sessions.length - 1) || s[key] === index)) return fail();
    if (settings.timestamps && (!exact(s.timestamps, ['created', 'lastMessageAt']) || !time(s.timestamps.created) || (s.timestamps.lastMessageAt !== null && !time(s.timestamps.lastMessageAt)))) return fail();
    if (settings.tokens && !nullableCount(s.tokens)) return fail();
    if (settings.messageCounts && (!exact(s.messages, ['count', 'untimed', 'partial']) || !nullableCount(s.messages.count) || !nullableCount(s.messages.untimed) || typeof s.messages.partial !== 'boolean')) return fail();
    if (settings.messageTimestamps) {
      if (!exact(s.messageTimes, ['values', 'limited']) || !Array.isArray(s.messageTimes.values) || s.messageTimes.values.length > 2000 || typeof s.messageTimes.limited !== 'boolean' || s.messageTimes.values.some(v => !time(v))) return fail();
      times += s.messageTimes.values.length;
      if (times > PUBLIC_GRAPH_MAX_MESSAGE_TIMES) return fail();
    }
    if (settings.model && s.model !== null && (typeof s.model !== 'string' || publicModel(s.model) !== s.model)) return fail();
    if (settings.harness && s.harness !== null && (typeof s.harness !== 'string' || !isKnownSource(s.harness))) return fail();
  }
  const sessions = value.sessions as PublicSession[];
  // Iterative cycle detection: no stack overflow on hostile or deep ancestry.
  const colors = new Uint8Array(sessions.length);
  for (let i = 0; i < sessions.length; i++) {
    if (colors[i]) continue;
    const stack: [number, boolean][] = [[i, false]];
    while (stack.length) {
      const [id, exit] = stack.pop()!;
      if (exit) { colors[id] = 2; continue; }
      if (colors[id] === 1) return fail();
      if (colors[id] === 2) continue;
      colors[id] = 1; stack.push([id, true]);
      for (const parent of [sessions[id].parent, sessions[id].fork]) if (parent !== null) stack.push([parent, false]);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > PUBLIC_GRAPH_MAX_BYTES) throw new Error('This graph is too large. Choose a smaller date range.');
  return value as unknown as PublicGraph;
}

export function publicGraphLayout(value: PublicGraph, included?: ReadonlySet<number>): Graph {
  const graph = validatePublicGraph(value);
  const sessions: Session[] = graph.sessions.filter(s => !included || included.has(s.id)).map(s => ({
    id: String(s.id), projectID: String(s.group), title: `Session ${s.id + 1}`, directory: '',
    created: s.timestamps?.created ?? s.id * 3_600_000, updated: s.timestamps?.created ?? s.id * 3_600_000,
    tokens: s.tokens ?? null, cost: null, archived: false, model: s.model ?? '', provider: '', agent: '', source: s.harness ?? undefined,
    activity: { firstMessageAt: null, lastMessageAt: s.timestamps?.lastMessageAt ?? null, userMessages: 0, untimedUserMessages: 0 },
    ...(s.parent === null ? {} : { parentID: String(s.parent) }), ...(s.fork === null ? {} : { forkID: String(s.fork) }),
  }));
  const names = projectAliases(Math.max(...graph.sessions.map(s => s.group)) + 1);
  const projects = [...new Set(graph.sessions.map(s => s.group))].map(id => ({ id: String(id), name: names[id], directory: '', worktrees: [] }));
  // Anonymous groups already encode the publisher's grouping. A shared harness
  // field must not split a group that originally spanned several coding agents.
  const layout = makeGraph(sessions.map(s => ({ ...s, source: undefined })), projects);
  for (const node of layout.nodes) node.session.source = graph.sessions[Number(node.session.id)].harness ?? undefined;
  return layout;
}
