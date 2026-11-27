import type { Session } from '@sessiongraph/core/types';
import type { MessageMetadata, RecordedUsage, SessionUsage } from '@sessiongraph/core/usage';
import type { ImportedMessage } from './adapters/types';

export const IMPORT_METADATA_VERSION = 1;
type Raw = Record<string, any>;
type Usage = NonNullable<ImportedMessage['usage']>;
const object = (value: unknown): Raw => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
const string = (value: unknown, max = 256) => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
export const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const recordedCost = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const fields = ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'tool'] as const;
export function sumTokens(values: unknown[]): number | null {
  if (!values.length || values.some(value => tokenCount(value) === null)) return null;
  return tokenCount((values as number[]).reduce((sum, value) => sum + value, 0));
}

export function recordedUsage(values: Partial<RecordedUsage>, scope: Usage['scope'] = 'message', id?: unknown): Usage | undefined {
  const usage: Usage = {
    total: null, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, tool: null,
    inputIncludesCache: typeof values.inputIncludesCache === 'boolean' ? values.inputIncludesCache : null,
    outputIncludesReasoning: typeof values.outputIncludesReasoning === 'boolean' ? values.outputIncludesReasoning : null,
    cost: recordedCost(values.cost), scope,
  };
  for (const field of fields) usage[field] = tokenCount(values[field]);
  if (values.costEstimated !== undefined && typeof values.costEstimated === 'boolean') usage.costEstimated = values.costEstimated;
  const identity = string(id, 512); if (identity) usage.id = identity;
  return fields.some(field => usage[field] !== null) || usage.cost !== null ? usage : undefined;
}

