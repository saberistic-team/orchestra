import { createServer, request as createUpstreamRequest, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { PREVIEW_CONTAINER_PORT } from '@orchestra/contracts';
import { previewContainerFromHost, previewGatewayOrigin } from './preview-routing.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const UNTRUSTED_FORWARDING = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto']);

export interface PreviewGatewayOptions {
  publicOrigin?: string;
  targetForContainer?: (containerName: string) => { hostname: string; port: number };
  timeoutMs?: number;
}

function safePath(value: string | undefined) {
  return value?.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : undefined;
}

function targetHeaders(headers: IncomingHttpHeaders, originalHost: string, websocket = false) {
  const output: Record<string, string | string[]> = {};
  const connectionNominated = new Set(
    headers.connection?.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean) ?? [],
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined
      || HOP_BY_HOP.has(lower)
      || connectionNominated.has(lower)
      || UNTRUSTED_FORWARDING.has(lower)
      || lower.startsWith('x-forwarded-')
      || lower === 'host') continue;
    output[lower] = value;
  }
  output.host = originalHost;
  output['x-forwarded-host'] = originalHost;
  output['x-forwarded-proto'] = 'http';
  output['x-forwarded-port'] = originalHost.slice(originalHost.lastIndexOf(':') + 1);
  if (websocket) {
    output.connection = 'Upgrade';
    output.upgrade = 'websocket';
  }
  return output;
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const output: Record<string, string | string[]> = {};
  const connectionNominated = new Set(
    headers.connection?.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean) ?? [],
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value !== undefined && !HOP_BY_HOP.has(lower) && !connectionNominated.has(lower)) output[name] = value;
  }
  output['cache-control'] = 'no-store';
  return output;
}

function validWebSocketOrigin(origin: string | undefined, host: string) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === `http://${host.toLowerCase()}` && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function validWebSocketKey(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9+/]{22}==$/u.test(value)) return false;
  return Buffer.from(value, 'base64').length === 16;
}

function plain(response: ServerResponse, status: number, message: string) {
  const bytes = Buffer.from(`${message}\n`);
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

export function createPreviewGateway(options: PreviewGatewayOptions = {}) {
  const origin = previewGatewayOrigin(options.publicOrigin);
  const targetForContainer = options.targetForContainer
    ?? ((containerName: string) => ({ hostname: containerName, port: PREVIEW_CONTAINER_PORT }));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const controlHost = `preview-gateway.localhost:${origin.port}`;

  const server = createServer(async (incoming, response) => {
    if (incoming.headers.host?.toLowerCase() === controlHost && incoming.method === 'GET' && incoming.url === '/health') {
      try {
        await lookup('preview-gateway');
        return plain(response, 200, 'ok');
      } catch {
        return plain(response, 503, 'runtime network unavailable');
      }
    }
    const containerName = previewContainerFromHost(incoming.headers.host, origin.toString());
    const path = safePath(incoming.url);
    if (!containerName || !path || incoming.method === 'CONNECT' || incoming.method === 'TRACE') {
      return plain(response, 421, 'Misdirected Request');
    }
    const target = targetForContainer(containerName);
    const upstream = createUpstreamRequest({
      hostname: target.hostname,
      port: target.port,
      method: incoming.method,
      path,
      headers: targetHeaders(incoming.headers, incoming.headers.host!),
      timeout: timeoutMs,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.once('timeout', () => upstream.destroy(new Error('Preview upstream timed out.')));
    upstream.once('error', () => {
      if (!response.headersSent) plain(response, 502, 'Preview unavailable');
      else response.destroy();
    });
    incoming.once('aborted', () => upstream.destroy());
    incoming.pipe(upstream);
  });

  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  server.on('upgrade', (incoming, downstream, head) => {
    const containerName = previewContainerFromHost(incoming.headers.host, origin.toString());
    const path = safePath(incoming.url);
    const connectionTokens = incoming.headers.connection?.toLowerCase().split(',').map((token) => token.trim()) ?? [];
    if (!containerName
      || !path
      || incoming.method !== 'GET'
      || incoming.headers.upgrade?.toLowerCase() !== 'websocket'
      || !connectionTokens.includes('upgrade')
      || incoming.headers['sec-websocket-version'] !== '13'
      || !validWebSocketKey(incoming.headers['sec-websocket-key'])
      || !validWebSocketOrigin(incoming.headers.origin, incoming.headers.host!)) {
      downstream.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = targetForContainer(containerName);
    const upstream = connectSocket({ host: target.hostname, port: target.port });
    let upstreamResponseStarted = false;
    let connectionTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (connectionTimer) clearTimeout(connectionTimer);
      if (!downstream.destroyed && !upstreamResponseStarted) {
        downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } else {
        downstream.destroy();
      }
      upstream.destroy();
    };
    connectionTimer = setTimeout(fail, Math.min(timeoutMs, 15_000));
    upstream.once('error', fail);
    upstream.once('close', () => {
      if (connectionTimer) clearTimeout(connectionTimer);
    });
    downstream.once('error', () => upstream.destroy());
    downstream.once('close', () => {
      if (connectionTimer) clearTimeout(connectionTimer);
      upstream.destroy();
    });
    upstream.once('connect', () => {
      const headers = targetHeaders(
        incoming.headers,
        incoming.headers.host!,
        true,
      );
      const lines = [`${incoming.method ?? 'GET'} ${path} HTTP/${incoming.httpVersion}`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.once('data', () => {
        upstreamResponseStarted = true;
        if (connectionTimer) clearTimeout(connectionTimer);
      });
      downstream.pipe(upstream).pipe(downstream);
    });
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = timeoutMs;
  return server;
}

function configuredPort() {
  const value = Number(process.env.PORT ?? 3003);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error('PORT must be a valid TCP port.');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createPreviewGateway();
  server.listen(configuredPort(), '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
