import { build } from 'esbuild';
await build({ entryPoints: ['server/standalone.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist-server/server.mjs',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
