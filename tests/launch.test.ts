import test from 'node:test';
import assert from 'node:assert/strict';
import { cliCommand, sessionWebUrl } from '../src/launch-links';
import { terminalInvocation } from '../server/launch';

test('web links use the discovered origin and V2 server route without credentials', () => {
  const url = new URL(sessionWebUrl('http://127.0.0.1:49374/', 'ses_example'));
  assert.equal(url.origin, 'http://127.0.0.1:49374');
  assert.equal(Buffer.from(url.pathname.split('/')[2], 'base64url').toString(), url.origin);
  assert.ok(url.pathname.endsWith('/session/ses_example'));
  assert.throws(() => sessionWebUrl('https://user:password@example.com', 'ses_example'));
  assert.throws(() => sessionWebUrl('javascript:alert(1)', 'ses_example'));
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
