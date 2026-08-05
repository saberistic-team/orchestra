import {
  PREVIEW_CONTRACT_VERSION,
  PREVIEW_RUNTIME_CONTRACT,
  previewDeploymentRequestSchema,
  previewDeploymentResultSchema,
  type PreviewDeploymentResult,
  type Project,
  type ProjectIteration,
} from '@orchestra/contracts';
import { chromium, type Video } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface UserFlowRecording {
  title: string;
  url: string;
  revision: string;
}

export type PreviewDeployment = PreviewDeploymentResult;

/** Retained only so old Workflow payloads remain decodable; reuse is forbidden. */
export interface ExistingIterationPreview {
  iterationId: string;
  title: string;
  url: string;
}

export interface DeployIterationPreviewInput {
  project: Project;
  iteration: ProjectIteration;
  existingPreview?: ExistingIterationPreview;
}

export type PreviewCaptureTarget = Pick<PreviewDeploymentResult, 'internalUrl' | 'revision'>;

export interface CaptureUserFlowInput {
  project: Project;
  iteration: ProjectIteration;
  preview: PreviewCaptureTarget;
}

const previewCaptureTargetSchema = previewDeploymentResultSchema.pick({
  internalUrl: true,
  revision: true,
});

async function requestGatewayHealth(url: URL, host: string) {
  return new Promise<number>((resolve, reject) => {
    const operation = httpRequest(url, {
      method: PREVIEW_RUNTIME_CONTRACT.health.method,
      headers: { accept: 'application/json', host },
      signal: AbortSignal.timeout(5_000),
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    operation.once('error', reject);
    operation.end();
  });
}

export const previewHealthInternals = { requestGatewayHealth };

async function postPreviewDeployment(
  url: URL,
  body: unknown,
  token: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': payload.byteLength,
      authorization: `Bearer ${token}`,
    },
  };

  return await new Promise((resolve, reject) => {
    const operation = transport(options, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > 1_000_000) {
          response.destroy(new Error('Preview deployment adapter response exceeded 1000000 bytes.'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
      response.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const timer = setTimeout(() => {
      operation.destroy(new Error(`Preview deployment adapter timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    operation.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    operation.write(payload);
    operation.end();
  });
}

export const previewAdapterInternals = { postPreviewDeployment };

function safePreviewIdentifier(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 50);
}

function validateManagedPreviewLocations(
  deployment: PreviewDeploymentResult,
  input: DeployIterationPreviewInput,
) {
  const publicUrl = new URL(deployment.publicUrl);
  const internalUrl = new URL(deployment.internalUrl);
  if (deployment.source === 'managed') {
    const expectedHostname = safePreviewIdentifier(
      `orchestra-preview-${input.project.id.slice(0, 8)}-${input.iteration.number}-${deployment.revision.slice(0, 12)}`,
    );
    const gatewayOrigin = new URL(process.env.PREVIEW_GATEWAY_PUBLIC_ORIGIN ?? 'http://localhost:3003');
    if (gatewayOrigin.protocol !== 'http:'
      || gatewayOrigin.hostname !== 'localhost'
      || !gatewayOrigin.port
      || gatewayOrigin.pathname !== '/'
      || gatewayOrigin.username
      || gatewayOrigin.password
      || gatewayOrigin.search
      || gatewayOrigin.hash) {
      throw new Error('PREVIEW_GATEWAY_PUBLIC_ORIGIN must be an http://localhost:<port> origin.');
    }
    if (publicUrl.protocol !== 'http:'
      || publicUrl.hostname !== `${expectedHostname}-${deployment.imageDigest.slice('sha256:'.length, 'sha256:'.length + 12)}.${gatewayOrigin.hostname}`
      || publicUrl.port !== gatewayOrigin.port
      || publicUrl.pathname !== '/'
      || publicUrl.username
      || publicUrl.password
      || publicUrl.search
      || publicUrl.hash) {
      throw new Error('Managed preview returned a public URL outside the configured local preview host.');
    }
    if (internalUrl.protocol !== 'http:'
      || internalUrl.hostname !== expectedHostname
      || internalUrl.port !== '8080'
      || internalUrl.pathname !== '/'
      || internalUrl.username
      || internalUrl.password
      || internalUrl.search
      || internalUrl.hash) {
      throw new Error('Managed preview returned an internal URL outside the isolated preview network.');
    }
    return;
  }
  const allowedPublic = new Set((process.env.PREVIEW_ADAPTER_PUBLIC_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
  const allowedInternal = new Set((process.env.PREVIEW_ADAPTER_INTERNAL_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean));
  if (!allowedPublic.has(publicUrl.origin) || !allowedInternal.has(internalUrl.origin)) {
    throw new Error('External preview adapter origins must be explicitly allowlisted.');
  }
}

export async function probePreviewHealth(
  deployment: PreviewDeploymentResult,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const healthUrl = new URL(PREVIEW_RUNTIME_CONTRACT.health.path, deployment.internalUrl);
  let response: Response;
  try {
    response = await fetchImplementation(healthUrl, {
      method: PREVIEW_RUNTIME_CONTRACT.health.method,
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(`Preview health probe could not reach the managed runtime: ${error instanceof Error ? error.message : String(error)}`);
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`Preview health probe returned ${response.status}.`);
  if (deployment.source !== 'managed') return;

  const gatewayOrigin = new URL(process.env.PREVIEW_GATEWAY_INTERNAL_ORIGIN ?? 'http://preview-gateway:3003');
  if (gatewayOrigin.protocol !== 'http:'
    || gatewayOrigin.hostname !== 'preview-gateway'
    || gatewayOrigin.port !== '3003'
    || gatewayOrigin.pathname !== '/'
    || gatewayOrigin.username
    || gatewayOrigin.password
    || gatewayOrigin.search
    || gatewayOrigin.hash) {
    throw new Error('PREVIEW_GATEWAY_INTERNAL_ORIGIN must be http://preview-gateway:3003.');
  }
  const publicUrl = new URL(deployment.publicUrl);
  let gatewayStatus: number;
  try {
    gatewayStatus = await previewHealthInternals.requestGatewayHealth(
      new URL(PREVIEW_RUNTIME_CONTRACT.health.path, gatewayOrigin),
      publicUrl.host,
    );
  } catch (error) {
    throw new Error(`Preview gateway probe could not reach the browser-facing route: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (gatewayStatus < 200 || gatewayStatus >= 300) throw new Error(`Preview gateway probe returned ${gatewayStatus}.`);
}

/**
 * Requests an isolated preview deployment from an explicitly configured
 * adapter. Orchestra never executes generated repositories inside the control
 * plane and never invents a preview URL when no adapter is available.
 */
export async function deployIterationPreview(input: DeployIterationPreviewInput): Promise<PreviewDeployment> {
  const endpoint = process.env.PREVIEW_DEPLOY_WEBHOOK_URL?.trim();
  if (!endpoint) throw new Error('Preview deployment is unavailable because PREVIEW_DEPLOY_WEBHOOK_URL is not configured.');
  if (!input.project.repositoryOwner || !input.project.repositoryName || !input.project.repositoryUrl || !input.iteration.branchName) {
    throw new Error('Preview deployment requires a connected repository and iteration branch.');
  }

  const token = process.env.PREVIEW_DEPLOY_TOKEN?.trim();
  if (!token) throw new Error('Preview deployment is unavailable because PREVIEW_DEPLOY_TOKEN is not configured.');
  const request = previewDeploymentRequestSchema.parse({
    contractVersion: PREVIEW_CONTRACT_VERSION,
    projectId: input.project.id,
    iterationId: input.iteration.id,
    iterationNumber: input.iteration.number,
    repository: {
      owner: input.project.repositoryOwner,
      name: input.project.repositoryName,
      url: input.project.repositoryUrl,
      branch: input.iteration.branchName,
    },
    runtime: PREVIEW_RUNTIME_CONTRACT,
  });
  const timeoutMs = Number(process.env.PREVIEW_DEPLOY_TIMEOUT_MS ?? 600_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('PREVIEW_DEPLOY_TIMEOUT_MS must be a positive integer.');
  }
  const response = await previewAdapterInternals.postPreviewDeployment(new URL(endpoint), request, token, timeoutMs);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Preview deployment adapter returned ${response.status}: ${response.text.slice(0, 300)}`);
  }
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(response.text);
  } catch {
    throw new Error('Preview deployment adapter returned invalid JSON.');
  }
  const parsed = previewDeploymentResultSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error(`Preview deployment adapter returned invalid managed evidence: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'result').join(', ')}.`);
  }
  validateManagedPreviewLocations(parsed.data, input);
  await probePreviewHealth(parsed.data);
  return parsed.data;
}

export function iterationEvidenceBranch(iteration: ProjectIteration): string {
  return `iteration-${iteration.number}-evidence`;
}

function forgejoHeaders() {
  const username = process.env.FORGEJO_ADMIN_USER ?? 'orchestra-agent';
  const password = process.env.FORGEJO_ADMIN_PASSWORD ?? 'orchestra-local-admin-change-me';
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    'content-type': 'application/json',
  };
}

async function ensureEvidenceBranch(
  project: Project,
  iteration: ProjectIteration,
  internalUrl: string,
  headers: ReturnType<typeof forgejoHeaders>,
): Promise<string> {
  const branch = iterationEvidenceBranch(iteration);
  const repositoryPath = `/api/v1/repos/${encodeURIComponent(project.repositoryOwner!)}/${encodeURIComponent(project.repositoryName!)}`;
  const branchUrl = new URL(`${repositoryPath}/branches/${encodeURIComponent(branch)}`, internalUrl);
  const existing = await fetch(branchUrl, { headers, signal: AbortSignal.timeout(60_000) });
  if (existing.ok) return branch;
  if (existing.status !== 404) {
    throw new Error(`Forgejo evidence branch lookup returned ${existing.status}: ${(await existing.text()).slice(0, 300)}`);
  }

  const created = await fetch(new URL(`${repositoryPath}/branches`, internalUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({ new_branch_name: branch, old_branch_name: iteration.branchName }),
    signal: AbortSignal.timeout(60_000),
  });
  if (created.ok) return branch;
  if (created.status !== 409 && created.status !== 422) {
    throw new Error(`Forgejo evidence branch creation returned ${created.status}: ${(await created.text()).slice(0, 300)}`);
  }

  const confirmed = await fetch(branchUrl, { headers, signal: AbortSignal.timeout(60_000) });
  if (!confirmed.ok) {
    throw new Error(`Forgejo could not confirm evidence branch ${branch}: ${confirmed.status} ${(await confirmed.text()).slice(0, 300)}`);
  }
  return branch;
}

export async function forgejoUpload(project: Project, iteration: ProjectIteration, path: string, bytes: Buffer) {
  if (!project.repositoryOwner || !project.repositoryName || !iteration.branchName) throw new Error('Repository delivery context is missing.');
  const internalUrl = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
  const publicUrl = process.env.FORGEJO_PUBLIC_URL ?? 'http://localhost:3001';
  const headers = forgejoHeaders();
  const evidenceBranch = await ensureEvidenceBranch(project, iteration, internalUrl, headers);
  const contentPath = `/api/v1/repos/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const contentUrl = new URL(contentPath, internalUrl);
  const lookupUrl = new URL(contentUrl);
  lookupUrl.searchParams.set('ref', evidenceBranch);
  const lookup = await fetch(lookupUrl, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (lookup.status !== 404) {
    if (!lookup.ok) throw new Error(`Forgejo recording lookup returned ${lookup.status}: ${(await lookup.text()).slice(0, 300)}`);
    const existing = await lookup.json() as { sha?: unknown };
    if (typeof existing.sha !== 'string' || !existing.sha) {
      throw new Error(`Forgejo returned existing recording content without a SHA for ${path} on ${evidenceBranch}.`);
    }
    return forgejoRecordingUrl(project, path, evidenceBranch, publicUrl);
  }
  const response = await fetch(contentUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      branch: evidenceBranch,
      content: bytes.toString('base64'),
      message: `test: record iteration ${iteration.number} preview flow`,
      author: { name: 'test agent', email: 'test@orchestra.local' },
      committer: { name: 'Orchestra', email: 'agent@orchestra.local' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    if (response.status !== 409 && response.status !== 422) {
      throw new Error(`Forgejo recording upload returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const confirmed = await fetch(lookupUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (!confirmed.ok) {
      throw new Error(`Forgejo could not confirm concurrent recording upload for ${path}: ${confirmed.status} ${(await confirmed.text()).slice(0, 300)}`);
    }
  }
  return forgejoRecordingUrl(project, path, evidenceBranch, publicUrl);
}

function forgejoRecordingUrl(project: Project, path: string, evidenceBranch: string, publicUrl: string): string {
  if (!project.repositoryOwner || !project.repositoryName) {
    throw new Error('Repository delivery context is missing.');
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${publicUrl}/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}/raw/branch/${encodeURIComponent(evidenceBranch)}/${encodedPath}`;
}

/** Returns the immutable revision-bound recording when an earlier attempt already committed it. */
export async function findForgejoUpload(
  project: Project,
  iteration: ProjectIteration,
  path: string,
): Promise<string | undefined> {
  if (!project.repositoryOwner || !project.repositoryName || !iteration.branchName) throw new Error('Repository delivery context is missing.');
  const internalUrl = process.env.FORGEJO_URL ?? 'http://forgejo:3000';
  const publicUrl = process.env.FORGEJO_PUBLIC_URL ?? 'http://localhost:3001';
  const headers = forgejoHeaders();
  const evidenceBranch = await ensureEvidenceBranch(project, iteration, internalUrl, headers);
  const contentPath = `/api/v1/repos/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const lookupUrl = new URL(contentPath, internalUrl);
  lookupUrl.searchParams.set('ref', evidenceBranch);
  const lookup = await fetch(lookupUrl, { headers, signal: AbortSignal.timeout(60_000) });
  if (lookup.status === 404) return undefined;
  if (!lookup.ok) throw new Error(`Forgejo recording lookup returned ${lookup.status}: ${(await lookup.text()).slice(0, 300)}`);
  const existing = await lookup.json() as { sha?: unknown };
  if (typeof existing.sha !== 'string' || !existing.sha) {
    throw new Error(`Forgejo returned existing recording content without a SHA for ${path} on ${evidenceBranch}.`);
  }
  return forgejoRecordingUrl(project, path, evidenceBranch, publicUrl);
}

export function isAllowedPreviewRequestUrl(value: string, allowedOrigin: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === allowedOrigin;
  } catch {
    return false;
  }
}

export function isAllowedPreviewWebSocketUrl(value: string, allowedOrigin: string): boolean {
  try {
    const url = new URL(value);
    const origin = new URL(allowedOrigin);
    if (url.username || url.password) return false;
    if (origin.protocol === 'http:' && url.protocol !== 'ws:') return false;
    if (origin.protocol === 'https:' && url.protocol !== 'wss:') return false;
    url.protocol = origin.protocol;
    return url.origin === origin.origin;
  } catch {
    return false;
  }
}

export async function captureUserFlow(input: CaptureUserFlowInput): Promise<UserFlowRecording> {
  // PreviewDeploymentResult is intentionally richer than the recorder's
  // target. Explicitly project the two trusted routing fields before applying
  // the strict schema so valid contract metadata is not rejected as excess.
  const preview = previewCaptureTargetSchema.parse({
    internalUrl: input.preview.internalUrl,
    revision: input.preview.revision,
  });
  const target = new URL(preview.internalUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Preview recording requires an HTTP(S) internal URL.');
  }
  const expectedHostname = safePreviewIdentifier(
    `orchestra-preview-${input.project.id.slice(0, 8)}-${input.iteration.number}-${preview.revision.slice(0, 12)}`,
  );
  if (target.hostname !== expectedHostname || target.port !== '8080') {
    throw new Error('Preview recording target is outside the isolated preview network.');
  }
  const path = `artifacts/iteration-${String(input.iteration.number).padStart(2, '0')}/preview-smoke-flow-${preview.revision.slice(0, 12)}.webm`;
  const existingRecordingUrl = await findForgejoUpload(input.project, input.iteration, path);
  if (existingRecordingUrl) {
    return { title: 'Latest preview smoke flow', url: existingRecordingUrl, revision: preview.revision };
  }
  const allowedOrigin = target.origin;
  const directory = await mkdtemp(join(tmpdir(), 'orchestra-flow-'));
  try {
    const browser = await chromium.launch({ headless: true });
    let videoPath: string | undefined;
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        recordVideo: { dir: directory, size: { width: 1280, height: 800 } },
        serviceWorkers: 'block',
      });
      let video: Video | null | undefined;
      try {
        let blockedNavigation: string | undefined;
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (isAllowedPreviewRequestUrl(request.url(), allowedOrigin)) {
            await route.continue();
            return;
          }
          if (request.isNavigationRequest()) blockedNavigation = request.url();
          await route.abort('blockedbyclient');
        });
        await context.routeWebSocket(/.*/u, async (webSocket) => {
          if (isAllowedPreviewWebSocketUrl(webSocket.url(), allowedOrigin)) {
            webSocket.connectToServer();
            return;
          }
          await webSocket.close({ code: 1008, reason: 'WebSocket origin is outside the managed preview.' });
        });
        const page = await context.newPage();
        video = page.video();
        let response;
        try {
          response = await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 60_000 });
        } catch (error) {
          if (blockedNavigation) throw new Error(`Preview redirected outside its managed origin to ${blockedNavigation}.`);
          throw error;
        }
        const finalUrl = response?.url() ?? page.url();
        if (new URL(finalUrl).origin !== allowedOrigin) {
          throw new Error(`Preview redirected outside its managed origin to ${finalUrl}.`);
        }
        await page.waitForTimeout(1_500);
        await page.mouse.wheel(0, 650);
        await page.waitForTimeout(900);
        await page.mouse.wheel(0, -650);
        await page.waitForTimeout(600);
      } finally {
        await context.close();
      }
      videoPath = await video?.path();
    } finally {
      await browser.close();
    }
    if (!videoPath) throw new Error('Playwright did not produce a user-flow recording.');
    const url = await forgejoUpload(input.project, input.iteration, path, await readFile(videoPath));
    return { title: 'Latest preview smoke flow', url, revision: preview.revision };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
