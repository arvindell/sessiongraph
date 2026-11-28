import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { SourceStatus } from '@sessiongraph/core/types';
import { saveSourceLocation, sourceLocationOption } from '../src/source-locations';

const source: SourceStatus = { id: 'codex', name: 'Codex', available: true, selected: true, description: 'Local history', capabilities: { history: true, forks: true, children: true, files: true }, sessions: 2, path: null, pathSupported: true, pathHint: 'Codex home containing sessions/.' };

test('per-harness editors describe automatic/custom locations and keep form controls outside checkbox labels', () => {
  const html = sourceLocationOption(source, { settings: true, checked: false });
  assert.match(html, /History location <span>Automatic/);
  assert.match(html, /Codex home containing sessions/);
  assert.match(html, /class="settings-source"/); assert.doesNotMatch(html, /\schecked/);
  assert.ok(html.indexOf('</label>') < html.indexOf('<form'));
  assert.match(html, /aria-label="Codex history path"/);
  assert.match(html, /type="submit"/); assert.match(html, /source-automatic/);
  assert.doesNotMatch(html, /source-browse/);
  assert.match(sourceLocationOption(source, { desktop: true }), /source-browse/);
  assert.match(sourceLocationOption({ ...source, path: '/archive/codex' }), /History location <span>Custom/);
  assert.match(sourceLocationOption(source, { disabled: true }), /<fieldset disabled/);
  assert.doesNotMatch(sourceLocationOption({ ...source, pathSupported: false }), /<form/);
});

test('history paths, source names, and path hints are escaped instead of interpreted as markup', () => {
  const html = sourceLocationOption({ ...source, name: 'Codex"><img src=x>', path: '/archive/" onfocus="bad', pathHint: '<script>bad</script>' });
  assert.doesNotMatch(html, /<img|<script| onfocus="bad/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&quot; onfocus=&quot;bad/);
});

test('location saves use authenticated local actions and preserve server error messages for retry', async () => {
  const original = globalThis.fetch;
  const requests: { source: string; path: string | null }[] = [];
  try {
    globalThis.fetch = (async (url, options) => {
      assert.equal(url, '/api/sessiongraph/sources/path');
      assert.equal(options?.method, 'POST');
      assert.equal((options?.headers as Record<string, string>)['X-SessionGraph-Action'], 'source-path');
      requests.push(JSON.parse(String(options?.body)));
      return Response.json({ saved: true, source: { ...source, path: requests.at(-1)?.path } });
    }) as typeof fetch;
    assert.equal((await saveSourceLocation('codex', '/archive/codex')).path, '/archive/codex');
    assert.equal((await saveSourceLocation('codex', null)).path, null);
    assert.deepEqual(requests, [{ source: 'codex', path: '/archive/codex' }, { source: 'codex', path: null }]);
    globalThis.fetch = (async () => Response.json({ code: 'IMPORT_BUSY', error: 'Another import is running. Try again when it finishes.' }, { status: 409 })) as typeof fetch;
    await assert.rejects(saveSourceLocation('codex', '/retry'), /Another import is running/);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    await assert.rejects(saveSourceLocation('codex', '/retry'), /Could not save history location/);
  } finally { globalThis.fetch = original; }
});

test('native folder selection is limited to the authenticated loopback webview', async () => {
  const native = await readFile(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.match(native, /\.permission\("dialog:allow-open"\)/);
  assert.doesNotMatch(native, /\.permission\("dialog:default"\)/);
});
