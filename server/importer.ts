import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { ImportStatus, SourceStatus } from '../src/types';
import type { ImportedMessage, SessionAdapter } from './adapters/types';
import { SessionGraphStore } from './store';
import { boundEventPayloads } from './events';

export class Importer {
  status: ImportStatus = { running: false, discovered: 0, imported: 0, unchanged: 0, failed: 0, errors: [] };
  private job?: Promise<void>;
  constructor(readonly store: SessionGraphStore, readonly adapters: SessionAdapter[]) {}
  async sources(): Promise<SourceStatus[]> {
    return Promise.all(this.adapters.map(async (adapter) => ({ id: adapter.id, name: adapter.name, description: adapter.description, capabilities: adapter.capabilities, available: await adapter.detect().catch(() => false), selected: this.store.selected().includes(adapter.id), ...this.store.sourceInfo(adapter.id) })));
  }
  start(ids?: string[]) {
    if (this.job) return this.status;
    if (ids?.some((id) => !this.adapters.some((a) => a.id === id))) throw new Error('Unknown session source.');
    if (!this.store.acquireImport()) throw new Error('Another SessionGraph window is importing this library.');
    if (ids) {
      this.store.setting('selected', [...new Set(ids)]);
    }
    this.status = { running: true, discovered: 0, imported: 0, unchanged: 0, failed: 0, errors: [] };
    const heartbeat = setInterval(() => this.store.heartbeat(), 5000);
    this.job = this.run().catch(() => { this.status.failed++; this.status.errors.push('Import interrupted. Re-import to resume remaining sessions.'); }).finally(() => { clearInterval(heartbeat); this.store.releaseImport(); this.status.running = false; this.status.source = undefined; this.job = undefined; });
    return this.status;
  }
  async settled() { await this.job; }
  private async run() {
    for (const adapter of this.adapters.filter((a) => this.store.selected().includes(a.id))) {
      this.status.source = adapter.id;
      try {
        if (!await adapter.detect()) throw new Error(`${adapter.name} is unavailable. Saved imports remain available.`);
        const discovery = await adapter.discover();
        const failedBefore = this.status.failed;
        const seen = new Map(discovery.sessions.map((candidate) => [candidate.session.id, candidate]));
        this.status.discovered += seen.size;
        this.status.errors.push(...discovery.warnings);
        for (const project of discovery.projects) this.store.db.prepare('INSERT INTO projects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(project.id, adapter.id, JSON.stringify(project));
        for (const candidate of seen.values()) {
          this.store.upsert(candidate);
          const saved = this.store.getSession(candidate.session.id);
          // A failed update or an older inconsistent metadata snapshot must be
          // retried, even if the source has returned to its saved revision.
          const retry = !saved?.coverage?.importedAt || saved.coverage.note?.startsWith('Latest import failed:');
          if (!retry && saved?.revision === candidate.revision && this.store.revision(candidate.session.id) === candidate.revision) { this.status.unchanged++; continue; }
          try {
            const messages = new Map<string, ImportedMessage>();
            const cursors = new Set<string>();
            let cursor: string | undefined, partial = false, characters = 0, pages = 0, note: string | undefined;
            do {
              const page = await adapter.read(candidate, cursor);
              partial ||= Boolean(page.partial); note = page.note || note;
              for (const message of page.messages) {
                if (!message.id || messages.has(message.id)) continue;
                if (messages.size >= 50_000 || characters >= 16_000_000) { partial = true; break; }
                let remaining = 16_000_000 - characters;
                message.fragments = message.fragments.flatMap((fragment) => {
                  const text = fragment.text.slice(0, remaining);
                  if (text.length < fragment.text.length) message.partial = true;
                  remaining -= text.length;
                  return text ? [{ ...fragment, text }] : [];
                });
                characters += boundEventPayloads(message, remaining);
                partial ||= Boolean(message.partial);
                characters += message.fragments.reduce((n, f) => n + f.text.length, 0);
                messages.set(message.id, message);
              }
              cursor = page.cursor; pages++;
              if (cursor && cursors.has(cursor)) throw new Error('Source returned a repeated history cursor.');
              if (cursor) cursors.add(cursor);
              if (pages >= 2000 || messages.size >= 50_000 || characters >= 16_000_000) { partial = true; note = `${note || ''} Import limited to 50,000 messages / 16 million text characters / 2,000 pages.`; break; }
              await yieldToIO();
            } while (cursor);
            // Time-ordered messages when timestamps exist; otherwise preserve
            // adapter order. OpenCode lists newest first and needs reversal.
            const values = [...messages.values()];
            if (adapter.id === 'opencode') values.reverse();
            this.store.replace(candidate, values, partial, note);
            this.status.imported++;
          } catch (error) {
            this.status.failed++;
            this.store.failed(candidate.session.id, error instanceof Error ? error.message : 'Unavailable');
            if (this.status.errors.length < 30) this.status.errors.push(`${adapter.name}: ${error instanceof Error ? error.message : 'Session import failed.'}`);
          }
          await yieldToIO();
        }
        this.store.recordSource(adapter.id, [this.status.failed > failedBefore ? `${this.status.failed - failedBefore} sessions could not be updated; import again to retry.` : '', ...discovery.warnings].filter(Boolean).join(' ') || undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : `${adapter.name} import failed.`;
        this.status.errors.push(message); this.store.recordSource(adapter.id, message); this.status.failed++;
      }
    }
  }
}
