import type { Preferences } from './preferences';
import type { ViewState } from './view-state';

export interface LibrarySettingsPatch { autoImport?: boolean; preferences?: Preferences; viewState?: ViewState }
export type SaveState = 'saved' | 'saving' | 'error';

/** Serialize writes and coalesce edits made while a request is in flight. */
export class LibrarySettingsSaver {
  revision = 0;
  state: SaveState = 'saved';
  private queued?: LibrarySettingsPatch;
  private task?: Promise<void>;
  private disposed = false;
  constructor(private write: (patch: LibrarySettingsPatch) => Promise<void>, private changed: (state: SaveState) => void) {}
  get pending() { return Boolean(this.queued || this.task); }
  private set(state: SaveState) { this.state = state; if (!this.disposed) this.changed(state); }
  save(patch: LibrarySettingsPatch) {
    if (this.disposed) return;
    this.revision++; this.queued = { ...this.queued, ...patch }; this.set('saving');
    void this.flush();
  }
  flush(): Promise<void> {
    if (this.task) return this.task;
    if (this.disposed || !this.queued) return Promise.resolve();
    const patch = this.queued; this.queued = undefined;
    this.set('saving');
    this.task = Promise.resolve().then(() => this.write(patch)).then(() => {
      this.task = undefined;
      if (this.queued) return this.flush();
      this.set('saved');
    }, () => {
      this.queued = { ...patch, ...this.queued }; this.task = undefined; this.set('error');
    });
    return this.task;
  }
  dispose() { this.disposed = true; }
}
