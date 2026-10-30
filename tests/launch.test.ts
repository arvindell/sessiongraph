import test from 'node:test';
import assert from 'node:assert/strict';
import { cliCommand, sessionWebUrl } from '../src/launch-links';
import { commandInvocation, terminalInvocation } from '../server/launch';
import { launchCommand, shellQuote } from '../server/harnesses';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('web links use the discovered origin and V2 server route without credentials', () => {
  const url = new URL(sessionWebUrl('http://127.0.0.1:49374/', 'ses_example'));
  assert.equal(url.origin, 'http://127.0.0.1:49374');
  assert.equal(Buffer.from(url.pathname.split('/')[2], 'base64url').toString(), url.origin);
  assert.ok(url.pathname.endsWith('/session/ses_example'));
  assert.throws(() => sessionWebUrl('https://user:password@example.com', 'ses_example'));
  assert.throws(() => sessionWebUrl('javascript:alert(1)', 'ses_example'));
});

test('launch commands preserve paths and arguments as data through a POSIX shell', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-atlas-quote-')), directory = join(root, "a 'quote' $(echo nope); & space");
  const args = ["a 'quote'", '$(echo injection)', 'a;b & c', 'back`tick', '雪'];
  try {
    await mkdir(directory);
    const command = launchCommand(process.execPath, ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}))', '--', ...args], directory, 'linux');
    const result = JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }));
    assert.deepEqual(result.args, args); assert.equal(result.cwd, await realpath(directory));
    for (const bad of ['x\nexit', 'x\r', 'x\0', 'x\x1b']) assert.throws(() => shellQuote(bad));
  } finally { await rm(root, { recursive: true }); }
});

test('terminal wrappers keep the command outside interpreter source and encode PowerShell payloads', () => {
  const command = launchCommand("C:\\tools\\claude.exe", ['--resume', 'native'], "C:\\work\\O'Brien", 'win32');
  assert.ok(command.includes("'C:\\work\\O''Brien'"));
  const windows = commandInvocation(command, 'powershell.exe', 'win32');
  const encoded = windows.args.at(-1)!.match(/'-EncodedCommand','([^']+)'/)![1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), command);
  const mac = commandInvocation('test "quoted" command', '/usr/bin/osascript', 'darwin');
  assert.equal(mac.args.at(-1), 'test "quoted" command'); assert.ok(!mac.args[1].includes('quoted'));
  assert.deepEqual(commandInvocation('command', '/usr/bin/gnome-terminal', 'linux').args, ['--', 'sh', '-lc', 'command']);
  assert.deepEqual(commandInvocation('command', '/usr/bin/xterm', 'linux').args, ['-e', 'sh', '-lc', 'command']);
});

test('CLI launch passes a validated ID as data to a fixed AppleScript', () => {
  const id = 'ses_123Abc-test';
  assert.equal(cliCommand(id), `opencode --session '${id}'`);
  const invocation = terminalInvocation(id);
  assert.equal(invocation.file, '/usr/bin/osascript');
  assert.equal(invocation.args.at(-1), cliCommand(id));
  assert.ok(!invocation.args[1].includes(id));
  for (const bad of ['ses_x;touch /tmp/nope', "ses_x'", 'ses_x\nwhoami', '../ses_x', '']) assert.throws(() => terminalInvocation(bad));
});
