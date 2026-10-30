import type { FileChange, Project, Session, SourceStatus } from '../../src/types';
import type { Fragment } from '../../src/search/types';

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
}
export interface Candidate {
  session: Session;
  revision: string;
  locator: Record<string, string>;
}
export interface Discovery { sessions: Candidate[]; projects: Project[]; warnings: string[] }
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
