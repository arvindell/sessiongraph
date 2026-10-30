import { Service } from '@opencode/client/service';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliCommand, type LaunchConnection } from '../src/launch-links';
import { getSessionInfo } from './opencode';
import type { Session } from '../src/types';

const exec = promisify(execFile);
export async function getLaunchConnection(session?: Session): Promise<LaunchConnection> {
  if (session?.source && session.source !== 'opencode') return { terminalAvailable: process.platform === 'darwin' && !session.nativeID?.includes('/') };
  const endpoint = await Service.discover({ file: process.env.ATLAS_SERVICE_FILE });
  if (!endpoint) throw new Error('OpenCode is unavailable.');
  const url = new URL(endpoint.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only local services are supported.');
  return { webBaseUrl: url.origin, terminalAvailable: process.platform === 'darwin' && !process.env.ATLAS_SERVICE_FILE };
}

export function terminalInvocation(id: string | Session) {
  return {
    file: '/usr/bin/osascript',
    args: ['-e', 'on run argv\n tell application "Terminal"\n activate\n do script (item 1 of argv)\n end tell\nend run', cliCommand(id)],
  };
}

export async function launchTerminal(value: Session) {
  if (process.platform !== 'darwin' || process.env.ATLAS_SERVICE_FILE) throw new Error('Use the copied command in your terminal.');
  const invocation = terminalInvocation(value);
  // Verify it still exists: --session would otherwise create a new session.
  if (!value.source || value.source === 'opencode') {
    const id = value.nativeID || value.id;
    const session = await getSessionInfo(id);
    if (session.id !== id) throw new Error('Session no longer exists.');
  }
  await exec(invocation.file, invocation.args, { timeout: 15_000, maxBuffer: 16_384 });
}
