import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { databasePath } from './config';
import type { SessionGraphStore } from './store';
import { PUBLIC_GRAPH_MAX_MESSAGE_TIMES, PUBLIC_GRAPH_MAX_SESSIONS, publishableGraph, publishingSettings, type PublicGraph, type PublicMessageStats } from '@sessiongraph/core/public-graph';

export class PublishingError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const SITE = 'https://sessiongraph.ai';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
type Credential = { token: string; username: string; expiresAt: string };

/** Only scalar metadata is queried. Neither message bodies nor native IDs leave this function. */
export function preparePublicGraph(store: SessionGraphStore, ids: unknown, inputSettings: unknown): PublicGraph {
  if (!Array.isArray(ids) || !ids.length || ids.length > PUBLIC_GRAPH_MAX_SESSIONS || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new PublishingError('Choose a valid set of sessions.');
  const settings = publishingSettings(inputSettings);
  const stats = new Map<string, PublicMessageStats>();
  const count = store.db.prepare("SELECT count(*) AS count, count(*) FILTER (WHERE time IS NULL) AS untimed FROM timeline_items WHERE session_id=? AND kind='message' AND role IN ('user','assistant')");
  const times = store.db.prepare("SELECT time FROM timeline_items WHERE session_id=? AND kind='message' AND role IN ('user','assistant') AND time IS NOT NULL ORDER BY time,ordinal LIMIT ?");
  const coverage = store.db.prepare('SELECT partial FROM timeline_coverage WHERE session_id=?');
  let remaining = PUBLIC_GRAPH_MAX_MESSAGE_TIMES;
  // A synchronous read transaction sees one import revision for all selected sessions.
  store.db.exec('BEGIN');
  try {
    const sessions = ids.map(id => {
      const session = store.getSession(id);
      if (!session) throw new PublishingError('Your session selection changed. Reopen publishing.');
      if (settings.messageCounts) {
        const known = session.coverage?.history !== 'pending' && !!coverage.get(id);
        const totals = count.get(id)!;
        const rows = settings.messageTimestamps ? times.all(id, Math.min(remaining, 2000)) : [];
        remaining -= rows.length;
        const values = rows.map(row => Number(row.time));
        stats.set(id, { count: known ? Number(totals.count) : null, untimed: known ? Number(totals.untimed) : null,
          partial: !known || session.coverage?.history !== 'complete' || Boolean(coverage.get(id)?.partial),
          times: values, timesLimited: !known || Number(totals.count) - Number(totals.untimed) > values.length });
      }
      return session;
    });
    const result = publishableGraph(sessions, settings, stats);
    store.db.exec('COMMIT'); return result;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

/** Backend-only credentials; no token enters browser storage or a public graph. */
export class PublishingClient {
  private pending?: { verifier: string; expires: number; nextPoll: number };
  private preview?: { id: string; graph: PublicGraph; expires: number };
  private busy = false;
  constructor(private credentialPath = join(dirname(databasePath()), 'account.json'), private fetcher: typeof fetch = fetch) {}
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new PublishingError('Wait for the current account operation to finish.', 409);
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  private async credential(): Promise<Credential | null> {
    try {
      const saved = JSON.parse(await readFile(this.credentialPath, 'utf8'));
      if (typeof saved.token !== 'string' || !/^[\w-]{43}$/.test(saved.token) || typeof saved.username !== 'string' || !Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= Date.now()) return null;
      return saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new PublishingError('Could not read your saved login. Sign out and try again.'); }
  }
  private async save(value: Credential) {
    await mkdir(dirname(this.credentialPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.credentialPath}.${randomBytes(8).toString('hex')}`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.credentialPath); await chmod(this.credentialPath, 0o600); }
    finally { await rm(temporary, { force: true }); }
  }
  private async call(path: string, method = 'GET', value?: unknown, credential?: Credential | null) {
    const response = await this.fetcher(`${SITE}/api/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(25_000), headers: { 'Content-Type': 'application/json', 'x-sessiongraph-action': '1', ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) await rm(this.credentialPath, { force: true });
      throw new PublishingError(typeof data.error === 'string' ? data.error : 'The publishing service is unavailable.', response.status);
    }
    return data;
  }
  async status() {
    const credential = await this.credential();
    if (!credential) return { username: null, publication: null };
    return this.call('account', 'GET', undefined, credential);
  }
  login() {
    if (this.busy) throw new PublishingError('Wait for the current account operation to finish.', 409);
    const verifier = token(), challenge = hash(verifier);
    this.pending = { verifier, expires: Date.now() + 600_000, nextPoll: 0 };
    return { url: `${SITE}/account?device=${challenge}`, code: challenge.slice(0, 8).toUpperCase() };
  }
  async poll() {
    const pending = this.pending;
    if (!pending || pending.expires <= Date.now()) { this.pending = undefined; throw new PublishingError('Login expired. Start again.'); }
    if (this.busy || pending.nextPoll > Date.now()) return { pending: true };
    pending.nextPoll = Date.now() + 3000;
    return this.exclusive(async () => {
      const result = await this.call('auth/device', 'POST', { verifier: pending.verifier });
      if (this.pending !== pending || result.pending) return { pending: true };
      if (typeof result.token !== 'string' || !/^[\w-]{43}$/.test(result.token) || typeof result.username !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))) throw new PublishingError('Invalid login response.');
      await this.save(result); this.pending = undefined;
      return { username: result.username };
    });
  }
  prepare(store: SessionGraphStore, ids: unknown, settings: unknown) {
    this.preview = undefined;
    let graph: PublicGraph;
    try { graph = preparePublicGraph(store, ids, settings); }
    catch (error) { if (error instanceof PublishingError) throw error; throw new PublishingError(error instanceof Error ? error.message : 'Could not prepare the public graph.'); }
    const id = token(); this.preview = { id, graph, expires: Date.now() + 1800_000 };
    store.setting('publishing', graph.settings);
    return { id, graph };
  }
  async publish(previewID: unknown, confirmed: unknown) {
    return this.exclusive(async () => {
      const preview = this.preview;
      if (confirmed !== true || !preview || preview.id !== previewID || preview.expires < Date.now()) throw new PublishingError('Review a fresh preview before publishing.');
      const credential = await this.credential();
      if (!credential) throw new PublishingError('Sign in before publishing.', 401);
      const result = await this.call('publication', 'PUT', { confirmed: true, graph: preview.graph }, credential);
      if (this.preview === preview) this.preview = undefined;
      return result;
    });
  }
  async unpublish() {
    return this.exclusive(async () => {
      const credential = await this.credential();
      if (!credential) throw new PublishingError('Sign in before unpublishing.', 401);
      return this.call('publication', 'DELETE', undefined, credential);
    });
  }
  async logout() {
    return this.exclusive(async () => {
      this.pending = undefined; this.preview = undefined;
      const credential = await this.credential();
      // Keep the credential if remote revocation fails so the user can retry.
      if (credential) await this.call('auth/logout', 'POST', {}, credential);
      await rm(this.credentialPath, { force: true });
      return { signedOut: true };
    });
  }
}
