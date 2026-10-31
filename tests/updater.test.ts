import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateController, type DesktopRelease, type UpdateState } from '../src/update-controller';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<DesktopRelease> = {}, restart = async () => {}) {
  const calls = { download: 0, install: 0, close: 0, restart: 0 }, states: UpdateState[] = [];
  const release: DesktopRelease = { version: '0.1.9', async download() { calls.download++; }, async install() { calls.install++; }, async close() { calls.close++; }, ...overrides };
  const controller = new UpdateController({ check: async () => release, async restart() { calls.restart++; await restart(); } }, (s) => states.push(s));
  return { calls, states, controller };
}

test('verified download is staged until a separate restart click; duplicate clicks do no work', async () => {
  const downloaded = deferred<void>(); let count = 0;
  const { controller, calls } = fixture({ async download(progress) {
    count++; progress({ event: 'Started', data: { contentLength: 10 } });
    progress({ event: 'Progress', data: { chunkLength: 10 } }); progress({ event: 'Finished' });
    await downloaded.promise;
  } });
  await controller.check(); const first = controller.activate(); await controller.activate();
  assert.equal(count, 1); assert.deepEqual(controller.state, { phase: 'downloading', version: '0.1.9', progress: 99 });
  assert.equal(calls.install, 0);
  downloaded.resolve(); await first;
  assert.equal(controller.state.phase, 'ready'); assert.equal(calls.restart, 0);
  await controller.activate(); assert.equal(calls.install, 1); assert.equal(calls.restart, 1);
  controller.dispose(); assert.equal(calls.close, 1);
});

test('transport completion cannot bypass signature failure; retry downloads again', async () => {
  let attempts = 0;
  const { controller, calls } = fixture({ async download(progress) { attempts++; progress({ event: 'Finished' }); if (attempts === 1) throw Error('Invalid signature'); } });
  await controller.check(); await controller.activate();
  assert.equal(controller.state.retry, 'download'); assert.equal(calls.install, 0);
  await controller.activate(); assert.equal(attempts, 2); assert.equal(controller.state.phase, 'ready');
  controller.dispose();
});

test('failed install retries installation; failed restart never installs a second time', async () => {
  let installs = 0, restarts = 0;
  const { controller, calls } = fixture({ async install() { if (++installs === 1) throw Error('Permission denied'); } }, async () => { if (++restarts === 1) throw Error('Restart failed'); });
  await controller.check(); await controller.activate(); await controller.activate();
  assert.equal(controller.state.retry, 'install');
  assert.equal(controller.state.error, 'Permission denied');
  await controller.activate(); assert.equal(controller.state.retry, 'restart');
  await controller.activate(); assert.equal(installs, 2); assert.equal(restarts, 2); assert.equal(calls.download, 1);
  controller.dispose();
});

test('offline checks remain silent, coalesce, and throttle without disabling later checks', async () => {
  let time = 0, checks = 0;
  const pending = deferred<null>(); const states: UpdateState[] = [];
  const controller = new UpdateController({ check() { checks++; return pending.promise; }, async restart() {} }, (s) => states.push(s), () => time);
  const first = controller.check(); await controller.check(); pending.reject(Error('Offline')); await first;
  await controller.check(); assert.equal(checks, 1); assert.deepEqual(states, []);
  time = 300_000; await controller.check(); assert.equal(checks, 2); controller.dispose();
});

test('disposal during a check or download closes resources only after outstanding work', async () => {
  const pending = deferred<DesktopRelease>(); let closed = 0, changes = 0;
  const release = { version: '2.0.0', async download() {}, async install() {}, async close() { closed++; } };
  const controller = new UpdateController({ check: () => pending.promise, async restart() {} }, () => changes++);
  const checking = controller.check(); controller.dispose(); pending.resolve(release); await checking;
  assert.equal(closed, 1); assert.equal(changes, 0);
  const download = deferred<void>();
  const f = fixture({ download: () => download.promise }); await f.controller.check();
  const activating = f.controller.activate(); f.controller.dispose(); assert.equal(f.calls.close, 0);
  const before = f.states.length; download.resolve(); await activating;
  assert.equal(f.calls.close, 1); assert.equal(f.calls.install, 0); assert.equal(f.states.length, before);
});
