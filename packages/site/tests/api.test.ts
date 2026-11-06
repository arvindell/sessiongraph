import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { handle } from '../server/handler';
import { digest, randomToken, unseal } from '../server/security';
import { DEFAULT_PUBLISHING, publishableGraph } from '@sessiongraph/core/public-graph';
import { blankSession } from '../../../server/adapters/common';

test('public API authentication, ownership, publication and organization lifecycle', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.TEST_DATABASE_URL!;
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/sessiongraph_test', 'Tests require a dedicated local sessiongraph_test database.');
  const pool = new pg.Pool({ connectionString });
  await pool.query('DROP SCHEMA IF EXISTS sessiongraph CASCADE');
  for (const table of ['Account', 'LoginSession', 'DeviceGrant', 'Publication', 'RateLimit', 'Organization', 'Membership', 'Invitation']) await pool.query(`DROP TABLE IF EXISTS public."${table}"`);
  for (const migration of ['202611040001_public_profiles', '202611040002_application_schema']) {
    const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8');
    await pool.query(sql.replaceAll('INDEX ASYNC', 'INDEX'));
  }
  const db = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'sessiongraph' }) });
  process.env.AUTH_SECRET = 'test-only-secret-with-at-least-32-characters';
  process.env.GITHUB_CLIENT_ID = 'test-client'; process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  const originalFetch = globalThis.fetch;
  const tokens: Record<string, string> = {};
  const graph = publishableGraph([{ ...blankSession('opencode', 'private-id'), model: 'gpt-6-astra', created: 1700000000000, tokens: 123 }], DEFAULT_PUBLISHING);
  const request = (path: string, method = 'GET', body?: unknown, actor?: string, extra: Record<string, string> = {}) => handle(new Request(`https://sessiongraph.ai/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-sessiongraph-action': '1', 'x-real-ip': 'test', ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), db);
  async function seed(name: string, id: string, kind = 'desktop') {
    tokens[name] = randomToken();
    await db.account.create({ data: { id, username: name } });
    await db.loginSession.create({ data: { hash: digest(tokens[name]), accountId: id, kind, expiresAt: new Date(Date.now() + 86400_000) } });
  }
  try {
    await seed('alice', '101'); await seed('bob', '102'); await seed('eve', '103'); await seed('browser', '104', 'web');
    await t.test('anonymous writes, wrong credential types, expired sessions, CSRF and unknown payloads are rejected', async () => {
      assert.equal((await request('publication', 'PUT', { confirmed: true, graph })).status, 401);
      assert.equal((await request('publication', 'PUT', { confirmed: true, graph }, 'browser')).status, 401);
      assert.equal((await request('publication', 'PUT', { confirmed: true, graph }, undefined, { Cookie: `__Host-sessiongraph=${tokens.browser}`, Origin: 'https://evil.example' })).status, 403);
      assert.equal((await request('publication', 'PUT', { confirmed: false, graph }, 'alice')).status, 400);
      const bad = structuredClone(graph) as any; bad.sessions[0].title = 'private';
      assert.equal((await request('publication', 'PUT', { confirmed: true, graph: bad }, 'alice')).status, 400);
      assert.equal(await db.publication.count(), 0);
      await db.loginSession.update({ where: { hash: digest(tokens.eve) }, data: { expiresAt: new Date(0) } });
      assert.equal((await request('account', 'GET', undefined, 'eve')).status, 401);
      await db.loginSession.update({ where: { hash: digest(tokens.eve) }, data: { expiresAt: new Date(Date.now() + 86400_000) } });
    });
    await t.test('publishing replaces only the authenticated account; disabled fields disappear and unpublish removes the public API', async () => {
      assert.equal((await request('publication', 'PUT', { confirmed: true, graph }, 'alice')).status, 200);
      const publicResponse = await request('profiles/ALICE'); assert.equal(publicResponse.status, 200); assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await publicResponse.json()).graph, graph);
      assert.equal((await request('publication', 'DELETE', undefined, 'bob')).status, 200);
      assert.equal((await request('profiles/alice')).status, 200);
      const hidden = publishableGraph([blankSession('opencode', 'private')], { ...DEFAULT_PUBLISHING, tokens: false, timestamps: false, model: false });
      assert.equal((await request('publication', 'PUT', { confirmed: true, graph: hidden }, 'alice')).status, 200);
      const updated = (await (await request('profiles/alice')).json()).graph;
      assert.equal('tokens' in updated.sessions[0], false); assert.equal('timestamps' in updated.sessions[0], false); assert.equal('messageTimes' in updated.sessions[0], false);
      await request('publication', 'DELETE', undefined, 'alice'); assert.equal((await request('profiles/alice')).status, 404);
    });
    await t.test('desktop exchange requires browser approval, consumes grants once and persists only token hashes', async () => {
      const verifier = randomToken(), challenge = digest(verifier);
      assert.equal((await request('auth/device', 'POST', { verifier })).status, 202);
      assert.equal((await request('auth/device/approve', 'POST', { challenge }, 'alice')).status, 403);
      assert.equal((await request('auth/device/approve', 'POST', { challenge }, undefined, { Cookie: `__Host-sessiongraph=${tokens.browser}`, Origin: 'https://sessiongraph.ai' })).status, 200);
      const exchanges = await Promise.all([request('auth/device', 'POST', { verifier }), request('auth/device', 'POST', { verifier })]);
      assert.deepEqual(exchanges.map(r => r.status).sort(), [200, 202]);
      const credentials = await exchanges.find(r => r.status === 200)!.json();
      assert.equal(credentials.username, 'browser'); assert.match(credentials.token, /^[\w-]{43}$/);
      const stored = await db.loginSession.findUnique({ where: { hash: digest(credentials.token) } });
      assert.equal(stored?.kind, 'desktop'); assert.equal(await db.deviceGrant.count(), 0);
      assert.equal((await request('auth/device', 'POST', { verifier })).status, 202);
    });
    await t.test('organizations isolate tenants and enforce owner/admin/member roles and invitation identity', async () => {
      const created = await request('organizations', 'POST', { name: 'Test organization', slug: 'test-org' }, 'alice'); assert.equal(created.status, 201);
      const org = await created.json();
      assert.equal((await request(`organizations/${org.id}`, 'GET', undefined, 'bob')).status, 403);
      globalThis.fetch = async input => { assert.equal(String(input), 'https://api.github.com/users/bob'); return Response.json({ id: 102, login: 'bob' }); };
      assert.equal((await request(`organizations/${org.id}/invitations`, 'POST', { username: 'bob', role: 'member' }, 'alice')).status, 201);
      globalThis.fetch = originalFetch;
      const invitations = (await (await request('organizations', 'GET', undefined, 'bob')).json()).invitations;
      assert.equal(invitations.length, 1);
      assert.equal((await request(`invitations/${invitations[0].id}`, 'POST', {}, 'eve')).status, 404);
      assert.equal((await request(`invitations/${invitations[0].id}`, 'POST', {}, 'bob')).status, 200);
      assert.equal((await request(`organizations/${org.id}`, 'GET', undefined, 'bob')).status, 200);
      assert.equal((await request(`organizations/${org.id}/members/102`, 'PATCH', { role: 'admin' }, 'bob')).status, 403);
      assert.equal((await request(`organizations/${org.id}/members/102`, 'PATCH', { role: 'admin' }, 'alice')).status, 200);
      assert.equal((await request(`organizations/${org.id}/members/101`, 'DELETE', undefined, 'bob')).status, 403);
      assert.equal((await request(`organizations/${org.id}`, 'DELETE', undefined, 'bob')).status, 403);
      assert.equal((await request(`organizations/${org.id}/members/101`, 'DELETE', undefined, 'alice')).status, 403);
      assert.equal((await request(`organizations/${org.id}`, 'DELETE', undefined, 'alice')).status, 200);
      assert.equal(await db.membership.count(), 0); assert.equal(await db.invitation.count(), 0);
    });
    await t.test('OAuth binds state/PKCE to the browser and reassigns reused usernames without exposing the previous graph', async () => {
      await seed('reused-name', '200');
      await request('publication', 'PUT', { confirmed: true, graph }, 'reused-name');
      const start = await request('auth/github'); assert.equal(start.status, 303);
      const location = new URL(start.headers.get('location')!);
      assert.equal(location.searchParams.get('scope'), ''); assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
      const cookie = start.headers.getSetCookie()[0].split(';')[0];
      const state = unseal(cookie.slice(cookie.indexOf('=') + 1)) as any;
      assert.equal(location.searchParams.get('state'), state.state);
      const bad = await request('auth/callback?state=bad&code=fake', 'GET', undefined, undefined, { Cookie: cookie });
      assert.match(bad.headers.get('location')!, /error=login/);
      globalThis.fetch = async (input, init) => {
        if (String(input).includes('access_token')) { assert.equal(new URLSearchParams(String(init?.body)).get('code_verifier'), state.verifier); return Response.json({ access_token: 'discarded-provider-token' }); }
        assert.equal(String(input), 'https://api.github.com/user'); return Response.json({ id: 201, login: 'reused-name' });
      };
      const callback = await request(`auth/callback?state=${state.state}&code=fake`, 'GET', undefined, undefined, { Cookie: cookie });
      globalThis.fetch = originalFetch;
      assert.equal(callback.status, 303);
      const sessionCookie = callback.headers.getSetCookie().find(c => c.startsWith('__Host-sessiongraph='))!;
      assert.ok(sessionCookie.includes('HttpOnly') && sessionCookie.includes('Secure') && sessionCookie.includes('SameSite=Lax'));
      assert.equal((await db.account.findUnique({ where: { id: '200' } }))?.username, null);
      assert.equal((await request('profiles/reused-name')).status, 404);
      assert.equal(await db.publication.count(), 0);
    });
    await t.test('logout revokes server credentials immediately', async () => {
      assert.equal((await request('auth/logout', 'POST', {}, 'alice')).status, 200);
      assert.equal((await request('account', 'GET', undefined, 'alice')).status, 401);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await db.$disconnect(); await pool.query('DROP SCHEMA IF EXISTS sessiongraph CASCADE'); await pool.end();
  }
});
