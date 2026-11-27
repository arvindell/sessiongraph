import { build } from 'esbuild';
import { readFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { dependencies } = JSON.parse(await readFile(new URL('../packages/site/package.json', import.meta.url), 'utf8'));

await build({
  absWorkingDir: root,
  entryPoints: ['packages/site/server/handler.ts'],
  outfile: 'packages/site/dist-api/handler.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Bundle workspace TypeScript and generated Prisma code; Vercel traces npm dependencies.
  external: Object.keys(dependencies).filter(name => name !== '@sessiongraph/core'),
});
if (process.argv.includes('--pages')) {
  // Keep the compiled shell inside the Function bundle; a static /explore.html
  // must not shadow the cached server-rendered /explore route.
  await copyFile(new URL('../packages/site/dist/explore.html', import.meta.url), new URL('../packages/site/dist-api/explore.html', import.meta.url));
  await rm(new URL('../packages/site/dist/explore.html', import.meta.url));
}
