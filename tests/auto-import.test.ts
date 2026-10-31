import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoImportScheduler, AUTO_IMPORT_INTERVAL, AUTO_IMPORT_COOLDOWN } from '../src/auto-import';

test('automatic checks wait for eligibility, coalesce focus/timer events and respect manual import activity', async () => {
  let now = 0, eligible = false, busy = false, calls = 0;
  const scheduler = new AutoImportScheduler({ eligible: () => eligible, busy: () => busy, refresh: async () => { calls++; } }, () => now);
  await scheduler.check(); assert.equal(calls, 0);
  eligible = true;
  await Promise.all([scheduler.check(), scheduler.check()]); assert.equal(calls, 1);
  now += AUTO_IMPORT_COOLDOWN - 1; await scheduler.check(); assert.equal(calls, 1);
  now++; busy = true; await scheduler.check(); assert.equal(calls, 1);
  scheduler.activity(); busy = false;
  await scheduler.check(); assert.equal(calls, 1);
  now += AUTO_IMPORT_INTERVAL; await scheduler.check(); assert.equal(calls, 2);
  eligible = false; now += AUTO_IMPORT_INTERVAL; await scheduler.check(); assert.equal(calls, 2);
  eligible = true; await scheduler.check(); assert.equal(calls, 3);
  scheduler.dispose(); now += AUTO_IMPORT_INTERVAL; await scheduler.check(); assert.equal(calls, 3);
});

test('slow or failed refreshes never overlap or trigger immediate retry loops', async () => {
  let now = 0, calls = 0;
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const scheduler = new AutoImportScheduler({ eligible: () => true, busy: () => false, refresh: () => { calls++; return pending; } }, () => now);
  const first = scheduler.check();
  now += AUTO_IMPORT_INTERVAL; await scheduler.check(); assert.equal(calls, 1);
  resolve(); await first;
  const failure = new AutoImportScheduler({ eligible: () => true, busy: () => false, refresh: async () => { calls++; throw new Error('offline'); } }, () => now);
  await assert.rejects(failure.check(), /offline/);
  await failure.check(); assert.equal(calls, 2);
  now += AUTO_IMPORT_INTERVAL; await assert.rejects(failure.check(), /offline/); assert.equal(calls, 3);
});
