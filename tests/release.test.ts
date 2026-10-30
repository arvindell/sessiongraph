import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Release helpers run directly in Node, outside the TS build.
import { chooseVersion } from '../scripts/release-version.mjs';

test('releases increment stable tags numerically, respect a version bump, and reuse tagged commits on retries', () => {
  assert.equal(chooseVersion('0.1.0', [], []), '0.1.0');
  assert.equal(chooseVersion('0.1.0', ['v0.1.9', 'v0.1.10', 'v99.0.0-beta.1', 'unrelated'], []), '0.1.11');
  assert.equal(chooseVersion('0.2.0', ['v0.1.10'], []), '0.2.0');
  assert.equal(chooseVersion('0.1.0', ['v0.1.0', 'v0.1.1'], ['v0.1.0']), '0.1.0');
  assert.throws(() => chooseVersion('0.1.0-beta.1', [], []));
});
