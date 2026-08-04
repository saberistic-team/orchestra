import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreviewGateway } from './preview-gateway.js';
import { previewContainerFromHost, previewPublicUrl } from './preview-routing.js';

const containerName = 'orchestra-preview-8c1084d8-7-cf6aca6e9e31';
const imageDigest = `sha256:${'a'.repeat(64)}`;
const publicHost = `${containerName}-${'a'.repeat(12)}.localhost:3003`;
const origin = 'http://localhost:3003';
const openServers: Array<ReturnType<typeof createServer>> = [];

async function listen(server: ReturnType<typeof createServer>) {
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  return address.port;
}

async function call(port: number, host: string, path = '/') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const operation = request({ hostname: '127.0.0.1', port, path, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    operation.once('error', reject);
    operation.end();
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('preview gateway boundary', () => {
  it('emits and accepts only deterministic localhost subdomains on the configured port', () => {
    expect(previewPublicUrl(containerName, imageDigest, origin)).toBe(`http://${publicHost}/`);
    expect(previewContainerFromHost(publicHost, origin)).toBe(`${containerName}-${'a'.repeat(12)}`);
    expect(previewContainerFromHost(`${containerName}-${'a'.repeat(12)}.localhost.evil:3003`, origin)).toBeUndefined();
    expect(previewContainerFromHost(`${containerName}-${'a'.repeat(12)}%2elocalhost:3003`, origin)).toBeUndefined();
    expect(previewContainerFromHost(`${containerName}-${'a'.repeat(12)}.localhost:03003`, origin)).toBeUndefined();
    expect(previewContainerFromHost(publicHost.toUpperCase(), origin)).toBeUndefined();
    expect(previewContainerFromHost('forgejo.localhost:3003', origin)).toBeUndefined();
    expect(previewContainerFromHost(`${containerName}-${'a'.repeat(12)}.localhost:3004`, origin)).toBeUndefined();
    expect(() => previewPublicUrl('postgres', imageDigest, origin)).toThrow('not gateway-routable');
  });

  it('routes an accepted host, overwrites forwarding headers, and rejects every unrelated host', async () => {
    let received: { url?: string; host?: string; forwardedHost?: string; forwardedFor?: string } | undefined;
    const upstream = createServer((incoming, response) => {
      received = {
        url: incoming.url,
        host: incoming.headers.host,
        forwardedHost: incoming.headers['x-forwarded-host'] as string,
        forwardedFor: incoming.headers['x-forwarded-for'] as string | undefined,
      };
      response.end('preview-ok');
    });
    const upstreamPort = await listen(upstream);
    const gateway = createPreviewGateway({
      publicOrigin: origin,
      targetForContainer: () => ({ hostname: '127.0.0.1', port: upstreamPort }),
    });
    const gatewayPort = await listen(gateway);

    const accepted = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const operation = request({
        hostname: '127.0.0.1',
        port: gatewayPort,
        path: '/nested?answer=42',
        headers: {
          host: publicHost,
          'x-forwarded-for': '203.0.113.9',
          'x-forwarded-host': 'attacker.invalid',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      operation.once('error', reject);
      operation.end();
    });

    expect(accepted).toEqual({ status: 200, body: 'preview-ok' });
    expect(received).toEqual({
      url: '/nested?answer=42',
      host: publicHost,
      forwardedHost: publicHost,
      forwardedFor: undefined,
    });
    expect(await call(gatewayPort, 'postgres:3003')).toMatchObject({ status: 421 });
    expect(await call(gatewayPort, `${containerName}-${'a'.repeat(12)}.localhost.evil:3003`)).toMatchObject({ status: 421 });
  });

  it('passes a WebSocket upgrade only for an accepted preview host', async () => {
    const upstream = createServer();
    upstream.on('upgrade', (incoming, socket) => {
      expect(incoming.url).toBe('/socket');
      expect(incoming.headers.host).toBe(publicHost);
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\ngateway-websocket-ok');
    });
    const upstreamPort = await listen(upstream);
    const gateway = createPreviewGateway({
      publicOrigin: origin,
      targetForContainer: () => ({ hostname: '127.0.0.1', port: upstreamPort }),
    });
    const gatewayPort = await listen(gateway);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: gatewayPort });
      const chunks: Buffer[] = [];
      socket.once('connect', () => socket.write([
        'GET /socket HTTP/1.1',
        `Host: ${publicHost}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Origin: http://${publicHost}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n')));
      socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.once('error', reject);
    });

    expect(response).toContain('101 Switching Protocols');
    expect(response).toContain('gateway-websocket-ok');
  });
});
