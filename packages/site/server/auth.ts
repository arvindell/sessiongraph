import type { DB } from './db';
import { transaction } from './db';
import { HttpError, cookie, cookieValue, digest, json, origin, randomToken, readBody, redirect, requireMutation, seal, unseal, validChallenge, validUsername } from './security';
import { createHash } from 'node:crypto';

const SESSION_COOKIE = '__Host-sessiongraph';
const STATE_COOKIE = '__Host-sessiongraph-oauth';
const SESSION_SECONDS = 30 * 24 * 3600;
export async function authenticate(request: Request, db: DB) {
  const auth = request.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ?? false;
  const token = bearer ? auth!.slice(7) : cookie(request, SESSION_COOKIE);
  if (!token || !/^[\w-]{43}$/.test(token)) throw new HttpError(401, 'Sign in with GitHub.');
  const session = await db.loginSession.findUnique({ where: { hash: digest(token) } });
  if (!session || session.expiresAt.getTime() <= Date.now() || session.kind !== (bearer ? 'desktop' : 'web')) throw new HttpError(401, 'Your login expired. Sign in again.');
  const account = await db.account.findUnique({ where: { id: session.accountId } });
  if (!account?.username) throw new HttpError(401, 'Sign in again to refresh your GitHub username.');
  if (request.method !== 'GET') requireMutation(request, bearer);
  return { account, session, bearer };
}
export async function githubUser(path: string, token?: string) {
  const response = await fetch(`https://api.github.com/${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SessionGraph', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, response.status === 404 ? 'GitHub user not found.' : 'GitHub is unavailable. Please try again.');
  const user = await response.json();
  if (!Number.isSafeInteger(user.id) || !validUsername(user.login)) throw new HttpError(502, 'GitHub returned an invalid account.');
  return { id: String(user.id), username: user.login.toLowerCase() as string };
}
export async function authRoute(request: Request, db: DB, path: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (path === '/api/auth/github' && request.method === 'GET') {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) throw new HttpError(503, 'GitHub login is not configured yet.');
    const device = url.searchParams.get('device');
    if (device && !validChallenge(device)) throw new HttpError(400, 'Invalid desktop connection.');
    const state = randomToken(), verifier = randomToken();
    const target = new URL('https://github.com/login/oauth/authorize');
    target.search = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: `${origin()}/api/auth/callback`, state, scope: '', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return redirect(target.href, [cookieValue(STATE_COOKIE, seal({ state, verifier, device, expires: Date.now() + 600_000 }), 600)]);
  }
  if (path === '/api/auth/callback' && request.method === 'GET') {
    const state = unseal(cookie(request, STATE_COOKIE)) as { state?: string; verifier?: string; device?: string; expires?: number } | null;
    const clear = cookieValue(STATE_COOKIE, '', 0);
    if (!state?.state || state.state !== url.searchParams.get('state') || !state.expires || state.expires < Date.now() || !state.verifier || !url.searchParams.get('code')) return redirect(`${origin()}/account?error=login`, [clear]);
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, client_secret: process.env.GITHUB_CLIENT_SECRET!, code: url.searchParams.get('code')!, redirect_uri: `${origin()}/api/auth/callback`, code_verifier: state.verifier }), signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok || typeof data.access_token !== 'string') return redirect(`${origin()}/account?error=login`, [clear]);
    const user = await githubUser('user', data.access_token);
    // OAuth access/refresh tokens are discarded; SessionGraph never needs repository access.
    const token = randomToken();
    await transaction(db, async tx => {
      const previous = await tx.account.findUnique({ where: { username: user.username } });
      if (previous && previous.id !== user.id) {
        await tx.account.update({ where: { id: previous.id }, data: { username: null } });
        await tx.publication.deleteMany({ where: { accountId: previous.id } });
      }
      await tx.account.upsert({ where: { id: user.id }, create: user, update: { username: user.username } });
      await tx.loginSession.create({ data: { hash: digest(token), accountId: user.id, kind: 'web', expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) } });
    });
    return redirect(`${origin()}/account${state.device ? `?device=${state.device}` : ''}`, [clear, cookieValue(SESSION_COOKIE, token, SESSION_SECONDS)]);
  }
  if (path === '/api/auth/device/approve' && request.method === 'POST') {
    const { account, bearer } = await authenticate(request, db);
    if (bearer) throw new HttpError(403, 'Approve in your browser.');
    const body = await readBody(request);
    if (!validChallenge(body?.challenge)) throw new HttpError(400, 'Invalid desktop connection.');
    await db.deviceGrant.upsert({ where: { challenge: body.challenge }, create: { challenge: body.challenge, accountId: account.id, expiresAt: new Date(Date.now() + 120_000) }, update: { accountId: account.id, expiresAt: new Date(Date.now() + 120_000) } });
    return json({ approved: true });
  }
  if (path === '/api/auth/device' && request.method === 'POST') {
    // A 256-bit verifier authenticates this exchange; no browser cookie is accepted.
    requireMutation(request, true);
    const body = await readBody(request);
    if (typeof body?.verifier !== 'string' || !/^[\w-]{43}$/.test(body.verifier)) throw new HttpError(400, 'Invalid desktop connection.');
    const challenge = digest(body.verifier), token = randomToken();
    const result = await transaction(db, async tx => {
      const grant = await tx.deviceGrant.findUnique({ where: { challenge } });
      if (!grant || grant.expiresAt.getTime() <= Date.now()) return null;
      const removed = await tx.deviceGrant.deleteMany({ where: { challenge, accountId: grant.accountId, expiresAt: { gt: new Date() } } });
      if (removed.count !== 1) return null;
      const account = await tx.account.findUnique({ where: { id: grant.accountId } });
      if (!account?.username) return null;
      const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
      await tx.loginSession.create({ data: { hash: digest(token), accountId: account.id, kind: 'desktop', expiresAt } });
      return { token, username: account.username, expiresAt };
    });
    return result ? json(result) : json({ pending: true }, 202);
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const { session } = await authenticate(request, db);
    await db.loginSession.deleteMany({ where: { hash: session.hash } });
    return json({ signedOut: true }, 200, { 'Set-Cookie': cookieValue(SESSION_COOKIE, '', 0) });
  }
}
