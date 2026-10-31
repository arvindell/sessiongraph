import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, loadPreferences, savePreferences, normalizePreferences, motionEnabled } from '../src/preferences';

test('preferences recover corrupt storage, reject invalid values, clamp rendering budgets and respect system motion', () => {
  assert.deepEqual(loadPreferences({ getItem: () => '{broken' }), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences({ getItem: () => JSON.stringify({ version: 99, values: { muted: true } }) }), DEFAULT_PREFERENCES);
  const old = loadPreferences({ getItem: () => JSON.stringify({ version: 1, values: { ambience: true, ambienceVolume: 100, clickVolume: 20 } }) });
  assert.equal('ambience' in old, false); assert.equal('ambienceVolume' in old, false); assert.equal(old.clickVolume, 20);
  assert.equal(old.autoImport, true);
  assert.equal(normalizePreferences({ autoImport: 'false' }).autoImport, true);
  let autoImportSaved = '';
  savePreferences({ setItem: (_key, value) => { autoImportSaved = value; } }, { ...old, autoImport: false });
  assert.equal(loadPreferences({ getItem: () => autoImportSaved }).autoImport, false);
  const values = normalizePreferences({ quality: 'ultra', muted: 'yes', bloom: Infinity, nodeScale: 5000, playbackSpeed: -1, motion: 'system', stars: false });
  assert.equal(values.quality, 'balanced'); assert.equal(values.muted, false); assert.equal(values.bloom, 32);
  assert.equal(values.nodeScale, 180); assert.equal(values.playbackSpeed, .25); assert.equal(values.stars, false);
  assert.equal(motionEnabled(values, true), false); assert.equal(motionEnabled({ ...values, motion: 'on' }, true), true);
  let saved = '';
  assert.equal(savePreferences({ setItem: (_key, value) => { saved = value; } }, values), true);
  assert.deepEqual(loadPreferences({ getItem: () => saved }), values);
  assert.equal(savePreferences({ setItem: () => { throw new Error('blocked'); } }, values), false);
});

test('SessionGraph restores legacy preferences and new saves take precedence', () => {
  const legacy = JSON.stringify({ version: 1, values: { muted: true, bloom: 18, trailFlow: true } });
  const entries = new Map([['session-atlas.preferences', legacy]]);
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  const values = loadPreferences(storage);
  assert.equal(values.muted, true); assert.equal(values.bloom, 18); assert.equal(values.trailFlow, true);
  assert.equal(savePreferences(storage, { ...values, muted: false }), true);
  assert.ok(entries.has(PREFERENCES_KEY));
  assert.equal(loadPreferences(storage).muted, false);
  assert.equal(entries.get('session-atlas.preferences'), legacy);
});
