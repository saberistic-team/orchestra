import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import type { ExternalStorage } from '@temporalio/common';
import { ExternalStorageRunner } from '@temporalio/common/lib/internal-non-workflow/external-storage-runner.js';
import { isReferencePayload } from '@temporalio/common/lib/internal-non-workflow/extstore-helpers.js';
import {
  payloadFromJSON,
  payloadToJSON,
  type CodecServerBody,
  type JSONPayload,
} from './payload-json.js';

export interface CodecHttpServerOptions {
  externalStorage: ExternalStorage;
  port?: number;
  host?: string;
  /** Origins allowed for browser calls from Temporal UI (default localhost:8080). */
  corsOrigins?: string[];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string) {
  const headers: Record<string, string> = {};
  if (status !== 204) headers['content-type'] = 'application/json';
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type,x-namespace';
    headers['access-control-allow-methods'] = 'POST,OPTIONS';
  }
  res.writeHead(status, headers);
  if (status === 204) {
    res.end();
    return;
  }
  res.end(JSON.stringify(body));
}

function resolveCorsOrigin(req: IncomingMessage, allowed: string[]): string | undefined {
  const origin = req.headers.origin;
  if (!origin) return undefined;
  return allowed.includes(origin) ? origin : undefined;
}

/**
 * HTTP Codec Server for Temporal UI/CLI with External Storage support.
 * Exposes /encode, /decode, and /download per the Codec Server protocol.
 */
export function createCodecHttpServer(options: CodecHttpServerOptions): Server {
  const runner = new ExternalStorageRunner(options.externalStorage);
  const corsOrigins = options.corsOrigins ?? [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
  ];

  return createServer(async (req, res) => {
    const origin = resolveCorsOrigin(req, corsOrigins);
    try {
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, {}, origin);
        return;
      }
      if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
        sendJson(res, 200, { ok: true }, origin);
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' }, origin);
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}') as CodecServerBody;
      const incoming = (body.payloads ?? []).map(payloadFromJSON);

      if (url.pathname === '/encode') {
        const stored = await runner.store(incoming);
        sendJson(res, 200, { payloads: stored.map(payloadToJSON) }, origin);
        return;
      }

      if (url.pathname === '/decode') {
        const preserve = url.searchParams.get('preserveStorageRefs') === 'true';
        const decoded = preserve ? incoming : await runner.retrieve(incoming);
        sendJson(res, 200, { payloads: decoded.map(payloadToJSON) }, origin);
        return;
      }

      if (url.pathname === '/download') {
        for (const payload of incoming) {
          if (!isReferencePayload(payload)) {
            sendJson(res, 400, { error: 'All /download payloads must be External Storage references' }, origin);
            return;
          }
        }
        const retrieved = await runner.retrieve(incoming);
        const payloads: JSONPayload[] = retrieved.map(payloadToJSON);
        sendJson(res, 200, { payloads }, origin);
        return;
      }

      sendJson(res, 404, { error: 'Not found' }, origin);
    } catch (error) {
      console.error('Codec server error', error);
      sendJson(res, 500, { error: 'Internal server error' }, origin);
    }
  });
}

export async function listenCodecHttpServer(options: CodecHttpServerOptions): Promise<{
  server: Server;
  port: number;
  close(): Promise<void>;
}> {
  const server = createCodecHttpServer(options);
  const port = options.port ?? Number(process.env.TEMPORAL_CODEC_PORT ?? 8888);
  const host = options.host ?? process.env.TEMPORAL_CODEC_HOST ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return {
    server,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
