import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { sessionGraphMiddleware } from './server/middleware';

function sessionGraphApi(): Plugin {
  return {
    name: 'sessiongraph-local-api',
    configureServer(server) { server.middlewares.use(sessionGraphMiddleware); },
    configurePreviewServer(server) { server.middlewares.use(sessionGraphMiddleware); },
  };
}

export default defineConfig({
  plugins: [sessionGraphApi(), {
    name: 'ui-asset-licenses',
    apply: 'build',
    generateBundle() {
      for (const file of ['katagami.txt', 'hugeicons.txt']) {
        this.emitFile({ type: 'asset', fileName: `assets/licenses/${file}`, source: readFileSync(new URL(`./packages/site/assets/licenses/${file}`, import.meta.url)) });
      }
    },
  }],
  build: {
    rollupOptions: {
      output: { manualChunks: (id) => id.includes('/node_modules/three/') || id.includes('/node_modules/.pnpm/three@') ? 'three' : undefined },
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 5173,
    allowedHosts: ['sessiongraph.localhost'],
  },
  preview: { host: '127.0.0.1', allowedHosts: ['sessiongraph.localhost'] },
});
