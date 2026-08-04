import { createReadStream, statSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT ?? 8080);
const api = new URL(process.env.API_URL ?? 'http://api:3000');
const publicRoot = join(import.meta.dirname, 'dist');
const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

createServer((incoming, response) => {
  if (incoming.url?.startsWith('/api/')) {
    const upstream = proxyRequest(new URL(incoming.url.slice(4), api), { method: incoming.method, headers: { ...incoming.headers, host: api.host } }, (proxied) => {
      response.writeHead(proxied.statusCode ?? 502, proxied.headers);
      proxied.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end('Service unavailable'); });
    incoming.pipe(upstream);
    return;
  }

  const requested = normalize(decodeURIComponent(incoming.url?.split('?')[0] ?? '/')).replace(/^(\.\.[/\\])+/, '');
  let file = join(publicRoot, requested === '/' ? 'index.html' : requested);
  try {
    if (!statSync(file).isFile()) file = join(publicRoot, 'index.html');
  } catch {
    file = join(publicRoot, 'index.html');
  }
  response.setHeader('content-type', contentTypes[extname(file)] ?? 'application/octet-stream');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'same-origin');
  if (file.endsWith('sw.js') || file.endsWith('.webmanifest')) response.setHeader('cache-control', 'no-cache');
  createReadStream(file).pipe(response);
}).listen(port, '0.0.0.0');
