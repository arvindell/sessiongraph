import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BRAND_INK, BRAND_TEXT, brandSvg, brandSymbol } from '../packages/core/src/brand.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const wordmark = await readFile(resolve(root, 'assets/brand/wordmark.svg'), 'utf8');
const paths = wordmark.match(/<g\b[^>]*>[\s\S]*<\/g>/)?.[0];
if (!paths) throw new Error('Missing outlined wordmark.');
const wordmarkHeight = Number(wordmark.match(/viewBox="0 0 420 ([\d.]+)"/)?.[1]);
if (!wordmarkHeight) throw new Error('Missing wordmark dimensions.');
const lockup = color => `<svg xmlns="http://www.w3.org/2000/svg" width="580" height="128" viewBox="0 0 580 128"><title>SessionGraph</title>${brandSymbol()}<g transform="translate(140 ${((128 - wordmarkHeight) / 2).toFixed(3)})" fill="${color}">${paths}</g></svg>\n`;
const files = {
  'mark.svg': brandSvg(),
  'mark-mono.svg': brandSvg({ color: 'currentColor' }),
  'icon.svg': brandSvg({ tile: true }),
  'lockup.svg': lockup(BRAND_TEXT),
  'lockup-light.svg': lockup(BRAND_INK),
};
for (const directory of ['public', 'packages/site/assets']) {
  const base = resolve(root, directory);
  await mkdir(resolve(base, 'brand'), { recursive: true });
  for (const [name, svg] of Object.entries(files)) await writeFile(resolve(base, 'brand', name), svg);
  await writeFile(resolve(base, 'favicon.svg'), files['icon.svg']);
}

const run = args => {
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (${result.status}).`);
};
run(['public/brand/icon.svg', '--output', 'src-tauri/icons', '--ios-color', BRAND_INK]);
// Apple masks its own corners. Render from a fully opaque source to avoid
// fractional alpha introduced by resampling a rounded tile onto a background.
await mkdir(resolve(root, 'tmp/brand-apple'), { recursive: true });
await writeFile(resolve(root, 'tmp/brand-apple/source.svg'), brandSvg({ tile: true, rounded: false }));
run(['tmp/brand-apple/source.svg', '--output', 'tmp/brand-apple/icons', '--ios-color', BRAND_INK]);
await cp(resolve(root, 'tmp/brand-apple/icons/ios'), resolve(root, 'src-tauri/icons/ios'), { recursive: true });
for (const directory of ['public', 'packages/site/assets']) {
  await copyFile(resolve(root, 'src-tauri/icons/ios/AppIcon-60x60@3x.png'), resolve(root, directory, 'apple-touch-icon.png'));
  await copyFile(resolve(root, 'src-tauri/icons/icon.ico'), resolve(root, directory, 'favicon.ico'));
}
console.log('Updated Switchback web assets and native icons.');
