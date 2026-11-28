import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, opendir, rm, symlink, writeFile } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computerRoots, createClaudeLocationScanner, excludedScanPaths } from '../server/adapters/claude-locations';
import { createClaudeAdapter } from '../server/adapters/claude';
import { Importer } from '../server/importer';
import { SessionGraphStore } from '../server/store';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sessiongraph-claude-locations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function file(path: string, content = '') {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}

test('computer-wide discovery finds all readable users, mounted drives, and renamed homes without opening files', async t => {
  const root = await fixture(t), current = join(root, 'Users', 'alice', '.claude'), bob = join(root, 'Users', 'bob', '.claude');
  const external = join(root, 'Volumes', 'Archive', 'custom-agent-home'), legacy = join(root, 'opt', 'other-user', '.claude');
  await file(join(current, 'projects', 'app', `${randomUUID()}.jsonl`), 'not read during directory discovery');
  await file(join(bob, 'projects', 'app', `${randomUUID()}.jsonl`));
  await file(join(external, 'projects', 'app', `${randomUUID()}.jsonl`));
  await file(join(legacy, 'transcripts', 'old-export.jsonl'));
  await file(join(root, 'unrelated', 'projects', 'app', 'not-a-session.jsonl'));
  await file(join(current, 'settings.json'), 'not JSON and must never be parsed');
  const scan = createClaudeLocationScanner({ roots: async () => [root], preferredHome: () => current, now: () => 0 });
  const found = await scan();
  assert.deepEqual(new Set(found.homes), new Set([current, bob, external, legacy]));
  assert.equal(found.pending, false); assert.deepEqual(found.warnings, []);
});

test('computer-wide discovery resumes bounded slices, shares concurrent requests, and closes directory handles', async t => {
  const root = await fixture(t), current = join(root, 'alice', '.claude'), remote = join(root, 'archive', 'deep', '.claude');
  await file(join(current, 'projects', 'app', `${randomUUID()}.jsonl`));
  await file(join(remote, 'projects', 'app', `${randomUUID()}.jsonl`));
  let clock = 0, opened = 0;
  const handles: Dir[] = [];
  const scan = createClaudeLocationScanner({
    roots: async () => [root], preferredHome: () => current, now: () => clock, maxEntries: 1,
    openDirectory: (async (...args: Parameters<typeof opendir>) => { opened++; const handle = await opendir(...args); handles.push(handle); return handle; }) as typeof opendir,
  });
  const firstJob = scan(), sameJob = scan();
  assert.equal(firstJob, sameJob);
  let found = await firstJob;
  assert.equal(found.pending, true); assert.ok(found.warnings.some(w => w.includes('still in progress')));
  const before = opened; assert.equal(await scan(), found); assert.equal(opened, before);
  for (let i = 0; i < 100 && found.pending; i++) { clock += 1_001; found = await scan(); }
  assert.equal(found.pending, false); assert.ok(found.homes.includes(remote));
  assert.ok(!found.warnings.some(w => w.includes('still in progress')));
  for (const handle of handles) await assert.rejects(handle.read(), { code: 'ERR_DIR_CLOSED' });
});

test('time budgets pause directory enumeration and depth limits are disclosed', async t => {
  const root = await fixture(t), current = join(root, 'alice', '.claude');
  await mkdir(join(current, 'projects'), { recursive: true });
  let clock = 0;
  const timed = createClaudeLocationScanner({
    roots: async () => [root], preferredHome: () => current, now: () => clock,
    openDirectory: (async (path: string) => { clock += 2_001; return opendir(path); }) as typeof opendir,
  });
  assert.equal((await timed()).pending, true);
  const deep = join(root, ...Array.from({ length: 130 }, () => 'd'), '.claude', 'projects');
  await mkdir(deep, { recursive: true });
  const scan = createClaudeLocationScanner({ roots: async () => [root], preferredHome: () => current, now: () => 0 });
  const found = await scan();
  assert.equal(found.pending, false);
  assert.ok(found.warnings.some(w => w.includes('depth limit')));
});

test('completed scans restart after five minutes even when sources are checked frequently', async t => {
  const root = await fixture(t), current = join(root, 'alice', '.claude'), added = join(root, 'new-user', '.claude');
  await mkdir(join(current, 'projects'), { recursive: true });
  let clock = 0;
  const scan = createClaudeLocationScanner({ roots: async () => [root], preferredHome: () => current, now: () => clock });
  assert.equal((await scan()).pending, false);
  await mkdir(join(added, 'projects'), { recursive: true });
  for (clock = 60_000; clock < 300_000; clock += 60_000) assert.ok(!(await scan()).homes.includes(added));
  assert.ok((await scan()).homes.includes(added));
});

test('permission failures, disappearing directories, and virtual paths do not block other histories', async t => {
  const root = await fixture(t), current = join(root, 'alice', '.claude'), blocked = join(root, 'protected'), virtual = join(root, 'proc');
  await mkdir(join(current, 'projects'), { recursive: true });
  await mkdir(blocked); await mkdir(join(virtual, '.claude', 'projects'), { recursive: true });
  const scan = createClaudeLocationScanner({
    roots: async () => [root, join(root, 'missing')], preferredHome: () => current, now: () => 0, excluded: [virtual],
    openDirectory: (async (path: string) => {
      if (path === blocked) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      return opendir(path);
    }) as typeof opendir,
  });
  const found = await scan();
  assert.deepEqual(found.homes, [current]); assert.equal(found.pending, false);
  assert.ok(found.warnings.some(w => w.includes('1 unreadable or protected')));
  assert.deepEqual(excludedScanPaths('linux'), ['/dev', '/proc', '/sys', '/run']);
  assert.ok(excludedScanPaths('darwin').includes('/System/Volumes'));
  assert.deepEqual(await computerRoots('linux'), ['/']);
});

test('symlink cycles, linked homes, and linked transcript files are not traversed', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), outside = await fixture(t), current = join(root, 'alice', '.claude');
  await mkdir(join(current, 'projects'), { recursive: true });
  await file(join(outside, '.claude', 'projects', 'app', `${randomUUID()}.jsonl`));
  await symlink(root, join(root, 'cycle'));
  await symlink(join(outside, '.claude'), join(root, '.claude'));
  await mkdir(join(root, 'custom', 'projects', 'app'), { recursive: true });
  await symlink(join(outside, 'missing.jsonl'), join(root, 'custom', 'projects', 'app', `${randomUUID()}.jsonl`));
  const scan = createClaudeLocationScanner({ roots: async () => [root], preferredHome: () => current, now: () => 0 });
  assert.deepEqual((await scan()).homes, [current]);
});

test('pending searches remain importable and disclose progress even before finding any history', async t => {
  const root = await fixture(t);
  const adapter = createClaudeAdapter(async () => ({ homes: [], pending: true, warnings: ['Search is still in progress.'] }), () => root);
  const store = new SessionGraphStore(':memory:'); t.after(() => store.close());
  const importer = new Importer(store, [adapter]);
  assert.equal((await importer.sources())[0].available, true);
  importer.start(['claude-code']); await importer.settled();
  assert.equal(importer.status.failed, 0); assert.deepEqual(importer.status.warnings, ['Search is still in progress.']);
});
