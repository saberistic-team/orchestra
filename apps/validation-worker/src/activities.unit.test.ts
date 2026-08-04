import {
  PREVIEW_CONTRACT_VERSION,
  PREVIEW_RUNTIME_CONTRACT,
  type PreviewDeploymentResult,
  type Project,
  type ProjectIteration,
} from '@orchestra/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

const { chromiumLaunchMock } = vi.hoisted(() => ({ chromiumLaunchMock: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: chromiumLaunchMock } }));

import {
  captureUserFlow,
  deployIterationPreview,
  forgejoUpload,
  isAllowedPreviewRequestUrl,
  isAllowedPreviewWebSocketUrl,
  iterationEvidenceBranch,
  probePreviewHealth,
  previewHealthInternals,
} from './activities.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  chromiumLaunchMock.mockReset();
});

const projectId = '15f5f325-dca2-4016-9f1a-127cfdc909a5';
const iterationId = '25f5f325-dca2-4016-9f1a-127cfdc909a5';
const revision = '0123456789abcdef0123456789abcdef01234567';
const previewHostname = `orchestra-preview-${projectId.slice(0, 8)}-2-${revision.slice(0, 12)}`;

function fixture() {
  const now = new Date().toISOString();
  const project: Project = {
    id: projectId,
    name: 'Previewable project',
    intent: 'Give a person a safe runnable preview before they decide whether to approve an iteration.',
    audience: 'Project owners',
    success: 'A reviewer can use the deployed increment before approving it.',
    constraints: [],
    status: 'reviewing',
    currentIteration: 2,
    previewUrl: null,
    repositoryUrl: 'http://localhost:3001/orchestra-agent/previewable-project',
    repositoryOwner: 'orchestra-agent',
    repositoryName: 'previewable-project',
    createdAt: now,
    updatedAt: now,
  };
  const iteration: ProjectIteration = {
    id: iterationId,
    projectId: project.id,
    number: 2,
    objective: 'Deploy the next reviewable increment.',
    status: 'active',
    startedAt: now,
    completedAt: null,
    issueNumber: 2,
    branchName: 'iteration-2-agents',
    pullRequestNumber: 2,
    pullRequestUrl: `${project.repositoryUrl}/pulls/2`,
  };
  return { project, iteration };
}

function managedResult(overrides: Partial<PreviewDeploymentResult> = {}): PreviewDeploymentResult {
  return {
    contractVersion: PREVIEW_CONTRACT_VERSION,
    title: 'Review build 2',
    publicUrl: `http://${previewHostname}-${'a'.repeat(12)}.localhost:3003/`,
    internalUrl: `http://${previewHostname}:8080/`,
    revision,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-08-04T14:00:00.000Z',
    source: 'managed',
    runtime: PREVIEW_RUNTIME_CONTRACT,
    ...overrides,
  };
}

