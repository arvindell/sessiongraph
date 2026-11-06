import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { DEFAULT_PUBLISHING, PUBLIC_FIELDS, publishableGraph, publishingSettings, validatePublicGraph, publicGraphLayout } from '@sessiongraph/core/public-graph';
import { PublishingClient, preparePublicGraph } from '../server/publishing';
import { SessionGraphStore } from '../server/store';
import { blankSession, blankMessage } from '../server/adapters/common';

const secretSession = (id = 'native-secret') => ({ ...blankSession('opencode', id), title: 'Secret client', directory: '/private/customer/code', projectID: 'private-project', nativeID: id, model: 'openai/gpt-6-astra', created: 1700000000000, tokens: 123, activity: { firstMessageAt: 1700000000100, lastMessageAt: 1700000000900, userMessages: 1, untimedUserMessages: 0 }, coverage: { history: 'complete' as const } });

test('all publishing field combinations omit disabled fields and sensitive metadata', () => {
  for (let mask = 0; mask < 64; mask++) {
    const settings = publishingSettings(Object.fromEntries(Object.keys(PUBLIC_FIELDS).map((key, index) => [key, !!(mask & 1 << index)])));
    const session = secretSession(), graph = publishableGraph([session], settings);
    const json = JSON.stringify(graph);
    for (const secret of ['Secret client', '/private', 'private-project', 'native-secret', 'opencode:native', 'firstMessageAt']) assert.equal(json.includes(secret), false);
    const s = graph.sessions[0];
    for (const [setting, field] of [['tokens', 'tokens'], ['timestamps', 'timestamps'], ['messageCounts', 'messages'], ['messageTimestamps', 'messageTimes'], ['model', 'model'], ['harness', 'harness']] as const) assert.equal(field in s, settings[setting]);
    assert.deepEqual(validatePublicGraph(JSON.parse(json)), graph);
    assert.equal(publicGraphLayout(graph).nodes.length, 1);
  }
});

test('public ancestry is remapped only within the selected graph; unknown usage stays unknown', () => {
  const first = secretSession('first'), child = { ...secretSession('child'), parentID: first.id, forkID: 'outside-selection', tokens: null };
  const graph = publishableGraph([first, child], DEFAULT_PUBLISHING);
  const childPublic = graph.sessions.find(s => s.tokens === null)!;
  assert.equal(childPublic.parent, graph.sessions.find(s => s.tokens === 123)!.id);
  assert.equal(childPublic.fork, null);
  const only = publishableGraph([child], DEFAULT_PUBLISHING);
  assert.equal(only.sessions[0].parent, null);
  assert.equal(only.sessions[0].tokens, null);
  assert.equal(only.sessions[0].messages?.count, null);
});

test('public validator rejects hidden fields, arbitrary model/harness strings, cycles and nonnumeric usage', () => {
  const valid = publishableGraph([secretSession('a'), secretSession('b')], DEFAULT_PUBLISHING);
  for (const mutate of [
    (g: any) => { g.sessions[0].title = 'private'; },
    (g: any) => { g.sessions[0].timestamps.directory = '/private'; },
    (g: any) => { g.settings.tokens = false; },
    (g: any) => { g.sessions[0].model = 'customer-private-deployment'; },
    (g: any) => { g.sessions[0].harness = 'private'; },
    (g: any) => { g.sessions[0].parent = 1; g.sessions[1].parent = 0; },
    (g: any) => { g.sessions[0].parent = 100; },
    (g: any) => { g.sessions[0].tokens = '123'; },
    (g: any) => { g.sessions[0].tokens = -1; },
    (g: any) => { g.sessions[0].messageTimes.values = Array(2001).fill(1700000000000); },
  ]) { const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => validatePublicGraph(invalid)); }
  assert.equal(publishableGraph([{ ...secretSession(), model: 'customer-private-deployment', source: 'private' }], DEFAULT_PUBLISHING).sessions[0].model, null);
});

