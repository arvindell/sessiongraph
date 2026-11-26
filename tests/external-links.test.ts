import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { externalWebUrl, openDesktopUrl } from '../src/external-links';

test('desktop browser links accept only credential-free HTTP(S) URLs', async () => {
  const url = `https://sessiongraph.ai/account?device=${'a'.repeat(64)}`;
  const opened: string[] = [];
  await openDesktopUrl(url, async value => { opened.push(value); });
  assert.deepEqual(opened, [url]);
  assert.equal(externalWebUrl('http://127.0.0.1:1234/session'), 'http://127.0.0.1:1234/session');
  for (const invalid of ['javascript:alert(1)', 'file:///private/history', 'mailto:test@example.com', 'sessiongraph://login', 'https://user:secret@sessiongraph.ai/account', '/account']) {
    await assert.rejects(openDesktopUrl(invalid, async value => { opened.push(value); }));
  }
  assert.deepEqual(opened, [url]);
  await assert.rejects(openDesktopUrl(url, async () => { throw new Error('Native opener denied'); }), /Native opener denied/);
});

test('the loopback webview grants the intercepted opener command a web-only scope', async () => {
  const native = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  const scope = native.match(/\.permission_scoped\("opener:allow-open-url", vec!\[([\s\S]*?)\], vec!\[\]\)/)?.[1];
  assert.ok(scope, 'The opener IPC permission is required even when navigation fallbacks exist');
  assert.deepEqual([...scope.matchAll(/"url":\s*"([^"]+)"/g)].map(match => match[1]), ['https://*', 'http://*']);
  assert.doesNotMatch(native, /\.permission\("opener:default"\)|opener:allow-open-path/);
});
