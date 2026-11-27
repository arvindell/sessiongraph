import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { cliInstallDirectory, installDesktopCli, shellPathBlock, updateShellProfile, windowsPathScript } from '../server/cli-install';

const exec = promisify(execFile);
let bundle: Promise<string> | undefined;
function cliBundle() {
  return bundle ||= build({ entryPoints: ['server/cli.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
    .then(result => result.outputFiles[0].text);
}

async function fixture(t: TestContext, platform = process.platform) {
  const dir = await mkdtemp(join(tmpdir(), 'sessiongraph-cli-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "user's home $(echo unsafe)"), resources = join(dir, 'mounted app', 'resources');
  await mkdir(home); await mkdir(join(resources, 'web'), { recursive: true });
  await copyFile(process.execPath, join(resources, platform === 'win32' ? 'node.exe' : 'node'), constants.COPYFILE_FICLONE);
  await copyFile('bin/sessiongraph.mjs', join(resources, 'cli-launcher.mjs'));
  await writeFile(join(resources, 'cli.mjs'), await cliBundle());
  await writeFile(join(resources, 'server.mjs'), '// Fixture server');
  await writeFile(join(resources, 'LICENSE'), 'Fixture license');
  await writeFile(join(resources, 'web', 'index.html'), '<!doctype html><title>Fixture</title>');
  await writeFile(join(resources, 'cli-package.json'), JSON.stringify({ version: '9.8.7', buildID: 'a'.repeat(64) }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: undefined, ZDOTDIR: undefined, SHELL: '/bin/zsh', SESSIONGRAPH_DATA_DIR: join(dir, 'library') };
  const registered: string[] = [];
  const options = { resources, executable: join(dir, 'installed app', 'SessionGraph'), home, env, platform,
    registerWindowsPath: async (directory: string) => { registered.push(directory); } };
  return { dir, home, resources, env, options, registered };
}

function command(bin: string, name: string, args: string[], env: NodeJS.ProcessEnv) {
  return exec(process.platform === 'win32' ? `${name}.cmd` : name, args, {
    env: { ...env, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` },
    shell: process.platform === 'win32', timeout: 20000, maxBuffer: 2_000_000,
  });
}

test('desktop CLI directories use per-user platform defaults and absolute overrides', () => {
  const home = join(tmpdir(), 'user'), data = join(home, 'custom-data');
  assert.equal(cliInstallDirectory(home, {}, 'darwin'), join(home, 'Library', 'Application Support', 'SessionGraph', 'cli'));
  assert.equal(cliInstallDirectory(home, {}, 'linux'), join(home, '.local', 'share', 'sessiongraph', 'cli'));
  assert.equal(cliInstallDirectory(home, { XDG_DATA_HOME: data }, 'linux'), join(data, 'sessiongraph', 'cli'));
  assert.equal(cliInstallDirectory(home, { XDG_DATA_HOME: 'relative' }, 'linux'), cliInstallDirectory(home, {}, 'linux'));
  assert.equal(cliInstallDirectory(home, { LOCALAPPDATA: data }, 'win32'), join(data, 'SessionGraph', 'cli'));
  assert.equal(cliInstallDirectory(home, { LOCALAPPDATA: 'relative' }, 'win32'), join(home, 'AppData', 'Local', 'SessionGraph', 'cli'));
});

test('PATH blocks preserve profile content and reject damaged or repeated markers', () => {
  const original = 'export CUSTOM_VALUE=kept\n', block = shellPathBlock('/home/user/cli/bin');
  const updated = updateShellProfile(original, block);
  assert.ok(updated.startsWith(original));
  assert.equal(updateShellProfile(updated, block), updated);
  assert.equal(updateShellProfile(updated, shellPathBlock('/new/bin')), updateShellProfile(original, shellPathBlock('/new/bin')));
  for (const content of ['# >>> SessionGraph CLI >>>', '# <<< SessionGraph CLI <<<', `${block}\n${block}`]) {
    assert.throws(() => updateShellProfile(content, block), /incomplete or repeated PATH block/);
  }
});

test('desktop commands run from PATH with their bundled Node after the app resources disappear', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), installed = await installDesktopCli(f.options);
  const profiles = installed.profiles;
  assert.deepEqual(profiles, [join(f.home, '.zprofile'), join(f.home, '.zshrc')]);
  const profile = await readFile(profiles[0], 'utf8');
  await installDesktopCli(f.options);
  assert.equal(await readFile(profiles[0], 'utf8'), profile);
  const runtimes = join(installed.directory, 'runtimes');
  const node = join(runtimes, (await readdir(runtimes))[0], 'node');
  const before = await stat(node);
  await installDesktopCli(f.options);
  assert.equal((await stat(node)).mtimeMs, before.mtimeMs, 'launches reuse the installed runtime');
  for (const name of ['sessiongraph', 'ssg']) {
    const version = await command(installed.bin, name, ['--version', '--json'], f.env);
    assert.equal(JSON.parse(version.stdout).data.version, '9.8.7');
  }
  await rm(join(f.dir, 'mounted app'), { recursive: true });
  const result = await exec('/bin/sh', ['-c', '. "$1"\n. "$1"\nexec ssg help search --json', 'cli-test', profiles[0]], {
    env: { ...f.env, PATH: '/usr/bin:/bin' }, maxBuffer: 2_000_000,
  });
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).data.commands[0].name, 'search');
  const path = await exec('/bin/sh', ['-c', '. "$1"\n. "$1"\nexec "$2" -e \'console.log(JSON.stringify(process.env.PATH))\'', 'cli-test', profiles[0], node], {
    env: { ...f.env, PATH: '/usr/bin:/bin' },
  });
  assert.deepEqual(JSON.parse(path.stdout).split(':'), [installed.bin, '/usr/bin', '/bin']);
  const search = await command(installed.bin, 'ssg', ['search', '"OAuth callback" in:messages', '--json'], f.env);
  assert.equal(JSON.parse(search.stdout).data.query, '"OAuth callback" in:messages');
});

test('desktop upgrades reuse Node, keep old payloads usable, and update the moved desktop path', async t => {
  const f = await fixture(t), installed = await installDesktopCli(f.options);
  const packages = join(installed.directory, 'packages'), first = (await readdir(packages))[0];
  const moved = join(f.dir, 'new app location', 'SessionGraph');
  await installDesktopCli({ ...f.options, executable: moved });
  assert.equal(JSON.parse(await readFile(join(packages, first, 'package.json'), 'utf8')).sessionGraphDesktopExecutable, moved);
  await writeFile(join(f.resources, 'cli-package.json'), JSON.stringify({ version: '9.8.8', buildID: 'b'.repeat(64) }));
  await installDesktopCli({ ...f.options, executable: moved });
  assert.equal((await readdir(join(installed.directory, 'runtimes'))).length, 1);
  assert.equal((await readdir(packages)).length, 2);
  assert.equal(JSON.parse((await command(installed.bin, 'ssg', ['--version', '--json'], f.env)).stdout).data.version, '9.8.8');
  const old = await exec(process.execPath, [join(packages, first, 'bin', 'sessiongraph.mjs'), '--version', '--json'], { env: f.env });
  assert.equal(JSON.parse(old.stdout).data.version, '9.8.7');
});

test('a failed payload upgrade preserves the working commands and profile', async t => {
  const f = await fixture(t), installed = await installDesktopCli(f.options);
  const wrapper = join(installed.bin, process.platform === 'win32' ? 'ssg.cmd' : 'ssg');
  const before = await readFile(wrapper, 'utf8');
  await writeFile(join(f.resources, 'cli-package.json'), JSON.stringify({ version: '9.8.8', buildID: 'b'.repeat(64) }));
  await rm(join(f.resources, 'cli.mjs'));
  await assert.rejects(installDesktopCli(f.options), { code: 'ENOENT' });
  assert.equal(await readFile(wrapper, 'utf8'), before);
  assert.equal((await readdir(join(installed.directory, 'packages'))).length, 1, 'incomplete staging directories are cleaned up');
  assert.equal(JSON.parse((await command(installed.bin, 'ssg', ['--version', '--json'], f.env)).stdout).data.version, '9.8.7');
});

test('bash, zsh, fish and sh registration respects existing profiles and custom configuration roots', async t => {
  const f = await fixture(t, 'linux');
  const bashHome = join(f.home, 'bash'), zshHome = join(f.home, 'zsh'), fishHome = join(f.home, 'fish'), shHome = join(f.home, 'sh');
  for (const home of [bashHome, zshHome, fishHome, shHome]) await mkdir(home);
  await writeFile(join(bashHome, '.bash_login'), 'export CUSTOM_VALUE=kept\n');
  const bash = await installDesktopCli({ ...f.options, home: bashHome, env: { ...f.env, SHELL: '/bin/bash' } });
  assert.deepEqual(bash.profiles, [join(bashHome, '.bash_login'), join(bashHome, '.bashrc')]);
  assert.ok((await readFile(bash.profiles[0], 'utf8')).startsWith('export CUSTOM_VALUE=kept\n'));
  await assert.rejects(access(join(bashHome, '.profile')));
  const zshConfig = join(zshHome, 'config');
  const zsh = await installDesktopCli({ ...f.options, home: zshHome, env: { ...f.env, SHELL: '/bin/zsh', ZDOTDIR: zshConfig } });
  assert.deepEqual(zsh.profiles, [join(zshConfig, '.zprofile'), join(zshConfig, '.zshrc')]);
  const fishConfig = join(fishHome, 'config');
  const fish = await installDesktopCli({ ...f.options, home: fishHome, env: { ...f.env, SHELL: '/bin/fish', XDG_CONFIG_HOME: fishConfig } });
  assert.deepEqual(fish.profiles, [join(fishConfig, 'fish', 'conf.d', 'sessiongraph-cli.fish')]);
  assert.match(await readFile(fish.profiles[0], 'utf8'), /fish_add_path --prepend --move --path/);
  const sh = await installDesktopCli({ ...f.options, home: shHome, env: { ...f.env, SHELL: '/bin/sh' } });
  assert.deepEqual(sh.profiles, [join(shHome, '.profile')]);
  await assert.rejects(installDesktopCli({ ...f.options, env: { ...f.env, SHELL: '/bin/nu' } }), /Add .* to PATH in your nu configuration/);
});

test('Windows shims use relative quoted paths and register only the user environment', async t => {
  const f = await fixture(t, 'win32'), installed = await installDesktopCli(f.options);
  assert.deepEqual(installed.profiles, []);
  assert.deepEqual(f.registered, [installed.bin]);
  for (const name of ['sessiongraph', 'ssg']) {
    const shim = await readFile(join(installed.bin, `${name}.cmd`), 'utf8');
    assert.match(shim, /"%~dp0\.\.\\runtimes\\[^"]+\\node\.exe" "%~dp0\.\.\\packages\\[^"]+\\bin\\sessiongraph\.mjs" %\*/);
    assert.ok(!shim.includes(f.home), 'user paths are expanded by %~dp0 rather than embedded as cmd source');
  }
  assert.match(windowsPathScript, /CurrentUser\.CreateSubKey\('Environment'\)/);
  assert.match(windowsPathScript, /DoNotExpandEnvironmentNames/);
  assert.match(windowsPathScript, /GetValueKind/);
  assert.match(windowsPathScript, /\$env:SESSIONGRAPH_CLI_BIN/);
  assert.match(windowsPathScript, /SendMessageTimeout/);
  assert.doesNotMatch(windowsPathScript, /setx|LocalMachine/);
  if (process.platform === 'win32') {
    assert.equal(JSON.parse((await command(installed.bin, 'ssg', ['--version', '--json'], f.env)).stdout).data.version, '9.8.7');
  }
});

test('desktop setup preserves unfamiliar command files and symlinks', async t => {
  const f = await fixture(t), root = cliInstallDirectory(f.home, f.env, process.platform), bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const path = join(bin, process.platform === 'win32' ? 'sessiongraph.cmd' : 'sessiongraph');
  await writeFile(path, 'unrelated command');
  await assert.rejects(installDesktopCli(f.options), /existing file/);
  assert.equal(await readFile(path, 'utf8'), 'unrelated command');
  await assert.rejects(access(join(f.home, '.zprofile')));
  if (process.platform !== 'win32') {
    await rm(path);
    const external = join(f.home, 'other-command');
    await writeFile(external, 'external command');
    await symlink(external, path);
    await assert.rejects(installDesktopCli(f.options), /existing file/);
    assert.equal(await readFile(external, 'utf8'), 'external command');
  }
});

test('native packaging includes CLI resources and skips registration in development builds', async () => {
  const prepare = await readFile('scripts/prepare-desktop.mjs', 'utf8'), native = await readFile('src-tauri/src/main.rs', 'utf8');
  for (const file of ['cli.mjs', 'install-cli.mjs', 'cli-launcher.mjs', 'cli-package.json']) assert.ok(prepare.includes(file));
  assert.match(native, /#\[cfg\(not\(debug_assertions\)\)\][\s\S]*installer\.arg\(resource\.join\("install-cli\.mjs"\)\)/);
  assert.match(native, /var_os\("APPIMAGE"\)/);
});

test('the bundled installer entry registers commands without creating or opening a library', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const entry = join(f.resources, 'install-cli.mjs');
  await build({ entryPoints: ['server/cli-install-main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: entry });
  const setup = await exec(process.execPath, [entry, f.options.executable], { env: f.env });
  assert.equal(setup.stdout, ''); assert.equal(setup.stderr, '');
  const root = cliInstallDirectory(f.home, f.env, process.platform);
  const result = await command(join(root, 'bin'), 'ssg', ['commands', '--json'], f.env);
  assert.deepEqual(JSON.parse(result.stdout).data.executableAliases, ['ssg']);
  await assert.rejects(access(f.env.SESSIONGRAPH_DATA_DIR!));
});

test('invalid bundled metadata cannot escape the CLI directory or edit a profile', async t => {
  const f = await fixture(t);
  for (const metadata of [{ version: '../outside', buildID: 'a'.repeat(64) }, { version: '1.0.0', buildID: '../outside' }]) {
    await writeFile(join(f.resources, 'cli-package.json'), JSON.stringify(metadata));
    await assert.rejects(installDesktopCli(f.options), /Invalid bundled CLI metadata/);
  }
  await assert.rejects(access(cliInstallDirectory(f.home, f.env, process.platform)));
});
