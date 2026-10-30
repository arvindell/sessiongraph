import type { TimelinePage } from './timeline';

export type EventQuery = { item?: string; cursor?: string; filter?: string; revision?: string };
type Pending = { controller: AbortController; promise: Promise<TimelinePage>; readers: number };

/** Bounded in-memory snapshots shared by hover, details, and adjacent-event prefetch. */
export class TimelineClient {
  private pages = new Map<string, { page: TimelinePage; characters: number }>();
  private pending = new Map<string, Pending>();
  private characters = 0;
  private generation = 0;
  constructor(private request: typeof fetch = (...args) => fetch(...args)) {}
  clear() {
    this.generation++;
    this.pages.clear(); this.characters = 0;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
  }
  read(sessionID: string, query: EventQuery = {}, signal?: AbortSignal): Promise<TimelinePage> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const filter = query.filter || 'all';
    const key = JSON.stringify([sessionID, query.revision, filter, query.item, query.cursor]);
    const cached = query.revision ? this.pages.get(key) : undefined;
    if (cached) { this.pages.delete(key); this.pages.set(key, cached); return Promise.resolve(cached.page); }
    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController(), generation = this.generation;
      const params = new URLSearchParams({ filter, ...query });
      const promise = this.request(`/api/session-atlas/session/${encodeURIComponent(sessionID)}/events?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }).then(async (response) => {
        const page = await response.json();
        if (!response.ok) { if (response.status === 409) this.clear(); throw new Error(page.error || 'Could not load events.'); }
        if (controller.signal.aborted || generation !== this.generation) throw new DOMException('Request cancelled', 'AbortError');
        if (page.sessionID !== sessionID || (query.revision && page.revision !== query.revision)) throw new Error('Saved history changed. Reload the event explorer.');
        const cacheKey = JSON.stringify([sessionID, page.revision, filter, query.item, query.cursor]);
        const characters = JSON.stringify(page).length;
        this.characters -= this.pages.get(cacheKey)?.characters || 0;
        this.pages.delete(cacheKey);
        this.pages.set(cacheKey, { page, characters }); this.characters += characters;
        while (this.pages.size > 20 || this.characters > 2_000_000) {
          const oldest = this.pages.keys().next().value!;
          this.characters -= this.pages.get(oldest)!.characters; this.pages.delete(oldest);
        }
        return page as TimelinePage;
      });
      pending = { controller, promise, readers: 0 }; this.pending.set(key, pending);
      const current = pending;
      const finish = () => { if (this.pending.get(key) === current) this.pending.delete(key); };
      void promise.then(finish, finish);
    }
    const current = pending;
    current.readers++;
    return new Promise((resolve, reject) => {
      const abort = () => { release(); reject(signal!.reason); };
      let done = false;
      const release = () => {
        if (done) return; done = true;
        signal?.removeEventListener('abort', abort);
        if (--current.readers === 0 && this.pending.get(key) === current) { this.pending.delete(key); current.controller.abort(); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      void current.promise.then((page) => { if (!done) { release(); resolve(page); } }, (error) => { if (!done) { release(); reject(error); } });
    });
  }
}
