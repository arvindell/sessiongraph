import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('the deployed API imports in plain Node without a TypeScript loader', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../../../scripts/build-site-api.mjs', import.meta.url))]);
  const entry = new URL('../api/index.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { default: api } = await import(${JSON.stringify(entry)});
    const response = await api.fetch(new Request('https://sessiongraph.ai/api/health'));
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const result = JSON.parse(output);
  assert.equal(result.status, 200);
  assert.equal(typeof result.body.ready, 'boolean');
});

test('Vercel sends nested API paths to the shared entry point', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.rewrites[0], { source: '/api/:path*', destination: '/api' });
  assert.ok(config.functions['api/index.mjs']);
});
