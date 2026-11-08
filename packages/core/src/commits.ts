/** Confirmed creation actions, never starting HEADs, pushes, or checkpoints. */
export type CommitOperation = 'created' | 'amended' | 'cherry-picked';
export interface SessionCommit {
  sessionID: string;
  /** Recorded object ID; non-40/64 lengths are unresolved abbreviations. */
  sha: string;
  /** Recorded Git execution directory, not a verified repository root. */
  repositoryPath: string;
  operation: CommitOperation;
  occurredAt: number | null;
  evidenceEventID: string;
}
export const abbreviatedSHA = (sha: string) => sha.length !== 40 && sha.length !== 64;
export interface CommitIndex {
  version: number;
  state: 'pending' | 'indexed' | 'partial' | 'unavailable';
  count: number | null;
  indexedAt?: number;
  note: string;
}
export interface SessionCommits {
  sessionID: string;
  revision: string;
  coverage: CommitIndex;
  items: SessionCommit[];
  total: number;
  nextCursor: string | null;
}
