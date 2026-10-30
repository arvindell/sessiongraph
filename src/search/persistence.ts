import type { Session } from '../types';
import type { Fragment } from './types';

export const MAX_CHARACTERS = 24_000_000;
export const SESSION_CHARACTERS = 48_000;
// Bump when extraction, sampling, or the stored search-document format changes.
const CACHE_VERSION = 2;
export const contentVersion = (session: Session) => JSON.stringify([CACHE_VERSION, session.revision, session.updated, session.created, session.projectID, session.directory]);
export interface CachedContent {
  id: string;
  version: string;
  fragments: Fragment[];
  pages: number;
  characters: number;
  partial: boolean;
  complete: boolean;
  capped: boolean;
  cursor?: string;
}
export function validRecord(value: CachedContent, session?: Session): boolean {
  if (!value || !session || value.id !== session.id || value.version !== contentVersion(session)) return false;
  if (!Number.isInteger(value.pages) || value.pages < 1 || value.pages > 8) return false;
  if (!Number.isInteger(value.characters) || value.characters < 0 || value.characters > SESSION_CHARACTERS) return false;
  if (typeof value.partial !== 'boolean' || typeof value.complete !== 'boolean' || typeof value.capped !== 'boolean') return false;
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || !/^\d{1,9}$/.test(value.cursor))) return false;
  if (value.complete && (value.partial || value.capped || value.cursor)) return false;
  if (!value.complete && !value.capped && (!value.cursor || value.pages >= 8)) return false;
  if (!Array.isArray(value.fragments) || value.fragments.length > SESSION_CHARACTERS) return false;
  let characters = 0;
  for (const fragment of value.fragments) {
    if (!fragment || !['You', 'Assistant', 'Tool', 'File'].includes(fragment.kind) || typeof fragment.text !== 'string' || fragment.text.length > 2_000 || !Number.isFinite(fragment.time)) return false;
    characters += fragment.text.length;
  }
  return characters === value.characters;
}
