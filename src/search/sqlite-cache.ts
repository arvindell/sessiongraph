import type { Session } from '../types';
import { MAX_CHARACTERS, validRecord, type CachedContent } from './persistence';

/** Browser worker bridge to Session Atlas's local SQLite index. No source/agent calls. */
export class SQLiteSearchCache {
  available = true;
  private epoch = 0;
  async restore(_source: string, sessions: Session[], consume: (record: CachedContent) => void) {
    const current = new Map(sessions.map((s) => [s.id, s]));
    let cursor: string | undefined, characters = 0;
    try {
      do {
        const response = await fetch(`/api/session-atlas/index${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
        if (!response.ok) throw new Error('Index unavailable');
        const page = await response.json() as { records: CachedContent[]; cursor?: string; epoch: number };
        this.epoch = page.epoch;
        for (const record of page.records) if (validRecord(record, current.get(record.id)) && characters + record.characters <= MAX_CHARACTERS) { characters += record.characters; consume(record); }
        cursor = page.cursor;
      } while (cursor);
      // Retire the pre-desktop IndexedDB cache after SQLite is reachable.
      try { globalThis.indexedDB?.deleteDatabase('atlas-search'); } catch { /* Optional browser storage. */ }
    } catch { this.available = false; }
  }
  async save(record: CachedContent) {
    if (!this.available) return;
    try {
      const response = await fetch('/api/session-atlas/index', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Atlas-Action': 'index' }, body: JSON.stringify({ record, epoch: this.epoch }) });
      if (!response.ok && response.status !== 409) this.available = false;
    } catch { this.available = false; }
  }
  async clear() {
    const response = await fetch('/api/session-atlas/index', { method: 'DELETE', headers: { 'X-Session-Atlas-Action': 'index' } });
    this.available = response.ok;
    if (!response.ok) throw new Error('Could not clear saved index.');
  }
}
