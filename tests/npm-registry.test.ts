import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Release helpers are plain Node.js modules.
import { getPublicVersion, verifyPublicVersion, waitForPublicVersion } from '../scripts/npm-registry.mjs';

test('npm publication verifies public metadata without tokens and distinguishes missing packages from registry failures', async () => {
  const metadata = { name: 'sessiongraph', version: '1.2.3', sessionGraphCommit: 'release-commit' };
  const value = await getPublicVersion('sessiongraph', '1.2.3', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://registry.npmjs.org/sessiongraph/1.2.3');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    return new Response(JSON.stringify(metadata));
  });
  verifyPublicVersion(value, 'sessiongraph', '1.2.3', 'release-commit');
  assert.throws(() => verifyPublicVersion(value, 'sessiongraph', '1.2.3', 'other-commit'), /Could not verify/);
  assert.throws(() => verifyPublicVersion(value, 'other-package', '1.2.3', 'release-commit'), /Could not verify/);
  assert.throws(() => verifyPublicVersion(undefined, 'sessiongraph', '1.2.3', 'release-commit'), /Could not verify/);
  assert.equal(await getPublicVersion('sessiongraph', '1.2.3', async () => new Response('', { status: 404 })), undefined);
  await assert.rejects(getPublicVersion('sessiongraph', '1.2.3', async () => new Response('', { status: 503 })), /HTTP 503/);
  await assert.rejects(getPublicVersion('sessiongraph', '1.2.3', async () => new Response('', { status: 401 })), /HTTP 401/);
});

test('accepted npm publications wait for processing and still verify the release identity', async () => {
  const metadata = { name: 'sessiongraph', version: '1.2.3', sessionGraphCommit: 'release-commit' };
  let reads = 0;
  const delays: number[] = [];
  const value = await waitForPublicVersion('sessiongraph', '1.2.3', 'release-commit', {
    request: async () => ++reads < 3 ? new Response('', { status: 404 }) : new Response(JSON.stringify(metadata)),
    delay: async (ms: number) => { delays.push(ms); }, attempts: 3, interval: 10,
  });
  assert.deepEqual(value, metadata); assert.equal(reads, 3); assert.deepEqual(delays, [10, 10]);
  await assert.rejects(waitForPublicVersion('sessiongraph', '1.2.3', 'other-commit', {
    request: async () => new Response(JSON.stringify(metadata)),
    delay: async () => assert.fail('Mismatched metadata must fail immediately'),
  }), /Could not verify/);
});

test('npm processing waits are bounded and do not hide authentication or registry failures', async () => {
  let reads = 0, delays = 0;
  await assert.rejects(waitForPublicVersion('sessiongraph', '1.2.3', 'release-commit', {
    request: async () => { reads++; return new Response('', { status: 404 }); },
    delay: async () => { delays++; }, attempts: 3,
  }), /not public yet.*timed out/);
  assert.equal(reads, 3); assert.equal(delays, 2);
  for (const status of [401, 503]) await assert.rejects(waitForPublicVersion('sessiongraph', '1.2.3', 'release-commit', {
    request: async () => new Response('', { status }),
    delay: async () => assert.fail('Registry errors must fail immediately'),
  }), new RegExp(`HTTP ${status}`));
});
