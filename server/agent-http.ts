import { createServer, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { LibraryService } from './library-service';
import { invalid } from './library-query';
import { agentQueries, queryError } from './agent-queries';

const digest = (value: string) => createHash('sha256').update(value).digest();
function basicToken(env: NodeJS.ProcessEnv) {
  const username = env.SESSIONGRAPH_SERVER_USERNAME ?? 'sessiongraph';
  if (!username || /[:\x00-\x1f\x7f]/.test(username)) invalid('Invalid SESSIONGRAPH_SERVER_USERNAME.');
  if (!env.SESSIONGRAPH_SERVER_PASSWORD?.trim()) invalid('Set SESSIONGRAPH_SERVER_PASSWORD before starting the API.');
  return Buffer.from(`${username}:${env.SESSIONGRAPH_SERVER_PASSWORD}`).toString('base64');
}
export const apiCredential = (env: NodeJS.ProcessEnv) => digest(basicToken(env));

export async function getLocalApi(port: number, path: string) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('Port must be 1–65535.');
  if (!path.startsWith('/') || /[\x00-\x20\\#]/.test(path)) invalid('Use an API path starting with /.');
  const origin = `http://127.0.0.1:${port}`, url = new URL(origin + path);
  const authorization = `Basic ${basicToken(process.env)}`;
  const res = await fetch(url, { headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  return { ok: res.ok, body: await res.json() };
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
const operations = agentQueries.map(q => ({ ...q, match: new RegExp(`^${q.path.replace('{id}', '([^/]+)')}$`) }));
function openapi(version: string) {
  return { openapi: '3.1.0', info: { title: 'SessionGraph local API', version },
    security: [{ basic: [] }], components: { securitySchemes: { basic: { type: 'http', scheme: 'basic' } } },
    paths: { '/api/info': { get: { operationId: 'server_info', summary: 'Get server version.', responses: { '200': { description: 'Server information' } } } },
      ...Object.fromEntries(agentQueries.map(q => [q.path, { get: { operationId: q.name, summary: q.description,
      parameters: Object.entries(q.inputSchema.properties || {}).map(([name, schema]) => ({
        name, in: name === 'id' ? 'path' : 'query', required: q.inputSchema.required?.includes(name) ?? false, schema,
      })), responses: { '200': { description: 'Versioned JSON result' }, '401': { description: 'Credentials required' } },
    } }])) } };
}
export async function startAgentHttp(library: LibraryService, port: number, credential: Buffer, version: string) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) invalid('Port must be 0–65535.');
  const server = createServer((req, res) => {
    const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fail = (status: number, code: string, message: string) => send(res, status, { schemaVersion: 1, error: { code, message } });
    if (req.headers.host !== authority || (req.headers.origin !== undefined && req.headers.origin !== `http://${authority}`)) {
      return fail(403, 'FORBIDDEN', 'Invalid host or origin.');
    }
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || '');
    if (!basic || !timingSafeEqual(credential, digest(basic[1]))) {
      res.setHeader('WWW-Authenticate', 'Basic realm="SessionGraph", charset="UTF-8"');
      return fail(401, 'UNAUTHORIZED', 'Credentials required.');
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return fail(405, 'METHOD_NOT_ALLOWED', 'Use GET.'); }
    try {
      const url = new URL(req.url || '/', `http://${authority}`);
      if (url.pathname === '/openapi.json') return send(res, 200, openapi(version));
      if (url.pathname === '/api/info') return send(res, 200, { schemaVersion: 1, data: { name: 'sessiongraph', version, apiVersion: 1 } });
      for (const q of operations) {
        const match = q.match.exec(url.pathname);
        if (!match) continue;
        const args: Record<string, unknown> = Object.create(null);
        if (match[1]) {
          try { args.id = decodeURIComponent(match[1]); } catch { invalid('Invalid session ID encoding.'); }
        }
        for (const [key, value] of url.searchParams) {
          if (!Object.hasOwn(q.inputSchema.properties || {}, key) || Object.hasOwn(args, key)) invalid('Unknown or duplicate query parameter.');
          args[key] = ['limit', 'since', 'until'].includes(key) && /^\d+$/.test(value) ? Number(value) : value;
        }
        return send(res, 200, { schemaVersion: 1, data: q.call(library, args) });
      }
      return fail(404, 'NOT_FOUND', 'Unknown endpoint.');
    } catch (error) { const e = queryError(error); return fail(e.status, e.code, e.message); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
