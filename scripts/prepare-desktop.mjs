import { cp, mkdir, chmod, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await mkdir('src-tauri/resources', { recursive: true });
await rm('src-tauri/resources/web', { recursive: true, force: true });
await cp('dist', 'src-tauri/resources/web', { recursive: true, force: true });
await copyFile('dist-server/server.mjs', 'src-tauri/resources/server.mjs');
await copyFile(process.execPath, `src-tauri/resources/${process.platform === 'win32' ? 'node.exe' : 'node'}`);
if (process.platform !== 'win32') await chmod('src-tauri/resources/node', 0o755);
// The distributable includes its own runtime; installed apps never require Node.
if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', 'src-tauri/resources/node']);
