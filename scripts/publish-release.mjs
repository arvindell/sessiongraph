import { readdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const directory = process.argv[2] || 'release/assets';
const files = (await readdir(directory)).filter((name) => name.endsWith('.tgz'));
const expected = new Set([pkg.name, ...Object.keys(pkg.optionalDependencies)]);
const version = process.env.RELEASE_VERSION || pkg.version;
const commit = process.env.GITHUB_SHA;
if (!commit) throw new Error('GITHUB_SHA is required to identify the release commit.');
const packages = files.map((file) => {
  const path = join(directory, file);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8', maxBuffer: 2_000_000 }));
  if (!expected.delete(manifest.name) || manifest.version !== version || manifest.sessionGraphCommit !== commit || manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') throw new Error(`Unexpected package or publishing configuration: ${file}`);
  if (manifest.name === pkg.name && Object.keys(pkg.optionalDependencies).some((name) => manifest.optionalDependencies?.[name] !== version)) throw new Error('Launcher native dependencies must match the release version.');
  return { path, manifest };
});
if (expected.size) throw new Error(`Missing packages: ${[...expected].join(', ')}`);
// Publish the launcher only after every matching native dependency is available.
packages.sort((a, b) => Number(a.manifest.name === pkg.name) - Number(b.manifest.name === pkg.name));
function npm(...args) {
  return spawnSync('npm', [...args, '--registry=https://registry.npmjs.org/', '--json'], { encoding: 'utf8', maxBuffer: 4_000_000 });
}
function requirePublic(name) {
  const status = npm('access', 'get', 'status', name);
  if (status.status !== 0 || JSON.parse(status.stdout)[name] !== 'public') throw new Error(`Could not verify public npm visibility for ${name}.`);
}
for (const { path, manifest } of packages) {
  const spec = `${manifest.name}@${version}`;
  const existing = npm('view', spec);
  if (existing.status === 0) {
    if (JSON.parse(existing.stdout).sessionGraphCommit !== commit) throw new Error(`${spec} already belongs to another commit.`);
    requirePublic(manifest.name);
    console.log(`Already published: ${spec}`);
    continue;
  }
  let error; try { error = JSON.parse(existing.stdout).error; } catch { /* Report registry failure below. */ }
  if (error?.code !== 'E404') throw new Error(`Registry lookup failed for ${spec}: ${existing.stderr}`);
  execFileSync('npm', ['publish', path, '--access=public', '--ignore-scripts', '--registry=https://registry.npmjs.org/'], { stdio: 'inherit' });
  requirePublic(manifest.name);
}
