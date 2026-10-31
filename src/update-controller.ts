import type { DownloadEvent } from '@tauri-apps/plugin-updater';

export interface DesktopRelease {
  version: string;
  download(progress: (event: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export interface UpdateBackend { check(): Promise<DesktopRelease | null>; restart(): Promise<void> }
export interface UpdateState {
  phase: 'hidden' | 'available' | 'downloading' | 'ready' | 'installing' | 'restarting' | 'error';
  version?: string;
  progress?: number;
  retry?: 'download' | 'install' | 'restart';
}

/** Stages verified downloads; installation and restart always require another click. */
export class UpdateController {
  state: UpdateState = { phase: 'hidden' };
  private release?: DesktopRelease;
  private busy = false;
  private disposed = false;
  private downloaded = false;
  private installed = false;
  private lastCheck = -Infinity;
  constructor(private backend: UpdateBackend, private changed: (state: UpdateState) => void, private now = Date.now) {}

  private set(state: UpdateState) { if (!this.disposed) { this.state = state; this.changed(state); } }
  private async close() { const release = this.release; this.release = undefined; await release?.close().catch(() => {}); }

  async check() {
    if (this.disposed || this.busy || this.release || this.now() - this.lastCheck < 5 * 60_000) return;
    this.busy = true; this.lastCheck = this.now();
    try {
      this.release = await this.backend.check() || undefined;
      if (this.release) this.set({ phase: 'available', version: this.release.version });
    } catch { /* Offline/missing manifests are silent; try again on the next scheduled check. */ }
    finally { this.busy = false; if (this.disposed) await this.close(); }
  }

  async activate() {
    if (this.disposed || this.busy || !this.release) return;
    this.busy = true;
    const { version } = this.release;
    let retry: UpdateState['retry'] = this.installed ? 'restart' : this.downloaded ? 'install' : 'download';
    try {
      if (!this.downloaded) {
        let total: number | undefined, received = 0;
        this.set({ phase: 'downloading', version });
        await this.release.download((event) => {
          if (event.event === 'Started') { total = event.data.contentLength; received = 0; }
          if (event.event === 'Progress') received += event.data.chunkLength;
          // Finished means transport completion; the promise must also pass signature verification.
          this.set({ phase: 'downloading', version, progress: total && total > 0 ? Math.min(99, Math.floor(received / total * 100)) : undefined });
        });
        this.downloaded = true;
        this.set({ phase: 'ready', version });
        return;
      }
      if (!this.installed) {
        this.set({ phase: 'installing', version });
        await this.release.install();
        this.installed = true;
      }
      if (this.disposed) return;
      retry = 'restart';
      this.set({ phase: 'restarting', version });
      await this.backend.restart();
    } catch { this.set({ phase: 'error', version, retry }); }
    finally { this.busy = false; if (this.disposed) await this.close(); }
  }

  dispose() { this.disposed = true; if (!this.busy) void this.close(); }
}
