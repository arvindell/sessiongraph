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
  plugins: [sessionGraphApi()],
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
