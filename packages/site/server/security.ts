import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const validUsername = (value: unknown): value is string => typeof value === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);
export const validChallenge = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const origin = () => process.env.SITE_ORIGIN || 'https://sessiongraph.ai';
export function cookie(request: Request, name: string) {
  return (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}
export const cookieValue = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
export function requireMutation(request: Request, bearer = false) {
  if (request.headers.get('x-sessiongraph-action') !== '1') throw new HttpError(403, 'Use the SessionGraph application.');
  if (!bearer && request.headers.get('origin') !== origin()) throw new HttpError(403, 'Origin mismatch.');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
}
export async function readBody(request: Request, limit = 32_000): Promise<any> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'Request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing request body.');
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error('Authentication is not configured.');
  return value;
}
export function seal(value: unknown) {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${data}.${createHmac('sha256', secret()).update(data).digest('base64url')}`;
}
export function unseal(value: string | undefined): unknown {
  if (!value || value.length > 2048) return null;
  const [data, mac, extra] = value.split('.');
  if (!data || !mac || extra) return null;
  const expected = createHmac('sha256', secret()).update(data).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()); } catch { return null; }
}
export const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
export const redirect = (path: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: path, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
};
