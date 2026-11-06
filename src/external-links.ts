import { openUrl } from '@tauri-apps/plugin-opener';

export function externalWebUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Choose a valid web link.');
  return url.href;
}

/** Await the native opener so failures are visible instead of swallowed by _blank handling. */
export async function openDesktopUrl(value: string, opener: (url: string) => Promise<void> = openUrl) {
  await opener(externalWebUrl(value));
}
