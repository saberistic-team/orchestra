import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DockerPreviewManager } from './docker-preview.js';
import { parsePreviewDeploymentRequest } from './types.js';

const MAX_BODY_BYTES = 64 * 1024;

function json(response: ServerResponse, status: number, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

function authenticated(request: IncomingMessage, expected: string) {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(supplied.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function readJson(request: IncomingMessage) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 2_500)
    || 'The local preview deployment failed.';
}

export function createPreviewServer(manager: DockerPreviewManager, token: string) {
  if (token.length < 16) throw new Error('PREVIEW_MANAGER_TOKEN must contain at least 16 characters.');
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://preview-manager.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        await manager.ready();
        return json(response, 200, { status: 'ok' });
      } catch {
        return json(response, 503, { status: 'unavailable' });
      }
    }
    if (request.method !== 'POST' || url.pathname !== '/previews') return json(response, 404, { error: 'Not found.' });
    if (!authenticated(request, token)) return json(response, 401, { error: 'Unauthorized.' });
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return json(response, 415, { error: 'Content-Type must be application/json.' });
    }
    try {
      const input = parsePreviewDeploymentRequest(await readJson(request));
      const deployment = await manager.deploy(input);
      return json(response, 201, deployment);
    } catch (error) {
      return json(response, 422, { error: safeError(error) });
    }
  });
}
