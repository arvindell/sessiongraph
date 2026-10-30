import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const serviceFile = (env: NodeJS.ProcessEnv = process.env) => env.SESSIONGRAPH_SERVICE_FILE || env.SESSION_ATLAS_SERVICE_FILE || env.ATLAS_SERVICE_FILE;

/** Reuse existing libraries in place, including WAL files and cross-process locks. */
export function databasePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()) {
  const override = env.SESSIONGRAPH_DATA_DIR || env.SESSION_ATLAS_DATA_DIR || env.ATLAS_DATA_DIR;
  const base = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.LOCALAPPDATA || home
    : env.XDG_DATA_HOME || join(home, '.local', 'share');
  const paths = [
    join(override || join(base, platform === 'linux' ? 'sessiongraph' : 'SessionGraph'), 'sessiongraph.sqlite'),
    join(override || join(base, platform === 'linux' ? 'session-atlas' : 'Session Atlas'), 'session-atlas.sqlite'),
    join(override || join(base, platform === 'linux' ? 'atlas' : 'Atlas'), 'atlas.sqlite'),
  ];
  return paths.find((path) => existsSync(path)) || paths[0];
}
