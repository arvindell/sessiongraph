import type { SessionCommits } from '@sessiongraph/core/commits';
import { abbreviatedSHA } from '@sessiongraph/core/commits';

/** Lazy indexed pages; selecting a session never scans messages for commits. */
export function showCommitHistory(container: HTMLElement, sessionID: string, openEvidence: (id: string, revision: string) => void) {
  const controller = new AbortController();
  const heading = document.createElement('div'); heading.className = 'section-label'; heading.textContent = 'Commits';
  const total = document.createElement('span'); heading.append(total);
  const note = document.createElement('p'); note.className = 'coverage-note commit-coverage'; note.textContent = 'Loading commits…';
  const list = document.createElement('div'), more = document.createElement('button'); more.className = 'load-more'; more.hidden = true;
  container.replaceChildren(heading, note, list, more);
  let cursor: string | undefined, revision: string | undefined;
  async function load() {
    more.disabled = true;
    try {
      const query = new URLSearchParams({ limit: '30', ...(cursor ? { cursor } : {}) });
      const response = await fetch(`/api/sessiongraph/session/${encodeURIComponent(sessionID)}/commits?${query}`, { signal: controller.signal });
      const page = await response.json() as SessionCommits & { error?: string };
      if (!response.ok) throw new Error(page.error || 'Commit index unavailable.');
      if (controller.signal.aborted) return;
      revision = page.revision;
      total.textContent = page.total ? page.total.toLocaleString() : '';
      note.hidden = page.total > 0;
      note.textContent = page.coverage.state === 'pending' ? 'Commit indexing pending.'
        : page.coverage.state === 'unavailable' ? 'Commit history unavailable.'
        : 'No commits found.';
      for (const item of page.items) {
        const button = document.createElement('button'); button.className = 'relation';
        const content = document.createElement('span'), title = document.createElement('strong'), detail = document.createElement('small');
        title.textContent = `${item.sha.slice(0, 12)} · ${item.operation}`;
        detail.textContent = `${item.occurredAt === null ? 'Time not recorded' : new Date(item.occurredAt).toLocaleString()} · ${item.repositoryPath}`;
        button.title = `${item.sha}${abbreviatedSHA(item.sha) ? ' (abbreviated)' : ''} — inspect execution evidence`;
        content.append(title, detail); button.append(content);
        button.addEventListener('click', () => openEvidence(item.evidenceEventID, revision!), { signal: controller.signal });
        list.append(button);
      }
      cursor = page.nextCursor || undefined; more.hidden = !cursor; more.textContent = 'Load more commits';
    } catch (error) {
      if (controller.signal.aborted) return;
      total.textContent = ''; note.hidden = false;
      note.textContent = error instanceof Error ? error.message : 'Commit index unavailable.';
      // Retry from one consistent snapshot rather than mixing refreshed pages.
      cursor = undefined; list.replaceChildren(); more.hidden = false; more.textContent = 'Reload commits';
    } finally { more.disabled = false; }
  }
  more.addEventListener('click', () => void load(), { signal: controller.signal });
  void load();
  return () => controller.abort();
}