/** Anthropic's cache buckets are separate from input; reasoning is inside output. */
export function anthropicUsage(value: unknown, id?: unknown): Usage | undefined {
  const u = object(value), split = 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u;
  return recordedUsage({
    input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
    reasoning: u.reasoning_output_tokens,
    total: tokenCount(u.total_tokens) ?? sumTokens(split
      ? [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
      : [u.input_tokens, u.output_tokens]),
    inputIncludesCache: split ? false : null, outputIncludesReasoning: true,
  }, 'message', id);
}

/** OpenAI/Codex input and output already include cached/reasoning subsets. */
export function openAIUsage(value: unknown, id?: unknown, scope: Usage['scope'] = 'message'): Usage | undefined {
  const u = object(value), input = u.input_tokens ?? u.prompt_tokens, output = u.output_tokens ?? u.completion_tokens;
  return recordedUsage({
    input, output, total: tokenCount(u.total_tokens) ?? sumTokens([input, output]),
    cacheRead: u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens,
    cacheWrite: u.cache_write_input_tokens, reasoning: u.reasoning_output_tokens ?? u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens,
    inputIncludesCache: true, outputIncludesReasoning: true,
  }, scope, id);
}

export function piUsage(value: unknown, id?: unknown): Usage | undefined {
  const u = object(value);
  return recordedUsage({
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning,
    total: tokenCount(u.totalTokens) ?? sumTokens([u.input, u.output, u.cacheRead, u.cacheWrite]),
    inputIncludesCache: false, outputIncludesReasoning: true, cost: object(u.cost).total,
    costEstimated: typeof u.cost?.total === 'number' ? u.cost.totalFromProvider !== true : undefined,
  }, 'message', id);
}

/** Prefer the native total: Qwen providers disagree on whether thoughts overlap output. */
export function googleUsage(value: unknown, id?: unknown): Usage | undefined {
  const u = object(value);
  const input = u.promptTokenCount ?? u.input, output = u.candidatesTokenCount ?? u.output;
  const reasoning = u.thoughtsTokenCount ?? u.thoughts, total = u.totalTokenCount ?? u.total;
  // Some Qwen converters persist a zero sentinel when the provider omitted total.
  const placeholder = total === 0 && [input, output, reasoning, u.toolUsePromptTokenCount ?? u.tool].some(value => (tokenCount(value) ?? 0) > 0);
  const base = sumTokens([input, output]), withReasoning = sumTokens([input, output, reasoning]);
  const comparable = !placeholder && tokenCount(total) !== null && base !== null && tokenCount(reasoning) !== null
    && (u.toolUsePromptTokenCount ?? u.tool ?? 0) === 0;
  return recordedUsage({
    input, output, cacheRead: u.cachedContentTokenCount ?? u.cached, reasoning, tool: u.toolUsePromptTokenCount ?? u.tool,
    total: placeholder ? null : total, inputIncludesCache: true,
    outputIncludesReasoning: comparable && total === base ? true : comparable && total === withReasoning ? false : null,
  }, 'message', id);
}

export function openCodeUsage(value: unknown, cost?: unknown, id?: unknown): Usage | undefined {
  const u = object(value);
  return recordedUsage({
    input: u.input, output: u.output, cacheRead: u.cache?.read, cacheWrite: u.cache?.write, reasoning: u.reasoning,
    total: sumTokens([u.input, u.output, u.cache?.read, u.cache?.write]),
    inputIncludesCache: false, outputIncludesReasoning: true, cost: recordedCost(cost),
  }, 'message', id);
}

/** Only known structured usage envelopes are decoded; never scan text/tool arguments. */
export function messageUsage(raw: Raw): Usage | undefined {
  const id = raw.responseId || raw.response_id || raw.id;
  if (raw.usageMetadata) return googleUsage(raw.usageMetadata, id);
  if (raw.tokens?.cache) return openCodeUsage(raw.tokens, raw.cost, id);
  if (raw.token_usage) {
    const u = object(raw.token_usage);
    // Jcode preserves cache-creation for split accounting, but uses cache-read
    // as an input subset for OpenAI-style responses. Do not use the latest
    // session model to classify an earlier response.
    const split = 'cache_creation_input_tokens' in u || tokenCount(u.cache_read_input_tokens) !== null && tokenCount(u.input_tokens) !== null && u.cache_read_input_tokens > u.input_tokens;
    return split ? anthropicUsage(u, id) : openAIUsage(u, id);
  }
  const u = object(raw.usage);
  if ('cacheRead' in u || 'cacheWrite' in u || 'totalTokens' in u && 'input' in u) return piUsage(u, id);
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) return anthropicUsage(u, id);
  if ('input_tokens' in u || 'prompt_tokens' in u || 'output_tokens' in u || 'completion_tokens' in u || 'total_tokens' in u) return openAIUsage(u, id);
  if ('inputTokens' in u || 'outputTokens' in u || 'totalTokens' in u) {
    // Amp declares separate cache buckets; common AI SDK envelopes provide a
    // total instead. Never add caches on top of an explicit provider total.
    const split = 'cacheReadInputTokens' in u || 'cacheCreationInputTokens' in u;
    return recordedUsage({
      input: u.inputTokens, output: u.outputTokens,
      cacheRead: u.cacheReadInputTokens ?? u.cachedInputTokens, cacheWrite: u.cacheCreationInputTokens,
      reasoning: u.reasoningTokens,
      total: tokenCount(u.totalTokens) ?? sumTokens(split ? [u.inputTokens, u.outputTokens, u.cacheReadInputTokens, u.cacheCreationInputTokens] : [u.inputTokens, u.outputTokens]),
      inputIncludesCache: split ? false : null, outputIncludesReasoning: true,
    }, 'message', id);
  }
}

export function messageMetadata(raw: Raw): MessageMetadata | undefined {
  const result: MessageMetadata = {};
  const values = {
    model: (typeof raw.model === 'object' ? raw.model?.id || raw.model?.modelID : raw.model || raw.modelId || raw.modelID) || raw.modelInfo?.id,
    provider: raw.provider || raw.providerId || raw.providerID || (typeof raw.model === 'object' ? raw.model?.providerID : undefined) || raw.modelInfo?.provider,
    agent: raw.agent, stopReason: raw.stopReason || raw.stop_reason || raw.finishReason || raw.finish_reason || raw.finish,
    nativeStopReason: raw.rawFinish,
    cwd: raw.cwd,
  };
  for (const [key, value] of Object.entries(values)) {
    const bounded = string(value, key === 'cwd' ? 4096 : 256);
    if (bounded) (result as Record<string, unknown>)[key] = bounded;
  }
  const elapsed = (end: unknown, start: unknown) => typeof end === 'number' && typeof start === 'number' && end >= start ? recordedCost(end - start) : null;
  const duration = recordedCost(raw.durationMs ?? raw.duration_ms ?? raw.tool_duration_ms) ?? elapsed(raw.time?.completed, raw.time?.created);
  if (duration !== null) result.durationMs = duration;
  const firstToken = elapsed(raw.time?.firstToken, raw.time?.created);
  if (firstToken !== null) result.firstTokenMs = firstToken;
  return Object.keys(result).length ? result : undefined;
}

