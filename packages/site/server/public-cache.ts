import { dangerouslyDeleteByTag } from '@vercel/functions';
import { digest } from './security';

export const galleryTag = 'public-gallery';
export const profileTag = (username: string) => `public-profile:${username.toLowerCase()}`;

/** Browsers must revalidate; only Vercel may reuse these revocable public snapshots. */
export function publicResponse(request: Request, body: string, type: string, tags: string[], { cache = true } = {}) {
  const etag = `"${digest(body)}"`;
  const headers = {
    'Content-Type': type,
    'Cache-Control': cache ? 'public, max-age=0, must-revalidate' : 'no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': cache ? 'public, max-age=300' : 'no-store',
    'Vercel-Cache-Tag': tags.join(','),
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
    ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; sandbox" } : {}),
  };
  const unchanged = request.headers.get('if-none-match')?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
  return new Response(unchanged ? null : body, { status: unchanged ? 304 : 200, headers });
}

export async function purgePublicCache(usernames: string[], remove = dangerouslyDeleteByTag) {
  if (process.env.VERCEL !== '1') return;
  // Unpublish, field removal, and username reuse must not serve stale responses.
  // Await the foreground eviction request, rather than using SWR. Vercel's
  // edge propagation is asynchronous; this is not a global consistency barrier.
  await remove([galleryTag, ...new Set(usernames.map(profileTag))], { revalidationDeadlineSeconds: 0 });
}