describe('preview deployment activity', () => {
  it('always calls the adapter and returns exact managed revision evidence', async () => {
    vi.stubEnv('PREVIEW_DEPLOY_WEBHOOK_URL', 'https://deployer.example.test/previews');
    vi.stubEnv('PREVIEW_DEPLOY_TOKEN', 'preview-token');
    const result = managedResult();
    const gatewayProbe = vi.spyOn(previewHealthInternals, 'requestGatewayHealth').mockResolvedValue(204);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const input = fixture();

    await expect(deployIterationPreview({
      ...input,
      existingPreview: {
        iterationId: input.iteration.id,
        title: 'Stale same-iteration preview',
        url: 'https://preview.example.test/stale',
      },
    })).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.headers).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer preview-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(request.body as string)).toEqual({
      contractVersion: PREVIEW_CONTRACT_VERSION,
      projectId: input.project.id,
      iterationId: input.iteration.id,
      iterationNumber: 2,
      repository: {
        owner: 'orchestra-agent',
        name: 'previewable-project',
        url: input.project.repositoryUrl,
        branch: 'iteration-2-agents',
      },
      runtime: PREVIEW_RUNTIME_CONTRACT,
    });
    expect(fetchMock.mock.calls[1]?.[0]?.toString()).toBe(`http://${previewHostname}:8080/health`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(gatewayProbe).toHaveBeenCalledWith(
      new URL('http://preview-gateway:3003/health'),
      `${previewHostname}-${'a'.repeat(12)}.localhost:3003`,
    );
  });

  it('rejects a deployment whose validated runtime does not pass GET /health', async () => {
    const deployment = managedResult();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(probePreviewHealth(deployment, fetchMock)).rejects.toThrow('returned 503');
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`http://${previewHostname}:8080/health`),
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('rejects adapter responses missing immutable deployment evidence', async () => {
    vi.stubEnv('PREVIEW_DEPLOY_WEBHOOK_URL', 'https://deployer.example.test/previews');
    vi.stubEnv('PREVIEW_DEPLOY_TOKEN', 'preview-token');
    const { imageDigest: _imageDigest, ...incomplete } = managedResult();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(incomplete), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(deployIterationPreview(fixture())).rejects.toThrow(/invalid managed evidence.*imageDigest/i);
  });

  it('rejects a managed deployment that points browser validation at a control-plane host', async () => {
    vi.stubEnv('PREVIEW_DEPLOY_WEBHOOK_URL', 'https://deployer.example.test/previews');
    vi.stubEnv('PREVIEW_DEPLOY_TOKEN', 'preview-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(managedResult({
      internalUrl: 'http://postgres:5432/',
    })), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(deployIterationPreview(fixture())).rejects.toThrow(/isolated preview network/i);
  });

  it('rejects a managed deployment bound to another preview container', async () => {
    vi.stubEnv('PREVIEW_DEPLOY_WEBHOOK_URL', 'https://deployer.example.test/previews');
    vi.stubEnv('PREVIEW_DEPLOY_TOKEN', 'preview-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(managedResult({
      internalUrl: 'http://orchestra-preview-another-project-2-0123456789ab:8080/',
    })), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(deployIterationPreview(fixture())).rejects.toThrow(/isolated preview network/i);
  });

  it('requires both the configured adapter and its bearer credential', async () => {
    await expect(deployIterationPreview(fixture())).rejects.toThrow('PREVIEW_DEPLOY_WEBHOOK_URL');

    vi.stubEnv('PREVIEW_DEPLOY_WEBHOOK_URL', 'https://deployer.example.test/previews');
    await expect(deployIterationPreview(fixture())).rejects.toThrow('PREVIEW_DEPLOY_TOKEN');
  });
});

describe('Forgejo preview recording uploads', () => {
  it('updates an existing recording only on the dedicated evidence branch', async () => {
    const calls: Array<{ url: URL; method: string; body?: BodyInit | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body });
      if (url.pathname.endsWith('/branches/iteration-2-evidence')) return new Response('{}', { status: 200 });
      if (method === 'GET') {
        return new Response(JSON.stringify({ sha: 'existing-recording-sha' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 200 });
    }));
    const input = fixture();

    const url = await forgejoUpload(
      input.project,
      input.iteration,
      'artifacts/iteration-02/preview-smoke-flow.webm',
      Buffer.from('new recording'),
    );

    expect(iterationEvidenceBranch(input.iteration)).toBe('iteration-2-evidence');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'PUT']);
    expect(calls[1]?.url.searchParams.get('ref')).toBe('iteration-2-evidence');
    expect(JSON.parse(String(calls[2]?.body))).toMatchObject({
      branch: 'iteration-2-evidence',
      sha: 'existing-recording-sha',
    });
    expect(JSON.parse(String(calls[2]?.body)).branch).not.toBe(input.iteration.branchName);
    expect(url).toContain('/raw/branch/iteration-2-evidence/');
  });

  it('creates the evidence branch from the review source before adding a new recording', async () => {
    const calls: Array<{ url: URL; method: string; body?: BodyInit | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body });
      if (method === 'GET') return new Response(null, { status: 404 });
      if (url.pathname.endsWith('/branches')) return new Response('{}', { status: 201 });
      return new Response(null, { status: 201 });
    }));
    const input = fixture();

    await forgejoUpload(
      input.project,
      input.iteration,
      'artifacts/iteration-02/preview-smoke-flow.webm',
      Buffer.from('first recording'),
    );

    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      new_branch_name: 'iteration-2-evidence',
      old_branch_name: 'iteration-2-agents',
    });
    expect(JSON.parse(String(calls[3]?.body))).toMatchObject({ branch: 'iteration-2-evidence' });
    expect(JSON.parse(String(calls[3]?.body))).not.toHaveProperty('sha');
  });
});

