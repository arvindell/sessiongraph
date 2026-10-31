export const AUTO_IMPORT_INTERVAL = 60_000;
export const AUTO_IMPORT_COOLDOWN = 30_000;

/** Focus and timer checks share one cooldown, including manual import activity. */
export class AutoImportScheduler {
  private lastActivity = -Infinity;
  private checking = false;
  private disposed = false;
  constructor(private options: { eligible: () => boolean; busy: () => boolean; refresh: () => Promise<void> }, private now = Date.now) {}
  activity() { this.lastActivity = this.now(); }
  async check() {
    if (this.disposed || this.checking || !this.options.eligible() || this.options.busy() || this.now() - this.lastActivity < AUTO_IMPORT_COOLDOWN) return;
    this.checking = true; this.activity();
    try { await this.options.refresh(); }
    finally { this.checking = false; }
  }
  dispose() { this.disposed = true; }
}
