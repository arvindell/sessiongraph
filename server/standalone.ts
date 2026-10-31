import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sessionGraphMiddleware, library } from './middleware';

const arg = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const assets = resolve(arg('--assets') || fileURLToPath(new URL('../dist', import.meta.url)));
const token = randomBytes(32).toString('hex');
const ipc = process.argv.includes('--desktop') ? ' ipc: http://ipc.localhost' : '';
const equals = (value: string) => /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${ipc}; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`);
  if (url.pathname === '/__sessiongraph' && equals(url.searchParams.get('token') || '')) {
    res.setHeader('Set-Cookie', `sessiongraph=${token}; HttpOnly; SameSite=Strict; Path=/`);
    res.setHeader('Cache-Control', 'no-store'); res.writeHead(303, { Location: '/' }); res.end(); return;
  }
  const cookie = /(?:^|;\s*)sessiongraph=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1] || '';
  if (!equals(cookie)) { res.writeHead(401); res.end('Open SessionGraph from the app or launcher.'); return; }
  await sessionGraphMiddleware(req, res, () => {
    void (async () => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        const path = resolve(assets, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!path.startsWith(assets + sep)) { res.writeHead(403); res.end(); return; }
        const info = await stat(path);
        if (!info.isFile()) throw new Error('Not found');
        res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
        res.setHeader('Cache-Control', path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-store');
        if (req.method === 'HEAD') res.end(); else createReadStream(path).on('error', () => res.destroy()).pipe(res);
      } catch { res.writeHead(404); res.end('Not found'); }
    })();
  });
});
server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as { port: number }).port;
  // This bootstrap URL is consumed by the native host/launcher, never logged to disk.
  process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${port}/__sessiongraph?token=${token}` }) + '\n');
});
const parent = Number(arg('--parent-pid'));
if (parent > 0) setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 2000).unref();
const close = () => { server.close(); try { library().store.close(); } finally { process.exit(0); } };
process.on('SIGTERM', close); process.on('SIGINT', close);
