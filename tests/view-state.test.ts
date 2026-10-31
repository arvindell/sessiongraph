import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIEW_STATE, normalizeViewState } from '../src/view-state';
import { LibrarySettingsSaver, type LibrarySettingsPatch } from '../src/library-settings';

test('saved view state keeps false toggles and custom dates while rejecting malformed ranges and filters', () => {
  assert.deepEqual(normalizeViewState(null), DEFAULT_VIEW_STATE);
  assert.deepEqual(normalizeViewState({ days: 400, fromDate: '2026-02-31', toDate: 'invalid', includeChildren: 'false', directory: 'x'.repeat(4097) }), DEFAULT_VIEW_STATE);
  const range = normalizeViewState({ days: 0, includeArchived: false, includeChildren: false, fromDate: '2024-02-29', toDate: '2024-03-01', sourceID: 'codex' });
  assert.equal(range.days, 0); assert.equal(range.includeArchived, false); assert.equal(range.includeChildren, false); assert.equal(range.fromDate, '2024-02-29');
  assert.equal(normalizeViewState({ fromDate: '2026-10-20', toDate: '2026-10-01' }).fromDate, '');
});

test('library preference writes serialize and coalesce rapid edits without losing the latest state', async () => {
  const writes: LibrarySettingsPatch[] = [], releases: (() => void)[] = [];
  const saver = new LibrarySettingsSaver(async patch => { writes.push(patch); await new Promise<void>(resolve => releases.push(resolve)); }, () => {});
  saver.save({ autoImport: false }); await Promise.resolve();
  saver.save({ viewState: { ...DEFAULT_VIEW_STATE, days: 7 } });
  saver.save({ autoImport: true, viewState: { ...DEFAULT_VIEW_STATE, days: 30, includeArchived: false } });
  assert.equal(writes.length, 1); assert.equal(saver.pending, true);
  const done = saver.flush(); releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2); assert.equal(writes[1].autoImport, true); assert.equal(writes[1].viewState?.days, 30);
  releases.shift()!(); await done;
  assert.equal(saver.state, 'saved'); assert.equal(saver.pending, false);
});

test('failed preference writes retain edits for a retry and never claim they were saved', async () => {
  let offline = true;
  const writes: LibrarySettingsPatch[] = [];
  const saver = new LibrarySettingsSaver(async patch => { if (offline) throw Error('offline'); writes.push(patch); }, () => {});
  saver.save({ autoImport: false }); await saver.flush();
  assert.equal(saver.state, 'error'); assert.equal(saver.pending, true);
  offline = false; saver.save({ viewState: { ...DEFAULT_VIEW_STATE, days: 7 } }); await saver.flush();
  assert.equal(writes[0].autoImport, false); assert.equal(writes[0].viewState?.days, 7); assert.equal(saver.state, 'saved');
  saver.dispose(); saver.save({ autoImport: true }); assert.equal(writes.length, 1);
});
