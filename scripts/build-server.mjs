import { build } from 'esbuild';
await build({ entryPoints: { server: 'server/standalone.ts', cli: 'server/cli.ts' }, bundle: true, platform: 'node', target: 'node24', format: 'esm', outdir: 'dist-server', outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
