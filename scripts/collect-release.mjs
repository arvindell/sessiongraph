import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const target = `${process.platform}-${process.arch}`, output = 'release/assets';
await mkdir(output, { recursive: true });
const extensions = process.platform === 'darwin' ? ['.dmg'] : process.platform === 'win32' ? ['.exe', '.msi'] : ['.deb', '.rpm', '.AppImage'];
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() && !entry.name.endsWith('.app') ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []))).flat();
}
const bundles = await files('src-tauri/target/release/bundle');
for (const extension of extensions) {
  const candidates = bundles.filter((path) => path.endsWith(extension));
  if (candidates.length !== 1) throw new Error(`Expected one ${extension} installer, found ${candidates.length}.`);
  await copyFile(candidates[0], join(output, `session-atlas-${pkg.version}-${target}${extension}`));
}
const prefix = pkg.name.replace('@', '').replace('/', '-');
const platform = `${prefix}-app-${target}-${pkg.version}.tgz`;
await copyFile(join('release', platform), join(output, platform));
if (process.platform === 'linux' && process.arch === 'x64') {
  const launcher = `${prefix}-${pkg.version}.tgz`;
  await copyFile(join('release', launcher), join(output, launcher));
}
