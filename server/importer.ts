import { setImmediate as yieldToIO } from 'node:timers/promises';
import type { ImportStatus, SourceStatus } from '@sessiongraph/core/types';
import type { ImportedMessage, SessionAdapter } from './adapters/types';
import { SessionGraphStore } from './store';
import { boundEventPayloads } from './events';
import { withSourcePaths } from './source-paths';
import { IMPORT_METADATA_VERSION, mergeUsage } from './usage';

export class Importer {
  status: ImportStatus = { running: false, discovered: 0, imported: 0, unchanged: 0, failed: 0, errors: [], warnings: [] };
  private job?: Promise<void>;
  readonly adapters: SessionAdapter[];
  constructor(readonly store: SessionGraphStore, adapters: SessionAdapter[]) {
    this.adapters = adapters.map(adapter => withSourcePaths(adapter, () => this.store.setting<Record<string, string>>('sourcePaths') || {}));
  }
  async sources(): Promise<SourceStatus[]> {
    return Promise.all(this.adapters.map(async (adapter) => ({ id: adapter.id, name: adapter.name, description: adapter.description, capabilities: adapter.capabilities, available: await adapter.detect().catch(() => false), selected: this.store.selected().includes(adapter.id), ...this.store.sourceInfo(adapter.id) })));
  }
  start(ids?: string[], automatic = false) {
    return this.begin(ids, automatic, true);
  }
  /** A one-off subset refresh never replaces the saved source selection. */
  sync(ids?: string[]) { return this.begin(ids, false, false); }
  private begin(ids: string[] | undefined, automatic: boolean, save: boolean) {
    if (this.job) return this.status;
    // Recheck the saved choice for every automatic request, including other windows.
    if (automatic && (!this.store.autoImportEnabled() || !this.store.selected().length)) return this.status;
    if (ids?.some((id) => !this.adapters.some((a) => a.id === id))) throw new Error('Unknown session source.');
    if (!this.store.acquireImport()) throw new Error('Another SessionGraph window is importing this library.');
    if (ids && save) {
      this.store.setting('selected', [...new Set(ids)]);
    }
    this.status = { running: true, discovered: 0, imported: 0, unchanged: 0, failed: 0, errors: [], warnings: [] };
    const heartbeat = setInterval(() => this.store.heartbeat(), 5000);
    this.job = this.run(ids || this.store.selected()).catch(() => { this.status.failed++; this.status.errors.push('Import interrupted. Re-import to resume remaining sessions.'); }).finally(() => { clearInterval(heartbeat); this.store.releaseImport(); this.status.running = false; this.status.source = undefined; this.job = undefined; });
    return this.status;
  }
  async settled() { await this.job; }
  private report(kind: 'errors' | 'warnings', message: string) {
    const messages = this.status[kind] ??= [];
    if (!messages.includes(message)) messages.push(message);
  }
  private async run(ids: string[]) {
    for (const adapter of this.adapters.filter((a) => ids.includes(a.id))) {
      this.status.source = adapter.id;
      try {
        if (!await adapter.detect()) throw new Error('Source unavailable.');
        const discovery = await adapter.discover();
        const failedBefore = this.status.failed;
        const discoveryErrors = [...new Set(discovery.errors)];
        const seen = new Map(discovery.sessions.map((candidate) => [candidate.session.id, candidate]));
        this.status.discovered += seen.size;
        for (const warning of discovery.warnings) this.report('warnings', warning);
        for (const error of discoveryErrors) this.report('errors', error);
        if (discovery.unavailable && !discoveryErrors.length) {
          discoveryErrors.push(`${adapter.name}: History unavailable.`);
          this.report('errors', discoveryErrors[0]);
        }
        for (const project of discovery.projects) this.store.db.prepare('INSERT INTO projects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(project.id, adapter.id, JSON.stringify(project));
        for (const candidate of seen.values()) {
          const saved = this.store.getSession(candidate.session.id);
          // A failed update or an older inconsistent metadata snapshot must be
          // retried, even if the source has returned to its saved revision.
          const retry = !saved?.coverage?.importedAt || saved.importVersion !== IMPORT_METADATA_VERSION || saved.coverage.note?.startsWith('Latest import failed:') || !this.store.commitsCurrent(candidate.session.id);
          if (!retry && saved?.revision === candidate.revision && this.store.revision(candidate.session.id) === candidate.revision) { this.store.upsert(candidate); this.status.unchanged++; continue; }
          // New sessions need a pending row. Existing snapshots keep their
          // metadata and locator until replacement commits with their history.
          if (!saved) this.store.upsert(candidate);
          try {
            const messages = new Map<string, ImportedMessage>();
            const cursors = new Set<string>();
            let cursor: string | undefined, partial = false, characters = 0, pages = 0, note: string | undefined;
            do {
              const page = await adapter.read(candidate, cursor);
              partial ||= Boolean(page.partial); note = page.note || note;
              for (const message of page.messages) {
                if (!message.id) continue;
                const previous = messages.get(message.id);
                if (previous) {
                  if (message.usage) previous.usage = previous.usage ? mergeUsage(previous.usage, message.usage) : message.usage;
                  if (message.metadata) previous.metadata = { ...previous.metadata, ...message.metadata };
                  continue;
                }
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
              if (pages >= 2000 || messages.size >= 50_000 || characters >= 16_000_000) { partial = true; note = [note, 'Session import limit reached.'].filter(Boolean).join(' '); break; }
              await yieldToIO();
            } while (cursor);
            // Time-ordered messages when timestamps exist; otherwise preserve
            // adapter order. OpenCode lists newest first and needs reversal.
            const values = [...messages.values()];
            if (adapter.id === 'opencode') values.reverse();
            // A lifecycle-only export can describe an initially failed turn,
            // but must never erase a previously imported conversation.
            if (saved?.activity?.userMessages && values.every(message => message.role === 'system')) throw new Error('No readable conversation.');
            this.store.replace(candidate, values, partial, note);
            this.status.imported++;
          } catch (error) {
            this.status.failed++;
            this.store.failed(candidate.session.id, error instanceof Error ? error.message : 'Unavailable');
            if (this.status.errors.length < 30) this.report('errors', `${adapter.name}: ${error instanceof Error ? error.message : 'Session import failed.'}`);
          }
          await yieldToIO();
        }
        const failed = this.status.failed - failedBefore;
        if (discoveryErrors.length) this.status.failed++;
        this.store.recordSource(adapter.id, [...discoveryErrors, failed ? `${failed} ${failed === 1 ? 'session' : 'sessions'} failed to import. Run sync to retry.` : ''].filter(Boolean).join(' ') || undefined);
      } catch (error) {
        const message = `${adapter.name}: ${error instanceof Error ? error.message : 'Import failed.'}`;
        this.report('errors', message); this.store.recordSource(adapter.id, message); this.status.failed++;
      }
    }
  }
}
