import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { HARNESSES, type HarnessID } from '../src/launch-links';

export async function executable(name: string) {
  const home = homedir();
  const directories = [...(process.env.PATH || '').split(delimiter), join(home, '.local', 'bin'), join(home, '.opencode', 'bin'), join(home, '.bun', 'bin'), join(home, 'Library', 'pnpm'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (process.platform === 'win32' && process.env.APPDATA) directories.push(join(process.env.APPDATA, 'npm'));
  if (process.platform === 'win32' && process.env.SystemRoot) directories.push(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'));
  const candidates = isAbsolute(name) ? [name] : directories.filter((dir) => isAbsolute(dir)).flatMap((dir) =>
    (process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']).map((extension) => join(dir, name + extension)));
  for (const path of candidates) {
    try { if ((await stat(path)).isFile()) { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return path; } } catch { /* Try the next local installation. */ }
  }
}

export async function harnessExecutable(target: HarnessID) {
  const name = HARNESSES.find((h) => h.id === target)!.command;
  const path = await executable(name);
  if (path) return path;
  if (target === 'codex' && process.platform === 'darwin') {
    return await executable('/Applications/Codex.app/Contents/Resources/codex') || await executable(join(homedir(), 'Applications/Codex.app/Contents/Resources/codex'));
  }
}

export async function terminalExecutable() {
  if (process.platform === 'darwin') return executable('/usr/bin/osascript');
  if (process.platform === 'win32') return executable('powershell');
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return undefined;
  for (const name of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) { const path = await executable(name); if (path) return path; }
}

export function shellQuote(value: string, platform: NodeJS.Platform = process.platform) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Paths and launch arguments must not contain control characters.');
  return `'${value.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`;
}

export function launchCommand(binary: string, args: string[], directory: string, platform: NodeJS.Platform = process.platform) {
  const quote = (value: string) => shellQuote(value, platform);
  const invocation = [binary, ...args].map(quote).join(' ');
  return platform === 'win32'
    ? `Set-Location -LiteralPath ${quote(directory)}; if ($?) { & ${invocation} }`
    : `cd -- ${quote(directory)} && ${invocation}`;
}
