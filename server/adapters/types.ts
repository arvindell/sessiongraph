import type { FileChange, Project, Session, SessionPullRequest, SourceStatus } from '@sessiongraph/core/types';
import type { Fragment } from '../../src/search/types';
import type { TimelineEvent } from '@sessiongraph/core/timeline';
import type { RecordedUsage, MessageMetadata } from '@sessiongraph/core/usage';

/** Native identity is independent of file locations, titles, and timestamps.
 * Adapters never execute an agent turn or modify the source's storage.
 */
export interface ImportedMessage {
  id: string;
  time: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  fragments: Fragment[];
  files: FileChange[];
  tools: string[];
  snapshots?: number;
  partial?: boolean;
  metadata?: MessageMetadata;
  usage?: RecordedUsage & { scope: 'message' | 'session'; id?: string };
  /** Pure lifecycle/usage records remain events, not conversation activity. */
  eventOnly?: boolean;
  locations?: { directory: string; time: number }[];
  /** Ordered source-neutral items. Undefined means a legacy flattened import. */
  events?: TimelineEvent[];
}
export interface Candidate {
  session: Session;
  /** Undefined means unavailable; an empty array is an authoritative empty set. */
  pullRequests?: SessionPullRequest[];
  revision: string;
  locator: Record<string, string>;
}
export interface Discovery {
  sessions: Candidate[];
  projects: Project[];
  warnings: string[];
  /** Read problems encountered during discovery; warnings describe coverage. */
  errors?: string[];
  /** An unreadable authoritative representation must not be replaced by a stale export. */
  blocked?: string[];
  unavailable?: boolean;
}
export interface HistoryPage { messages: ImportedMessage[]; cursor?: string; partial?: boolean; note?: string }
export interface SessionAdapter {
  id: string;
  name: string;
  description: string;
  capabilities: SourceStatus['capabilities'];
  detect(): Promise<boolean>;
  discover(): Promise<Discovery>;
  read(candidate: Candidate, cursor?: string): Promise<HistoryPage>;
}