test('overlapping account writes cannot republish after unpublish or restore a signed-out credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiongraph-account-race-'));
  const store = new SessionGraphStore(':memory:');
  let resolveLogin!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveLogin = resolve; });
  let deletes = 0;
  const client = new PublishingClient(join(directory, 'account.json'), async (input, options) => {
    if (String(input).endsWith('/auth/device')) return pending;
    if (options?.method === 'DELETE') { deletes++; return Response.json({ unpublished: true }); }
    return Response.json({ saved: true });
  });
  try {
    client.login();
    const login = client.poll();
    await assert.rejects(client.logout(), { status: 409 });
    assert.throws(() => client.login(), { status: 409 });
    resolveLogin(Response.json({ token: randomBytes(32).toString('base64url'), username: 'alice', expiresAt: new Date(Date.now() + 86400_000).toISOString() }));
    await login;
    const candidate = { session: secretSession(), revision: '1', locator: {} }; store.upsert(candidate); store.replace(candidate, [], false);
    const preview = client.prepare(store, [candidate.session.id], DEFAULT_PUBLISHING);
    const publication = client.publish(preview.id, true);
    await assert.rejects(client.publish(preview.id, true), { status: 409 });
    await assert.rejects(client.unpublish(), { status: 409 });
    await assert.rejects(client.logout(), { status: 409 });
    await publication;
    const removal = client.unpublish();
    await assert.rejects(client.publish(preview.id, true), { status: 409 });
    await removal; assert.equal(deletes, 1);
    await client.logout();
    await assert.rejects(readFile(join(directory, 'account.json')));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('deep public ancestry renders without recursive stack exhaustion', () => {
  const sessions = Array.from({ length: 8000 }, (_, id) => ({ ...secretSession(String(id)), created: 1700000000000 + id, parentID: id < 7999 ? `opencode:${id + 1}` : undefined }));
  const graph = publishableGraph(sessions, { ...DEFAULT_PUBLISHING, messageCounts: false, messageTimestamps: false, timestamps: false });
  assert.equal(publicGraphLayout(graph).nodes.length, 8000);
});

test('publishing queries conversation counts/times without tool content and discloses partial history', () => {
  const store = new SessionGraphStore(':memory:');
  try {
    const session = secretSession(), candidate = { session, revision: '1', locator: {} };
    store.upsert(candidate);
    store.replace(candidate, [
      { ...blankMessage('user-secret', session.created + 1, 'user'), fragments: [{ kind: 'You', text: 'Secret prompt', time: session.created + 1 }] },
      { ...blankMessage('assistant-secret', 0, 'assistant'), fragments: [{ kind: 'Assistant', text: 'Secret answer', time: 0 }] },
      { ...blankMessage('tool-secret', session.created + 2, 'tool'), fragments: [{ kind: 'Tool', text: 'Secret tool', time: session.created + 2 }] },
    ], true);
    const graph = preparePublicGraph(store, [session.id], DEFAULT_PUBLISHING), s = graph.sessions[0];
    assert.equal(s.messages?.count, 2); assert.equal(s.messages?.untimed, 1); assert.equal(s.messages?.partial, true);
    assert.deepEqual(s.messageTimes?.values, [session.created + 1]);
    assert.equal(JSON.stringify(graph).includes('Secret'), false);
    assert.throws(() => preparePublicGraph(store, ['missing'], DEFAULT_PUBLISHING));
    assert.throws(() => preparePublicGraph(store, [session.id, session.id], DEFAULT_PUBLISHING));
  } finally { store.close(); }
});

test('desktop login keeps credentials out of responses; publication requires an exact confirmed preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiongraph-publishing-'));
  const store = new SessionGraphStore(':memory:'), calls: { path: string; body: any; auth: string | null }[] = [];
  const accessToken = randomBytes(32).toString('base64url');
  const fetcher: typeof fetch = async (input, options) => {
    const path = new URL(String(input)).pathname, body = options?.body ? JSON.parse(String(options.body)) : undefined;
    const auth = new Headers(options?.headers).get('authorization'); calls.push({ path, body, auth });
    if (path === '/api/auth/device') return Response.json({ token: accessToken, username: 'alice', expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    return Response.json(path === '/api/account' ? { username: 'alice', publication: null } : { saved: true });
  };
  const client = new PublishingClient(join(directory, 'account.json'), fetcher);
  try {
    await client.status(); assert.equal(calls.length, 0);
    const login = client.login(); assert.equal(calls.length, 0);
    const result = await client.poll(); assert.deepEqual(result, { username: 'alice' });
    const challenge = new URL(login.url).searchParams.get('device');
    assert.equal(challenge, createHash('sha256').update(calls[0].body.verifier).digest('hex'));
    assert.equal(JSON.stringify(result).includes(accessToken), false);
    assert.equal((await stat(join(directory, 'account.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(join(directory, 'account.json'), 'utf8')).token, accessToken);
    const candidate = { session: secretSession(), revision: '1', locator: {} }; store.upsert(candidate); store.replace(candidate, [], false);
    const preview = client.prepare(store, [candidate.session.id], DEFAULT_PUBLISHING);
    await assert.rejects(client.publish(preview.id, false)); await assert.rejects(client.publish('wrong', true));
    assert.equal(calls.length, 1);
    await client.publish(preview.id, true);
    const upload = calls.find(call => call.path === '/api/publication')!;
    assert.equal(upload.auth, `Bearer ${accessToken}`); assert.deepEqual(upload.body.graph, preview.graph);
    assert.equal(JSON.stringify(upload.body).includes('Secret client'), false);
    await assert.rejects(client.publish(preview.id, true));
    await client.unpublish(); await client.logout();
    await assert.rejects(readFile(join(directory, 'account.json')));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
