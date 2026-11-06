import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
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
