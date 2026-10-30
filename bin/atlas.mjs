#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
if (args.has('--version')) { console.log(`Atlas ${pkg.version}`); process.exit(0); }
if (args.has('--help')) {
  console.log('Atlas — local LLM session explorer\n\n  npx atlas-sessions          Open the desktop app\n  npx atlas-sessions --browser  Open the local browser app\n\nChoose session sources on first launch. All imports and indexing stay local.'); process.exit(0);
}
if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Atlas requires Node.js 24 or later for its launcher.'); process.exit(1); }
function open(target) {
  const [file, params] = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]] : ['xdg-open', [target]];
  const child = spawn(file, params, { stdio: 'ignore', detached: true });
  child.on('error', () => console.error('Could not open the application. Check your desktop environment.')); child.unref();
}
if (!args.has('--browser')) {
  const name = `atlas-sessions-app-${process.platform}-${process.arch}`;
  try {
    const manifest = require.resolve(`${name}/package.json`);
    const app = join(dirname(manifest), 'payload', process.platform === 'darwin' ? 'Atlas.app' : process.platform === 'win32' ? 'Atlas.exe' : 'Atlas.AppImage');
    if (process.platform === 'darwin') open(app);
    else { const child = spawn(app, [], { detached: true, stdio: 'ignore', env: { ...process.env, ...(process.platform === 'linux' ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}) } }); child.on('error', (e) => console.error(`Atlas could not open: ${e.message}`)); child.unref(); }
  } catch {
    console.error(`Desktop package ${name} is not installed.\nUse npx atlas-sessions --browser, or install the matching desktop package.\nFor a source checkout: pnpm desktop:dev`); process.exitCode = 1;
  }
} else {
  const child = spawn(process.execPath, [join(root, 'dist-server', 'server.mjs'), '--assets', join(root, 'dist'), '--parent-pid', String(process.pid)], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
  const lines = createInterface({ input: child.stdout });
  lines.once('line', (line) => {
    try { const { url } = JSON.parse(line); open(url); console.log('Atlas is open in your browser. Press Ctrl+C to close the local server.'); }
    catch { console.error('Atlas local server did not start.'); child.kill(); }
  });
  child.on('exit', (code) => { process.exitCode = code || 0; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); });
}
