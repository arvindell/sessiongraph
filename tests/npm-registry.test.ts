import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Release helpers are plain Node.js modules.
import { getPublicVersion, verifyPublicVersion } from '../scripts/npm-registry.mjs';

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
