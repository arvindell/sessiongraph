import { readFile, writeFile } from 'node:fs/promises';
import { validVersion } from './release-version.mjs';

const version = process.argv[2];
if (!validVersion(version)) throw new Error('Pass a stable semver release version.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.version = version;
for (const name of Object.keys(pkg.optionalDependencies)) if (name.startsWith(`${pkg.name}-app-`)) pkg.optionalDependencies[name] = version;
if (process.env.GITHUB_SHA) pkg.sessionGraphCommit = process.env.GITHUB_SHA;
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
config.version = version;
await writeFile('src-tauri/tauri.conf.json', JSON.stringify(config, null, 2) + '\n');
const cargo = await readFile('src-tauri/Cargo.toml', 'utf8');
await writeFile('src-tauri/Cargo.toml', cargo.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
const lock = await readFile('src-tauri/Cargo.lock', 'utf8');
await writeFile('src-tauri/Cargo.lock', lock.replace(/(name = "sessiongraph"\nversion = )"[^"]+"/, `$1"${version}"`));
console.log(`Building SessionGraph ${version}`);