describe('managed preview recording boundary', () => {
  it('allows only the exact managed origin plus data and blob URLs', () => {
    expect(isAllowedPreviewRequestUrl('http://preview-runtime:8080/assets/app.js', 'http://preview-runtime:8080')).toBe(true);
    expect(isAllowedPreviewRequestUrl('data:image/png;base64,AA==', 'http://preview-runtime:8080')).toBe(true);
    expect(isAllowedPreviewRequestUrl('blob:http://preview-runtime:8080/id', 'http://preview-runtime:8080')).toBe(true);
    expect(isAllowedPreviewRequestUrl('https://cdn.example.test/app.js', 'http://preview-runtime:8080')).toBe(false);
    expect(isAllowedPreviewRequestUrl('http://preview-runtime:8081/app.js', 'http://preview-runtime:8080')).toBe(false);
  });

  it('allows WebSockets only on the matching managed origin', () => {
    expect(isAllowedPreviewWebSocketUrl('ws://preview-runtime:8080/live', 'http://preview-runtime:8080')).toBe(true);
    expect(isAllowedPreviewWebSocketUrl('wss://preview-runtime:8080/live', 'https://preview-runtime:8080')).toBe(true);
    expect(isAllowedPreviewWebSocketUrl('ws://forgejo:3000/live', 'http://preview-runtime:8080')).toBe(false);
    expect(isAllowedPreviewWebSocketUrl('wss://preview-runtime:8080/live', 'http://preview-runtime:8080')).toBe(false);
  });

  it('blocks service workers, records the internal target, and returns its revision', async () => {
    const input = fixture();
    input.project.previewUrl = 'http://localhost:9999/stale-public-preview';
    const videoFixture = fileURLToPath(new URL('../package.json', import.meta.url));
    const page = {
      goto: vi.fn().mockResolvedValue({ url: () => `http://${previewHostname}:8080/` }),
      url: vi.fn().mockReturnValue(`http://${previewHostname}:8080/`),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
      video: vi.fn().mockReturnValue({ path: vi.fn().mockResolvedValue(videoFixture) }),
    };
    const context = {
      route: vi.fn().mockResolvedValue(undefined),
      routeWebSocket: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    chromiumLaunchMock.mockResolvedValue(browser);
    vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const method = init.method ?? 'GET';
      if (url.pathname.endsWith('/branches/iteration-2-evidence')) return new Response('{}', { status: 200 });
      if (method === 'GET') return new Response(null, { status: 404 });
      return new Response(null, { status: 201 });
    }));

    await expect(captureUserFlow({
      ...input,
      // The workflow passes the complete revision-bound deployment result.
      // Recorder validation must safely project its two routing fields.
      preview: managedResult(),
    })).resolves.toMatchObject({
      title: 'Latest preview smoke flow',
      revision,
      url: expect.stringContaining(`preview-smoke-flow-${revision.slice(0, 12)}.webm`),
    });

    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: 'block' }));
    expect(context.routeWebSocket).toHaveBeenCalledOnce();
    const webSocketHandler = context.routeWebSocket.mock.calls[0]?.[1] as ((socket: {
      url: () => string;
      connectToServer: () => unknown;
      close: (options: unknown) => Promise<void>;
    }) => Promise<void>);
    const allowedSocket = {
      url: () => `ws://${previewHostname}:8080/live`,
      connectToServer: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    await webSocketHandler(allowedSocket);
    expect(allowedSocket.connectToServer).toHaveBeenCalledOnce();
    expect(allowedSocket.close).not.toHaveBeenCalled();
    const blockedSocket = {
      url: () => 'ws://forgejo:3000/api/live',
      connectToServer: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    await webSocketHandler(blockedSocket);
    expect(blockedSocket.connectToServer).not.toHaveBeenCalled();
    expect(blockedSocket.close).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
    expect(page.goto).toHaveBeenCalledWith(`http://${previewHostname}:8080/`, expect.any(Object));
    expect(page.goto).not.toHaveBeenCalledWith(input.project.previewUrl, expect.anything());
  });

  it('rejects a navigation that finishes on another origin', async () => {
    const input = fixture();
    const page = {
      goto: vi.fn().mockResolvedValue({ url: () => 'https://redirected.example.test/' }),
      url: vi.fn().mockReturnValue('https://redirected.example.test/'),
      waitForTimeout: vi.fn(),
      mouse: { wheel: vi.fn() },
      video: vi.fn().mockReturnValue(undefined),
    };
    const context = {
      route: vi.fn().mockResolvedValue(undefined),
      routeWebSocket: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    chromiumLaunchMock.mockResolvedValue({
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await expect(captureUserFlow({
      ...input,
      preview: { internalUrl: `http://${previewHostname}:8080/`, revision },
    })).rejects.toThrow(/redirected outside its managed origin/i);
    expect(context.close).toHaveBeenCalledOnce();
  });
});
