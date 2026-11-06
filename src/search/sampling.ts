import type { ContentPage, Fragment } from './types';

/** Shared browser/CLI sampling: prioritize prompts and filenames within a fair quota. */
export function sampleContent(page: ContentPage, budget: number) {
  let remaining = Math.max(0, budget), sampled = false;
  const fragments: Fragment[] = [];
  const ordered = [...page.fragments].sort((a, b) => Number(b.kind === 'File' || b.kind === 'You') - Number(a.kind === 'File' || a.kind === 'You'));
  const perFragment = Math.max(160, Math.min(2_000, Math.floor(remaining / Math.max(1, ordered.length))));
  for (const fragment of ordered) {
    if (remaining <= 0) { sampled = true; break; }
    const text = fragment.text.slice(0, Math.min(remaining, perFragment));
    sampled ||= text.length < fragment.text.length;
    fragments.push({ ...fragment, text }); remaining -= text.length;
  }
  return { fragments, characters: Math.max(0, budget) - remaining, partial: page.truncated || sampled };
}
