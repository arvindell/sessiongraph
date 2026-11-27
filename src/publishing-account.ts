type PublishingAccount = { username: string | null; published: boolean };
const PRELOAD_MAX_AGE = 30_000;

// Start independently of the lazy-loaded share dialog and join any in-flight check.
export function preloadPublishingAccount(fetcher = fetch) {
  let pending: Promise<PublishingAccount> | undefined;
  let preloaded: { account: PublishingAccount; checkedAt: number } | undefined;
  let opened = false;

  async function fetchAccount(): Promise<PublishingAccount> {
    const response = await fetcher('/api/sessiongraph/publishing/status', { signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) return { username: null, published: false };
    if (!response.ok) throw new Error('Could not check sign-in.');
    const data = await response.json();
    if (data?.username === null) return { username: null, published: false };
    if (typeof data?.username !== 'string' || !data.username) throw new Error('Could not check sign-in.');
    return { username: data.username, published: Boolean(data.publication) };
  }

  const check = () => pending ??= fetchAccount().finally(() => { pending = undefined; });
  void check().then(account => {
    if (!opened) preloaded = { account, checkedAt: Date.now() };
  }, () => {}); // A failed startup check is retried when sharing opens.

  return {
    // An older username is useful for display, but must be rechecked before publishing.
    get preloadedUsername() { return preloaded?.account.username ?? null; },
    check() {
      opened = true;
      const initial = preloaded;
      preloaded = undefined;
      return initial && Date.now() - initial.checkedAt < PRELOAD_MAX_AGE ? Promise.resolve(initial.account) : check();
    },
  };
}
