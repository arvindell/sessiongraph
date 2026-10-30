import { mkdir, cp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pkg from '../package.json' with { type: 'json' };

const name = `${pkg.name}-app-${process.platform}-${process.arch}`;
const stage = join('release', name.split('/').at(-1));
await rm(join(stage, 'payload'), { recursive: true, force: true });
await mkdir(join(stage, 'payload'), { recursive: true });
const target = 'src-tauri/target/release';
if (process.platform === 'darwin') await cp(join(target, 'bundle/macos/SessionGraph.app'), join(stage, 'payload/SessionGraph.app'), { recursive: true });
else if (process.platform === 'win32') {
  await cp(join(target, 'sessiongraph.exe'), join(stage, 'payload/SessionGraph.exe'));
  await cp('src-tauri/resources', join(stage, 'payload/resources'), { recursive: true });
} else {
  const file = (await readdir(join(target, 'bundle/appimage'))).find((f) => f.toLowerCase().startsWith('sessiongraph_') && f.endsWith('.AppImage'));
  if (!file) throw new Error('Build a Linux AppImage first.');
  await cp(join(target, 'bundle/appimage', file), join(stage, 'payload/SessionGraph.AppImage'));
}
await writeFile(join(stage, 'package.json'), JSON.stringify({ name, version: pkg.version, description: `${pkg.description} — ${process.platform}/${process.arch}`, repository: pkg.repository, publishConfig: pkg.publishConfig, sessionGraphCommit: pkg.sessionGraphCommit, os: [process.platform], cpu: [process.arch], files: ['payload'], license: pkg.license }, null, 2));
const npmOptions = { stdio: 'inherit', shell: process.platform === 'win32' };
execFileSync('npm', ['pack', `./${stage}`, '--pack-destination', 'release'], npmOptions);
if (!process.argv.includes('--platform-only')) execFileSync('npm', ['pack', '--pack-destination', 'release'], npmOptions);
const tarball = (name) => `${name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
console.log(`\nInstall locally without publishing:\n  npx --package ./release/${tarball(pkg.name)} --package ./release/${tarball(name)} sessiongraph`);
