import { defineConfig, type Connect } from 'vite';
import { cp, copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mountPublicApi } from './dev/public-api';
import { sourceCatalog } from '@sessiongraph/core/sources';
import { icon, type IconName } from '@sessiongraph/core/icons';

const featuredSourceIDs = [
  'opencode', 'claude-code', 'codex', 'cursor', 'gemini', 'copilot', 't3-code', 'cline',
  'roo-code', 'kilo-code', 'pi', 'amp', 'continue', 'qwen-code', 'copilot-chat', 'droid',
  'openclaw', 'hermes', 'goose', 'zed', 'kiro', 'antigravity', 'vibe', 'junie',
];
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
function renderLandingSources(html: string) {
  const catalog = new Map(sourceCatalog().map(source => [source.id, source]));
  const tile = ({ name, icon }: ReturnType<typeof sourceCatalog>[number]) =>
    `<li><img src="/assets/sources/${escapeHtml(icon)}.svg" alt="" width="32" height="32" loading="lazy"><span>${escapeHtml(name)}</span></li>`;
  const featured = featuredSourceIDs.flatMap(id => {
    const source = catalog.get(id);
    catalog.delete(id);
    return source ? [source] : [];
  });
  const more = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return html.replace('<!-- featured-sources -->', featured.map(tile).join('\n'))
    .replace('<!-- more-sources -->', more.map(tile).join('\n'));
}

const routes: Connect.NextHandleFunction = (req, _res, next) => {
  const path = (req.url || '').split('?')[0];
  if (/^\/@[a-z\d-]+\/?$/i.test(path)) req.url = '/profile.html';
  else if (path === '/account') req.url = '/account.html';
  else if (path === '/explore' || path === '/explore/') req.url = '/explore.html';
  else if (path === '/privacy' || path === '/privacy/') req.url = '/privacy.html';
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
    transformIndexHtml: { order: 'pre', handler: html => renderLandingSources(html).replace(/<!-- icon:([a-z0-9-]+)(?: ([a-z-]+))? -->/g, (_, name: IconName, cls?: string) => icon(name, cls)) },
    configureServer(server) { mountPublicApi(server); server.middlewares.use(routes); server.middlewares.use(serveSourceIcon); },
    configurePreviewServer(server) { server.middlewares.use(routes); server.middlewares.use(serveSourceIcon); },
    async closeBundle() {
      await cp('assets', 'dist/assets', { recursive: true });
      await cp(resolve('../../public/sources'), 'dist/assets/sources', { recursive: true });
      for (const file of ['main.js', 'style.css', 'robots.txt', 'sitemap.xml']) await copyFile(file, `dist/${file}`);
    },
  }],
  build: { rollupOptions: { input: { index: resolve('index.html'), account: resolve('account.html'), profile: resolve('profile.html'), explore: resolve('explore.html'), privacy: resolve('privacy.html'), notFound: resolve('404.html') }, output: { manualChunks: id => id.includes('/three/') || id.includes('/three@') ? 'three' : undefined } } },
  server: { host: '127.0.0.1', port: 5190 },
});
