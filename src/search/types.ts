import type { Project, Session } from '../types';

export interface Fragment { text: string; kind: 'You' | 'Assistant' | 'Tool' | 'File'; time: number }
export interface ContentPage {
  id: string;
  fragments: Fragment[];
  messages: number;
  nextCursor: string | null;
  truncated: boolean;
}
export interface SearchHit { id: string; score: number; source: string; excerpt: string; terms: string[] }
export interface IndexStatus { indexed: number; complete: number; total: number; characters: number; active: boolean; limited: boolean; failed: number; restored: number; storage: 'restoring' | 'local' | 'memory' }
export type SearchRequest =
  | { type: 'data'; sessions: Session[]; projects: Project[]; sourceID?: string }
  | { type: 'scope'; ids: string[] }
  | { type: 'query'; request: number; text: string; viewOnly: boolean; limit: number }
  | { type: 'warm'; enabled: boolean }
  | { type: 'clear-cache' };
export type SearchResponse =
  | { type: 'results'; request: number; hits: SearchHit[]; total: number; elapsed: number; error?: string }
  | { type: 'status'; status: IndexStatus }
  | { type: 'error'; message: string };
