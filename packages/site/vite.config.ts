import { defineConfig, type Connect } from 'vite';
import { cp, copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mountPublicApi } from './dev/public-api';

const routes: Connect.NextHandleFunction = (req, _res, next) => {
  const path = (req.url || '').split('?')[0];
  if (/^\/@[a-z\d-]+\/?$/i.test(path)) req.url = '/profile.html';
  else if (path === '/account') req.url = '/account.html';
  else if (path === '/explore' || path === '/explore/') req.url = '/explore.html';
  next();
};

const serveSourceIcon: Connect.NextHandleFunction = (req, res, next) => {
  const match = /^\/assets\/sources\/([a-z\d-]+)\.svg$/i.exec((req.url || '').split('?')[0]);
  if (!match) return next();
  readFile(resolve('../../public/sources', `${match[1]}.svg`)).then(icon => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(icon);
  }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.statusCode = 404;
      res.end();
    } else next(error);
  });
};

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: 'static-site-assets',
    configureServer(server) { mountPublicApi(server); server.middlewares.use(routes); server.middlewares.use(serveSourceIcon); },
    configurePreviewServer(server) { server.middlewares.use(routes); server.middlewares.use(serveSourceIcon); },
    async closeBundle() {
      await cp('assets', 'dist/assets', { recursive: true });
      await cp(resolve('../../public/sources'), 'dist/assets/sources', { recursive: true });
      for (const file of ['main.js', 'style.css', 'robots.txt', 'sitemap.xml']) await copyFile(file, `dist/${file}`);
    },
  }],
  build: { rollupOptions: { input: { index: resolve('index.html'), account: resolve('account.html'), profile: resolve('profile.html'), explore: resolve('explore.html'), notFound: resolve('404.html') }, output: { manualChunks: id => id.includes('/three/') || id.includes('/three@') ? 'three' : undefined } } },
  server: { host: '127.0.0.1', port: 5190 },
});
