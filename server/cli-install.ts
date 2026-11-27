import { constants } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const names = ['sessiongraph', 'ssg'];
const start = '# >>> SessionGraph CLI >>>', end = '# <<< SessionGraph CLI <<<';
const wrapperMarker = 'SessionGraph CLI launcher';
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

interface InstallOptions {
  resources: string;
  executable: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  registerWindowsPath?: (directory: string) => Promise<void>;
}

export function cliInstallDirectory(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'SessionGraph', 'cli');
  if (platform === 'win32') return join(env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local'), 'SessionGraph', 'cli');
  const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(data, 'sessiongraph', 'cli');
}

async function exists(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Write only app-owned files; leave unfamiliar command files untouched. */
async function writeOwned(path: string, content: string, marker: string, mode = 0o600) {
  const info = await exists(path);
  if (info) {
    if (!info.isFile() || !(await readFile(path, 'utf8')).includes(marker)) throw new Error(`CLI setup found an existing file: ${path}`);
    if (await readFile(path, 'utf8') === content) return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function shellPathBlock(directory: string, fish = false) {
  const path = quote(directory);
  const content = fish ? `fish_add_path --prepend --move --path ${path}` :
    `case ":\${PATH-}:" in\n  *:${path}:*) ;;\n  *) export PATH=${path}"\${PATH:+:$PATH}" ;;\nesac`;
  return `${start}\n${content}\n${end}`;
}

export function updateShellProfile(content: string, block: string) {
  const first = content.indexOf(start), last = content.indexOf(end);
  if (first >= 0 || last >= 0) {
    if (first < 0 || last < first || content.indexOf(start, first + start.length) >= 0 || content.indexOf(end, last + end.length) >= 0) {
      throw new Error('CLI setup found an incomplete or repeated PATH block. Check the SessionGraph CLI section in your shell profile.');
    }
    return content.slice(0, first) + block + content.slice(last + end.length);
  }
  return `${content}${content && !content.endsWith('\n') ? '\n' : ''}\n${block}\n`;
}

async function registerShellPath(directory: string, home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const shell = basename(env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'));
  let profiles: string[];
  if (shell === 'fish') {
    const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
    profiles = [join(config, 'fish', 'conf.d', 'sessiongraph-cli.fish')];
  } else if (shell === 'zsh') {
    const directory = env.ZDOTDIR && isAbsolute(env.ZDOTDIR) ? env.ZDOTDIR : home;
    profiles = [join(directory, '.zprofile'), join(directory, '.zshrc')];
  } else if (shell === 'bash') {
    const login = ['.bash_profile', '.bash_login', '.profile'].map(name => join(home, name));
    const existing = await Promise.all(login.map(exists));
    profiles = [login[existing.findIndex(Boolean) >= 0 ? existing.findIndex(Boolean) : 2], join(home, '.bashrc')];
  } else if (['sh', 'dash', 'ksh'].includes(shell)) {
    profiles = [join(home, '.profile')];
  } else {
    throw new Error(`Add ${directory} to PATH in your ${shell} configuration.`);
  }
  const block = shellPathBlock(directory, shell === 'fish');
  for (const profile of profiles) {
    await mkdir(dirname(profile), { recursive: true });
    const before = await exists(profile) ? await readFile(profile, 'utf8') : '';
    const after = updateShellProfile(before, block);
    if (after !== before) await writeFile(profile, after, { mode: 0o600 });
  }
  return profiles;
}

// Use raw registry values to preserve expandable entries and avoid setx's length limit.
export const windowsPathScript = `
$ErrorActionPreference = 'Stop'
$bin = $env:SESSIONGRAPH_CLI_BIN
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $path = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $found = @($path -split ';' | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $bin.TrimEnd('\\') })
  if ($found.Count -gt 0) { exit 0 }
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($null -ne $key.GetValue('Path')) { $kind = $key.GetValueKind('Path') }
  if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'Unsupported user PATH value type' }
  $value = if (!$path) { $bin } elseif ($path.EndsWith(';')) { $path + $bin } else { $path + ';' + $bin }
  $key.SetValue('Path', $value, $kind)
} finally { $key.Close() }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SessionGraphPath {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr wparam, string lparam, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][SessionGraphPath]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`;

async function registerWindowsPath(directory: string, env: NodeJS.ProcessEnv) {
  const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPathScript, 'utf16le').toString('base64')], {
    env: { ...env, SESSIONGRAPH_CLI_BIN: directory }, windowsHide: true, timeout: 15000,
  });
}

/**
 * Install a self-contained CLI in the user's application-data directory.
 * Versioned payloads keep existing commands usable during upgrades and after AppImage unmounts.
 */
export async function installDesktopCli(options: InstallOptions) {
  const { resources, executable } = options, home = options.home || homedir(), env = options.env || process.env, platform = options.platform || process.platform;
  if (!isAbsolute(resources) || !isAbsolute(executable) || !isAbsolute(home)) throw new Error('CLI setup requires absolute resource, application, and home paths.');
  const metadata = JSON.parse(await readFile(join(resources, 'cli-package.json'), 'utf8')) as { version: string; buildID: string };
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || !/^[a-f0-9]{64}$/.test(metadata.buildID)) throw new Error('Invalid bundled CLI metadata.');
  const root = cliInstallDirectory(home, env, platform), bin = join(root, 'bin');
  if (bin.includes(platform === 'win32' ? ';' : ':')) throw new Error(`CLI directory contains a PATH separator: ${bin}`);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const runtimeKey = `${process.version}-${platform}-${process.arch}`;
  const runtime = join(root, 'runtimes', runtimeKey);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const node = join(runtime, nodeName);
  const runtimeInfo = await exists(node);
  if (runtimeInfo && !runtimeInfo.isFile()) throw new Error(`CLI setup found an existing file: ${node}`);
  if (!runtimeInfo) {
    const temporary = `${node}.${randomUUID()}.tmp`;
    try {
      await copyFile(join(resources, nodeName), temporary, constants.COPYFILE_FICLONE);
      if (platform !== 'win32') await chmod(temporary, 0o755);
      await rename(temporary, node);
    } finally { await rm(temporary, { force: true }); }
  }
  const packageKey = `${metadata.version}-${metadata.buildID.slice(0, 16)}`, packages = join(root, 'packages'), target = join(packages, packageKey);
  await mkdir(packages, { recursive: true, mode: 0o700 });
  if (!await exists(target)) {
    const stage = join(packages, `.${packageKey}-${randomUUID()}`);
    try {
      await mkdir(join(stage, 'bin'), { recursive: true, mode: 0o700 });
      await mkdir(join(stage, 'dist-server'));
      await copyFile(join(resources, 'cli-launcher.mjs'), join(stage, 'bin', 'sessiongraph.mjs'));
      await copyFile(join(resources, 'cli.mjs'), join(stage, 'dist-server', 'cli.mjs'));
      await copyFile(join(resources, 'server.mjs'), join(stage, 'dist-server', 'server.mjs'));
      await copyFile(join(resources, 'LICENSE'), join(stage, 'LICENSE'));
      await cp(join(resources, 'web'), join(stage, 'dist'), { recursive: true });
      await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'sessiongraph', version: metadata.version, type: 'module', sessionGraphDesktopExecutable: executable }), { mode: 0o600 });
      await rename(stage, target);
    } finally { await rm(stage, { recursive: true, force: true }); }
  } else {
    // The app may have moved since the previous launch.
    const path = join(target, 'package.json'), pkg = JSON.parse(await readFile(path, 'utf8'));
    if (pkg.name !== 'sessiongraph' || pkg.version !== metadata.version || typeof pkg.sessionGraphDesktopExecutable !== 'string') {
      throw new Error(`CLI setup found an existing package: ${target}`);
    }
    if (pkg.sessionGraphDesktopExecutable !== executable) {
      pkg.sessionGraphDesktopExecutable = executable;
      await writeOwned(path, JSON.stringify(pkg), '"sessionGraphDesktopExecutable"');
    }
  }
  for (const name of names) {
    const script = platform === 'win32'
      ? `@echo off\r\nrem ${wrapperMarker}\r\n"%~dp0..\\runtimes\\${runtimeKey}\\node.exe" "%~dp0..\\packages\\${packageKey}\\bin\\sessiongraph.mjs" %*\r\n`
      : `#!/bin/sh\n# ${wrapperMarker}\nexec ${quote(node)} ${quote(join(target, 'bin', 'sessiongraph.mjs'))} "$@"\n`;
    await writeOwned(join(bin, platform === 'win32' ? `${name}.cmd` : name), script, wrapperMarker, 0o755);
  }
  const profiles = platform === 'win32'
    ? (await (options.registerWindowsPath || (directory => registerWindowsPath(directory, env)))(bin), [])
    : await registerShellPath(bin, home, env, platform);
  return { directory: root, bin, profiles };
}
