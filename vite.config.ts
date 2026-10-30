import { defineConfig, type Plugin } from 'vite';
import { sessionAtlasMiddleware } from './server/middleware';

function sessionAtlasApi(): Plugin {
  return {
    name: 'session-atlas-local-api',
    configureServer(server) { server.middlewares.use(sessionAtlasMiddleware); },
    configurePreviewServer(server) { server.middlewares.use(sessionAtlasMiddleware); },
  };
}

export default defineConfig({
  plugins: [sessionAtlasApi()],
  build: {
    rollupOptions: {
      output: { manualChunks: (id) => id.includes('/node_modules/three/') || id.includes('/node_modules/.pnpm/three@') ? 'three' : undefined },
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 5173,
    // Keep existing local bookmarks working after the rename.
    allowedHosts: ['session-atlas.localhost', 'atlas.localhost', 'opencode-atlas.localhost'],
  },
  preview: { host: '127.0.0.1', allowedHosts: ['session-atlas.localhost', 'atlas.localhost', 'opencode-atlas.localhost'] },
});
