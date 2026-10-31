import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Release tooling is plain Node ESM, shared with the CI release job.
// @ts-expect-error No declaration file for the release script.
import { createManifest, updateTargets } from '../scripts/updater-manifest.mjs';

test('manifest covers every installer with pinned URLs and rejects incomplete or stale releases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiongraph-manifest-'));
  const signature = Buffer.from(`untrusted comment: test\n${Buffer.alloc(74).toString('base64')}\ntrusted comment: timestamp:1\tversion:0.1.9\n${Buffer.alloc(64).toString('base64')}\n`).toString('base64');
  try {
    for (const [target, , formats] of updateTargets) for (const [, extension] of formats) {
      const name = join(dir, `sessiongraph-${target}${extension}`);
      await writeFile(name, 'synthetic release fixture'); await writeFile(`${name}.sig`, signature);
    }
    const manifest = await createManifest(dir, '0.1.9');
    assert.equal(Object.keys(manifest.platforms).length, 15);
    for (const [key, value] of Object.entries(manifest.platforms) as [string, {url: string; signature: string}][]) {
      assert.ok(value.url.startsWith('https://github.com/arvindell/sessiongraph/releases/download/v0.1.9/'));
      assert.equal(value.signature, signature);
      if (key.endsWith('-deb')) assert.ok(value.url.endsWith('.deb'));
      if (key.endsWith('-rpm')) assert.ok(value.url.endsWith('.rpm'));
      if (key.endsWith('-msi')) assert.ok(value.url.endsWith('.msi'));
    }
    await assert.rejects(createManifest(dir, '0.1.10'), /version-bound signature/);
    await assert.rejects(createManifest(dir, '../latest'), /stable release/);
    const file = join(dir, 'sessiongraph-linux-arm64.rpm.sig');
    const saved = await readFile(file); await writeFile(file, '');
    await assert.rejects(createManifest(dir, '0.1.9'), /signature/);
    await writeFile(file, saved); await rm(join(dir, 'sessiongraph-linux-arm64.rpm'));
    await assert.rejects(createManifest(dir, '0.1.9'), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
