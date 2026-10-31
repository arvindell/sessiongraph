import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pkg from '../package.json' with { type: 'json' };

const target = `${process.platform}-${process.arch}`, output = 'release/assets';
await mkdir(output, { recursive: true });
const extensions = process.platform === 'darwin' ? ['.dmg', '.app.tar.gz'] : process.platform === 'win32' ? ['.exe', '.msi'] : ['.deb', '.rpm', '.AppImage'];
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() && !entry.name.endsWith('.app') ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []))).flat();
}
const bundles = await files('src-tauri/target/release/bundle');
for (const extension of extensions) {
  const candidates = bundles.filter((path) => path.endsWith(extension));
  if (candidates.length !== 1) throw new Error(`Expected one ${extension} installer, found ${candidates.length}.`);
  const destination = join(output, `sessiongraph-${target}${extension}`);
  await copyFile(candidates[0], destination);
  if (extension !== '.dmg') {
    // Sign every update format, including DEB/RPM, with a version-bound signature.
    // The key is supplied only to this step and the native build, never as an argument.
    execFileSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', '--app-version', pkg.version, destination], { stdio: 'inherit' });
  }
}
const prefix = pkg.name.replace('@', '').replace('/', '-');
const platform = `${prefix}-app-${target}-${pkg.version}.tgz`;
await copyFile(join('release', platform), join(output, platform));
if (process.platform === 'linux' && process.arch === 'x64') {
  const launcher = `${prefix}-${pkg.version}.tgz`;
  await copyFile(join('release', launcher), join(output, launcher));
}
