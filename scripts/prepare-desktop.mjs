import { cp, mkdir, chmod, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import pkg from '../package.json' with { type: 'json' };
await mkdir('src-tauri/resources', { recursive: true });
await rm('src-tauri/resources/web', { recursive: true, force: true });
await cp('dist', 'src-tauri/resources/web', { recursive: true, force: true });
await copyFile('dist-server/server.mjs', 'src-tauri/resources/server.mjs');
await copyFile('dist-server/cli.mjs', 'src-tauri/resources/cli.mjs');
await copyFile('dist-server/install-cli.mjs', 'src-tauri/resources/install-cli.mjs');
await copyFile('bin/sessiongraph.mjs', 'src-tauri/resources/cli-launcher.mjs');
const hash = createHash('sha256');
for (const file of ['dist-server/cli.mjs', 'dist-server/server.mjs', 'dist-server/install-cli.mjs', 'bin/sessiongraph.mjs', 'dist/index.html']) hash.update(await readFile(file));
await writeFile('src-tauri/resources/cli-package.json', JSON.stringify({ version: pkg.version, buildID: hash.digest('hex') }));
await copyFile('LICENSE', 'src-tauri/resources/LICENSE');
await copyFile(process.execPath, `src-tauri/resources/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
if (process.platform !== 'win32') await chmod('src-tauri/resources/node', 0o755);
// The distributable includes its own runtime; installed apps never require Node.
if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', 'src-tauri/resources/node']);
