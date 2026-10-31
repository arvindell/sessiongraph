import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// First format is also the fallback for portable/npm apps without installer metadata.
export const updateTargets = [
  ['darwin-arm64', 'darwin-aarch64', [['app', '.app.tar.gz']]],
  ['darwin-x64', 'darwin-x86_64', [['app', '.app.tar.gz']]],
  ['win32-x64', 'windows-x86_64', [['nsis', '.exe'], ['msi', '.msi']]],
  ['linux-x64', 'linux-x86_64', [['appimage', '.AppImage'], ['deb', '.deb'], ['rpm', '.rpm']]],
  ['linux-arm64', 'linux-aarch64', [['appimage', '.AppImage'], ['deb', '.deb'], ['rpm', '.rpm']]],
];

export async function createManifest(directory, version, date = new Date().toISOString()) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A stable release version is required.');
  const platforms = {};
  for (const [target, key, formats] of updateTargets) {
    for (const [type, extension] of formats) {
      const name = `sessiongraph-${target}${extension}`;
      if (!(await stat(join(directory, name))).size) throw new Error(`Empty update: ${name}`);
      const signature = (await readFile(join(directory, `${name}.sig`), 'utf8')).trim();
      const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split('\n');
      // Runtime cryptographic verification is performed by the official Tauri updater.
      // Catch unsigned, malformed, or stale build outputs before publishing the manifest.
      if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || Buffer.from(lines[1], 'base64').length !== 74 || Buffer.from(lines[3], 'base64').length !== 64 || !lines[2].startsWith('trusted comment: ') || !lines[2].split(/\s+/).includes(`version:${version}`)) {
        throw new Error(`Missing or mismatched version-bound signature: ${name}`);
      }
      const entry = { signature, url: `https://github.com/arvindell/sessiongraph/releases/download/v${version}/${name}` };
      platforms[`${key}-${type}`] = entry;
      platforms[key] ??= entry;
    }
  }
  return { version, notes: `SessionGraph ${version}. Release notes: https://github.com/arvindell/sessiongraph/releases/tag/v${version}`, pub_date: date, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2] || 'release/assets';
  const manifest = await createManifest(directory, process.env.RELEASE_VERSION);
  await writeFile(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Validated updater manifest for ${manifest.version}: ${Object.keys(manifest.platforms).length} platform mappings.`);
}
