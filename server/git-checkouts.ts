import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { Session } from '@sessiongraph/core/types';

type Checkout = NonNullable<Session['checkout']>;
const exec = promisify(execFile);
const cache = new Map<string, { expires: number; value: Promise<Checkout | undefined> }>();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' }, timeout: 1500, maxBuffer: 8192, windowsHide: true });
  return stdout.replace(/\r?\n$/, '');
}

function remoteIdentity(remote: string) {
  const scp = !remote.includes('://') && /^(?:[^@/\s]+@)?([\w.-]+):([^\\\s]+)$/.exec(remote);
  let host: string, path: string;
  if (scp) {
    [, host, path] = scp;
    if (/^[a-z]:[\\/]/i.test(remote)) return;
  } else {
    try {
      const url = new URL(remote);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return;
      host = url.host; path = url.pathname;
    } catch { return; }
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !/^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) return;
  host = host.toLowerCase();
  if (host === 'github.com') path = path.toLowerCase();
  return { key: `${host}/${path}`, label: path.split('/').at(-1)! };
}

async function inspect(directory: string): Promise<Checkout | undefined> {
  try {
    const [worktree, common, ...extra] = (await git(directory, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir')).split(/\r?\n/);
    if (extra.length || !isAbsolute(worktree) || !isAbsolute(common)) return;
    const origin = await git(worktree, 'config', '--local', '--no-includes', '--get', 'remote.origin.url').catch(() => '');
    const remote = remoteIdentity(origin);
    const key = remote ? `remote:${remote.key}` : `local:${common}`;
    return {
      worktree, repository: createHash('sha256').update(key).digest('hex'),
      repositoryLabel: remote?.label || (basename(common) === '.git' ? basename(common.slice(0, -5)) : basename(common)),
    };
  } catch { return; }
}

/** Resolve only saved working directories. Git reads local metadata; it never contacts remotes. */
export async function annotateGitCheckouts(sessions: Session[]) {
  const directories = [...new Set(sessions.map(session => session.directory))].filter(path => isAbsolute(path) && !/^[\\/]{2}/.test(path));
  const results = new Map<string, Checkout>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, directories.length) }, async () => {
    while (index < directories.length) {
      const directory = directories[index++];
      let entry = cache.get(directory);
      if (!entry || entry.expires <= Date.now()) {
        cache.delete(directory);
        if (cache.size >= 4096) cache.delete(cache.keys().next().value!);
        entry = { expires: Date.now() + 120_000, value: inspect(directory) };
        cache.set(directory, entry);
      }
      const checkout = await entry.value;
      if (checkout) results.set(directory, checkout);
    }
  }));
  return sessions.map(session => ({ ...session, checkout: results.get(session.directory) }));
}
