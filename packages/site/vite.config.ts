import { defineConfig, type Connect } from 'vite';
import { cp, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const routes: Connect.NextHandleFunction = (req, _res, next) => {
  const path = (req.url || '').split('?')[0];
  if (/^\/@[a-z\d-]+\/?$/i.test(path)) req.url = '/profile.html';
  else if (path === '/account') req.url = '/account.html';
  next();
};

export default defineConfig({
  publicDir: false,
  plugins: [{ name: 'static-site-assets', configureServer(server) { server.middlewares.use(routes); }, configurePreviewServer(server) { server.middlewares.use(routes); }, async closeBundle() {
    await cp('assets', 'dist/assets', { recursive: true });
    for (const file of ['main.js', 'style.css', 'robots.txt', 'sitemap.xml']) await copyFile(file, `dist/${file}`);
  } }],
  build: { rollupOptions: { input: { index: resolve('index.html'), account: resolve('account.html'), profile: resolve('profile.html'), notFound: resolve('404.html') }, output: { manualChunks: id => id.includes('/three/') || id.includes('/three@') ? 'three' : undefined } } },
  server: { host: '127.0.0.1', port: 5190 },
});
