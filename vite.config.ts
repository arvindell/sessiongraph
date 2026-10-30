import { defineConfig, type Plugin } from 'vite';
import { atlasMiddleware } from './server/middleware';

function atlasApi(): Plugin {
  return {
    name: 'atlas-local-api',
    configureServer(server) { server.middlewares.use(atlasMiddleware); },
    configurePreviewServer(server) { server.middlewares.use(atlasMiddleware); },
  };
}

export default defineConfig({
  plugins: [atlasApi()],
  build: {
    rollupOptions: {
      output: { manualChunks: (id) => id.includes('/node_modules/three/') || id.includes('/node_modules/.pnpm/three@') ? 'three' : undefined },
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 5173,
    allowedHosts: ['atlas.localhost', 'opencode-atlas.localhost'],
  },
  preview: { host: '127.0.0.1', allowedHosts: ['atlas.localhost', 'opencode-atlas.localhost'] },
});
