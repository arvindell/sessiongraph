import { homedir } from 'node:os';
import { join } from 'node:path';

export const homePath = (...parts: string[]) => join(homedir(), ...parts);
export const dataPath = (...parts: string[]) => join(process.env.XDG_DATA_HOME || homePath('.local/share'), ...parts);
export const configPath = (...parts: string[]) => join(process.env.XDG_CONFIG_HOME || homePath('.config'), ...parts);
export const appPath = (...parts: string[]) => join(process.platform === 'darwin' ? homePath('Library/Application Support') : process.platform === 'win32' ? process.env.APPDATA || homePath('AppData/Roaming') : process.env.XDG_CONFIG_HOME || homePath('.config'), ...parts);
export const tokscalePath = (...parts: string[]) => join(process.env.TOKSCALE_CONFIG_DIR || (process.platform === 'win32' ? appPath('tokscale') : configPath('tokscale')), ...parts);
export const envHome = (env: string, fallback: string, ...parts: string[]) => join(process.env[env]?.trim() || homePath(fallback), ...parts);
/** Each additional source accepts an explicit history directory, without scanning arbitrary projects. */
export const harnessRoots = (id: string, defaults: () => string[]) => () => {
  const override = process.env[`SESSIONGRAPH_${id.replace(/-/g, '_').toUpperCase()}_HISTORY_DIR`]?.trim();
  return override ? [override] : defaults();
};
