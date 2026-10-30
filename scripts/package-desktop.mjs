import { mkdir, cp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pkg from '../package.json' with { type: 'json' };

const name = `atlas-sessions-app-${process.platform}-${process.arch}`;
const stage = join('release', name);
await rm(join(stage, 'payload'), { recursive: true, force: true });
await mkdir(join(stage, 'payload'), { recursive: true });
const target = 'src-tauri/target/release';
if (process.platform === 'darwin') await cp(join(target, 'bundle/macos/Atlas.app'), join(stage, 'payload/Atlas.app'), { recursive: true });
else if (process.platform === 'win32') {
  await cp(join(target, 'atlas.exe'), join(stage, 'payload/Atlas.exe'));
  await cp('src-tauri/resources', join(stage, 'payload/resources'), { recursive: true });
} else {
  const file = (await readdir(join(target, 'bundle/appimage'))).find((f) => f.endsWith('.AppImage'));
  if (!file) throw new Error('Build a Linux AppImage first.');
  await cp(join(target, 'bundle/appimage', file), join(stage, 'payload/Atlas.AppImage'));
}
await writeFile(join(stage, 'package.json'), JSON.stringify({ name, version: pkg.version, description: `Atlas desktop for ${process.platform}/${process.arch}`, os: [process.platform], cpu: [process.arch], files: ['payload'], license: 'UNLICENSED' }, null, 2));
execFileSync('npm', ['pack', `./${stage}`, '--pack-destination', 'release'], { stdio: 'inherit' });
execFileSync('npm', ['pack', '--pack-destination', 'release'], { stdio: 'inherit' });
console.log(`\nInstall locally without publishing:\n  npx --package ./release/atlas-sessions-${pkg.version}.tgz --package ./release/${name}-${pkg.version}.tgz atlas`);
