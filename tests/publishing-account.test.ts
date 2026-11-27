import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { preloadPublishingAccount } from '../src/publishing-account';

test('sharing joins the account check started at app startup', async () => {
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { resolveResponse = resolve; });
  let requests = 0;
  const account = preloadPublishingAccount(async path => {
    assert.equal(path, '/api/sessiongraph/publishing/status');
    requests++;
    return response;
  });
  assert.equal(requests, 1);
  assert.equal(account.preloadedUsername, null);
  const check = account.check();
  assert.equal(account.check(), check);
  resolveResponse(Response.json({ username: 'alice', publication: {} }));
  assert.deepEqual(await check, { username: 'alice', published: true });
  assert.equal(requests, 1);
});

test('first open reuses a fresh startup result; later opens recheck', async () => {
  let requests = 0;
  const account = preloadPublishingAccount(async () => ++requests === 1
    ? Response.json({ username: 'alice', publication: null })
    : new Response(null, { status: 401 }));
  await setImmediate();
  assert.equal(account.preloadedUsername, 'alice');
  assert.deepEqual(await account.check(), { username: 'alice', published: false });
  assert.equal(requests, 1);
  assert.deepEqual(await account.check(), { username: null, published: false });
  assert.equal(requests, 2);
});

test('an older startup username can paint immediately but does not bypass rechecking', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let requests = 0;
  const account = preloadPublishingAccount(async () => {
    requests++;
    return Response.json({ username: 'alice', publication: null });
  });
  await setImmediate();
  now = 60_000;
  assert.equal(account.preloadedUsername, 'alice');
  await account.check();
  assert.equal(requests, 2);
});

test('failed or malformed checks are retryable and are not treated as signed out', async () => {
  const responses = [
    new Response(null, { status: 503 }),
    Response.json({ publication: null }),
    Response.json({ username: null, publication: null }),
  ];
  const account = preloadPublishingAccount(async () => responses.shift()!);
  await setImmediate(); // Failed startup check is handled even if the dialog never opens.
  await assert.rejects(account.check(), /Could not check sign-in/);
  assert.deepEqual(await account.check(), { username: null, published: false });
});
