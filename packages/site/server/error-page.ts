import { HttpError, json } from './security';

const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Independent of the database, page templates, and JavaScript. */
export function errorResponse(request: Request, error: unknown) {
  const status = error instanceof HttpError ? error.status : (error as { code?: string })?.code === 'P2002' ? 409 : 503;
  const url = new URL(request.url);
  const navigation = (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) || (
    ['/api/auth/github', '/api/auth/callback'].includes(url.pathname) && request.headers.get('accept')?.includes('text/html')
  );
  if (!navigation) return json({ error: error instanceof HttpError ? error.message : status === 409
    ? 'That name or invitation already exists.' : 'The service is temporarily unavailable. Please try again.' }, status);

  const [title, message] = status === 404 ? ['Page not found.', 'Try exploring another graph.']
    : status === 429 ? ['One moment.', 'Please try again shortly.']
    : status === 400 ? ['Try another search.', 'Search for a GitHub username.']
    : ['Back in a moment.', 'Please try again shortly.'];
  // Never reflect exception messages or permit a protocol-relative retry link.
  const retry = status === 400 ? '/explore' : url.pathname.startsWith('//') ? '/' : url.pathname + url.search;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#080e13"><title>${title} — SessionGraph</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/error.css"></head>
<body><header><a class="brand" href="/"><img src="/assets/brand/mark.svg" width="32" height="32" alt="">SessionGraph</a></header>
<main><h1>${title}</h1><p>${message}</p><nav aria-label="Recovery">${status === 404 ? '' : `<a class="button" href="${escape(retry)}">${status === 400 ? 'Search graphs' : 'Try again'}</a>`}<a href="${status === 404 ? '/explore' : '/'}">${status === 404 ? 'Explore graphs' : 'Back home'}</a></nav></main></body></html>`;
  return new Response(request.method === 'HEAD' ? null : html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...(status === 429 || status === 503 ? { 'Retry-After': '60' } : {}),
  } });
}
