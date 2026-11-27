/** Native counters, not text estimates. Cache/reasoning may be subsets: use total,
 * never blindly add the breakdown. Null means unreported, not zero. */
export interface RecordedUsage {
  total: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  tool: number | null;
  inputIncludesCache: boolean | null;
  outputIncludesReasoning: boolean | null;
  /** Native USD cost, when recorded. No pricing-table calculation is performed. */
  cost: number | null;
  costEstimated?: boolean;
}

export interface SessionUsage extends RecordedUsage {
  source: 'session' | 'messages' | 'unavailable';
  partial: boolean;
  reportedMessages: number;
  missingMessages: number;
}

export interface MessageMetadata {
  model?: string;
  provider?: string;
  agent?: string;
  stopReason?: string;
  nativeStopReason?: string;
  durationMs?: number;
  firstTokenMs?: number;
  /** This message's recorded context, never the session's latest directory. */
  cwd?: string;
}
