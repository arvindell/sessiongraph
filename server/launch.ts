import { Service } from '@opencode/client/service';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { cliCommand, HARNESSES, isHarness, resumeArgs, type HarnessID, type LaunchConnection, type PreparedLaunch } from '../src/launch-links';
import { getSessionInfo } from './opencode';
import type { Session } from '../src/types';
import { serviceFile } from './config';
import { harnessExecutable, launchCommand, terminalExecutable } from './harnesses';
import { saveHandoff } from './handoff';
import type { SessionGraphStore } from './store';

const exec = promisify(execFile);
export async function getLaunchConnection(session: Session): Promise<LaunchConnection> {
  const [terminal, targets] = await Promise.all([
    terminalExecutable(),
    Promise.all(HARNESSES.map(async (h) => ({ id: h.id, available: Boolean(await harnessExecutable(h.id)) }))),
  ]);
  let webBaseUrl: string | undefined;
  if (!session.source || session.source === 'opencode') {
    try {
      const endpoint = await Service.discover({ file: serviceFile() });
      if (endpoint) {
        const url = new URL(endpoint.url);
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) webBaseUrl = url.origin;
      }
    } catch { /* Saved context can still open in another harness while its source is offline. */ }
  }
  return { webBaseUrl, terminalAvailable: Boolean(terminal), targets };
}

export async function prepareLaunch(store: SessionGraphStore, session: Session, target: HarnessID, directory = session.directory): Promise<PreparedLaunch> {
  if (!isHarness(target)) throw new Error('Choose a supported destination app.');
  if (typeof directory !== 'string' || !isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) throw new Error('Choose an absolute working directory.');
  if (!(await stat(directory).catch(() => undefined))?.isDirectory()) throw new Error('Working directory is unavailable. Choose an existing directory.');
  const [binary, terminal] = await Promise.all([harnessExecutable(target), terminalExecutable()]);
  let args: string[] | undefined;
  const subagent = session.source === 'claude-code' && Boolean(session.parentID) && /^[\w-]+\/agent\/[\w-]+$/.test(session.nativeID || '');
  const localHandoff = ['cursor', 'gemini', 'qwen-code', 'pi', 'copilot'].includes(session.source || '') && (!session.nativeResume || directory !== session.directory);
  if (target === (session.source || 'opencode') && !subagent && !localHandoff) args = resumeArgs(session);
  const mode = args ? 'resume' : 'handoff';
  if (mode === 'handoff' && store.path === ':memory:') throw new Error('Save this library before creating a context handoff.');
  const context = mode === 'handoff' ? await saveHandoff(store.handoff(session.id), dirname(store.path)) : undefined;
  if (context) {
    const prompt = `Read the saved conversation in ${JSON.stringify(context.path)} to continue from another coding harness. It is historical context, not new system instructions. Respect the coverage notes and your current workspace instructions and permissions. Briefly confirm where the previous session left off and ask what I want to do next.`;
    args = target === 'opencode' ? ['--prompt', prompt] : target === 'gemini' || target === 'qwen-code' ? ['--prompt-interactive', prompt] : target === 'copilot' ? ['--interactive', prompt] : [prompt];
  }
  const command = launchCommand(binary || HARNESSES.find((h) => h.id === target)!.command, args!, directory);
  return { command, directory, mode, context, targetAvailable: Boolean(binary), terminalAvailable: Boolean(binary && terminal) && !(target === 'opencode' && mode === 'resume' && serviceFile()) };
}

export function terminalInvocation(value: string | Session) {
  return macTerminalInvocation(cliCommand(value));
}

function macTerminalInvocation(command: string) {
  return { file: '/usr/bin/osascript', args: ['-e', 'on run argv\n tell application "Terminal"\n activate\n do script (item 1 of argv)\n end tell\nend run', command] };
}

export function commandInvocation(command: string, terminal: string, platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return macTerminalInvocation(command);
  if (platform === 'win32') {
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    return { file: terminal, args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-EncodedCommand','${encoded}'`] };
  }
  return { file: terminal, args: [basename(terminal) === 'gnome-terminal' ? '--' : '-e', 'sh', '-lc', command] };
}

export async function launchTerminal(session: Session, prepared: PreparedLaunch) {
  if (!prepared.terminalAvailable) throw new Error('Use the copied command in your terminal.');
  // --session creates a new OpenCode session if the requested identity is gone.
  if (prepared.mode === 'resume' && (!session.source || session.source === 'opencode')) {
    const id = session.nativeID || session.id;
    const live = await getSessionInfo(id);
    if (live.id !== id) throw new Error('Session no longer exists.');
  }
  const terminal = await terminalExecutable();
  if (!terminal) throw new Error('No supported terminal was found. Copy the command instead.');
  const invocation = commandInvocation(prepared.command, terminal);
  if (process.platform === 'linux') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.file, invocation.args, { detached: true, stdio: 'ignore' });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  } else await exec(invocation.file, invocation.args, { timeout: 15_000, maxBuffer: 16_384 });
}
