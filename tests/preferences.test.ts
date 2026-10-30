import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences, normalizePreferences, motionEnabled } from '../src/preferences';

test('preferences recover corrupt storage, reject invalid values, clamp rendering budgets and respect system motion', () => {
  assert.deepEqual(loadPreferences({ getItem: () => '{broken' }), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences({ getItem: () => JSON.stringify({ version: 99, values: { muted: true } }) }), DEFAULT_PREFERENCES);
  const old = loadPreferences({ getItem: () => JSON.stringify({ version: 1, values: { ambience: true, ambienceVolume: 100, clickVolume: 20 } }) });
  assert.equal('ambience' in old, false); assert.equal('ambienceVolume' in old, false); assert.equal(old.clickVolume, 20);
  const values = normalizePreferences({ quality: 'ultra', muted: 'yes', bloom: Infinity, nodeScale: 5000, playbackSpeed: -1, motion: 'system', stars: false });
  assert.equal(values.quality, 'balanced'); assert.equal(values.muted, false); assert.equal(values.bloom, 32);
  assert.equal(values.nodeScale, 180); assert.equal(values.playbackSpeed, .25); assert.equal(values.stars, false);
  assert.equal(motionEnabled(values, true), false); assert.equal(motionEnabled({ ...values, motion: 'on' }, true), true);
  let saved = '';
  assert.equal(savePreferences({ setItem: (_key, value) => { saved = value; } }, values), true);
  assert.deepEqual(loadPreferences({ getItem: () => saved }), values);
  assert.equal(savePreferences({ setItem: () => { throw new Error('blocked'); } }, values), false);
});