export function sessionUsage(usage: RecordedUsage | undefined, partial = false): SessionUsage | undefined {
  if (!usage) return;
  const { scope: _scope, id: _id, ...values } = usage as Usage;
  return { ...values, source: 'session', partial: partial || usage.total === null, reportedMessages: 0, missingMessages: 0 };
}

/** Merge repeated native API identities (streaming snapshots), never equal text. */
export function mergeUsage(a: Usage, b: Usage): Usage {
  const merged = { ...a };
  for (const field of fields) merged[field] = a[field] === null ? b[field] : b[field] === null ? a[field] : Math.max(a[field]!, b[field]!);
  if (b.inputIncludesCache === false && a.inputIncludesCache !== false) merged.input = b.input;
  if (a.inputIncludesCache === false && b.inputIncludesCache !== false) merged.input = a.input;
  merged.inputIncludesCache = a.inputIncludesCache ?? b.inputIncludesCache;
  if (a.inputIncludesCache === false || b.inputIncludesCache === false) merged.inputIncludesCache = false;
  merged.outputIncludesReasoning = a.outputIncludesReasoning ?? b.outputIncludesReasoning;
  merged.cost = a.cost === null ? b.cost : b.cost === null ? a.cost : Math.max(a.cost, b.cost);
  merged.costEstimated = a.costEstimated || b.costEstimated || undefined;
  return merged;
}

export function sumUsage(values: readonly RecordedUsage[]): RecordedUsage | undefined {
  if (!values.length) return;
  const result = recordedUsage({ total: 0 })!;
  for (const field of fields) result[field] = sumTokens(values.map(value => value[field]));
  const costs = values.map(value => value.cost);
  result.cost = costs.every(value => recordedCost(value) !== null) ? recordedCost((costs as number[]).reduce((sum, value) => sum + value, 0)) : null;
  for (const flag of ['inputIncludesCache', 'outputIncludesReasoning'] as const) result[flag] = values.every(value => value[flag] === values[0][flag]) ? values[0][flag] : null;
  if (values.some(value => value.costEstimated)) result.costEstimated = true;
  const { scope: _scope, ...summary } = result;
  return summary;
}

export function summarizeUsage(session: Session, messages: readonly ImportedMessage[], historyPartial: boolean): SessionUsage {
  const native = session.usage?.source === 'session' ? session.usage : undefined;
  if (native && native.total !== null) return { ...native };
  // Existing supported session aggregates remain authoritative.
  if (tokenCount(session.tokens) !== null) return sessionUsage(recordedUsage({ total: session.tokens, cost: session.cost }))!;
  const cumulative = messages.filter(message => message.usage?.scope === 'session');
  const latest = [...cumulative].reverse().find(message => message.usage?.total !== null);
  if (latest?.usage) return sessionUsage(latest.usage, cumulative.at(-1) !== latest)!;
  const lastSnapshot = cumulative.at(-1);
  if (lastSnapshot?.usage) return sessionUsage(lastSnapshot.usage, true)!;
  const unique = new Map<string, Usage>(); let missing = 0;
  for (const message of messages) {
    if (message.usage?.scope === 'message') {
      const key = message.usage.id || message.id, previous = unique.get(key);
      unique.set(key, previous ? mergeUsage(previous, message.usage) : message.usage);
    } else if (message.role === 'assistant') missing++;
  }
  const records = [...unique.values()], known = records.filter(value => value.total !== null);
  if (!known.length && native) return { ...native, partial: true };
  const totals = sumUsage(records) || recordedUsage({ cost: session.cost }) || recordedUsage({ total: 0 })!;
  const { scope: _scope, id: _id, ...values } = totals as Usage;
  const total = known.length ? sumTokens(known.map(value => value.total)) : null;
  return { ...values, total,
    cost: totals.cost ?? native?.cost ?? recordedCost(session.cost),
    costEstimated: totals.cost !== null ? totals.costEstimated : native?.cost != null ? native.costEstimated : undefined,
    source: records.length ? 'messages' : 'unavailable', reportedMessages: known.length, missingMessages: missing + records.length - known.length,
    partial: historyPartial || total === null || missing > 0 || known.length !== records.length || !records.length };
}
