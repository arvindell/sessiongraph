import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const serviceFile = () => process.env.SESSION_ATLAS_SERVICE_FILE || process.env.ATLAS_SERVICE_FILE;

/** Reuse existing libraries in place, including WAL files and cross-process locks. */
export function databasePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()) {
  const override = env.SESSION_ATLAS_DATA_DIR || env.ATLAS_DATA_DIR;
  const base = platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : platform === 'win32' ? env.LOCALAPPDATA || home
    : env.XDG_DATA_HOME || join(home, '.local', 'share');
  const directory = override || join(base, platform === 'linux' ? 'session-atlas' : 'Session Atlas');
  const path = join(directory, 'session-atlas.sqlite');
  if (existsSync(path)) return path;
  const legacy = join(override || join(base, platform === 'linux' ? 'atlas' : 'Atlas'), 'atlas.sqlite');
  return existsSync(legacy) ? legacy : path;
}
