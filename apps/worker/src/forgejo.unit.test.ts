import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectArtifact, ProjectIteration } from '@orchestra/contracts';
import {
  applyIterationReviewLifecycle,
  assertSafeGeneratedSourcePath,
  commitArtifact,
  createForgejoLifecycleAdapter,
  ensureProjectRepository,
  type ForgejoLifecyclePermission,
  type ForgejoTransport,
} from './forgejo.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const now = '2026-08-03T12:00:00.000Z';
const project: Project = {
  id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
  name: 'Orchestra',
  intent: 'Help a person build software from their intentions.',
  audience: 'Non-technical founders',
  success: 'A reviewed first release is produced safely.',
  constraints: [],
  status: 'awaiting_approval',
  currentIteration: 1,
  previewUrl: null,
  repositoryUrl: 'https://forgejo.example/orchestra/orchestra',
  repositoryOwner: 'orchestra',
  repositoryName: 'orchestra',
  createdAt: now,
  updatedAt: now,
};

const iteration: ProjectIteration = {
  id: 'c67a2fd5-e829-40dc-a6f5-d15e4758515d',
  projectId: project.id,
  number: 1,
  objective: 'Deliver a reviewable walking skeleton.',
  status: 'awaiting_review',
  startedAt: now,
  completedAt: null,
  issueNumber: 12,
  branchName: 'iteration-1-agents',
  pullRequestNumber: 14,
  pullRequestUrl: 'https://forgejo.example/orchestra/orchestra/pulls/14',
};

function artifact(overrides: Partial<ProjectArtifact> = {}): ProjectArtifact {
  return {
    id: 'd67a2fd5-e829-40dc-a6f5-d15e4758515d',
    projectId: project.id,
    iterationId: iteration.id,
    type: 'source-file:src/app.ts',
    name: 'src/app.ts',
    version: 1,
    content: 'export const version = 1;',
    mimeType: 'text/plain',
    status: 'ready_for_review',
    producedBy: 'builder',
    model: 'test-model',
    repositoryPath: null,
    repositoryUrl: null,
    createdAt: now,
    reviewedAt: null,
    ...overrides,
  };
}

function contentFetch(existingSha?: string) {
  const calls: Array<{ url: URL; method: string; body?: BodyInit | null }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });
    if (method === 'GET' && url.pathname.includes('/contents/')) {
      return existingSha
        ? new Response(JSON.stringify({ sha: existingSha }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 201 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function mockTransport(pullHead?: string) {
  const calls: Array<{ path: string; method: string; body?: BodyInit | null }> = [];
  const transport: ForgejoTransport = {
    async request<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path.endsWith('/pulls/14') && (init.method ?? 'GET') === 'GET') {
        return { number: 14, html_url: iteration.pullRequestUrl, merged: false, head: { sha: pullHead } } as T;
      }
      if (path.endsWith('/labels') && (init.method ?? 'GET') === 'GET') return [] as T;
      if (path.endsWith('/labels') && init.method === 'POST') {
        const definition = JSON.parse(String(init.body)) as { name: string; color: string };
        return { id: calls.length, ...definition } as T;
      }
      if (path.endsWith('/projects') && (init.method ?? 'GET') === 'GET') return [] as T;
      if (path.includes('/wiki/page/')) return undefined;
      return {} as T;
    },
  };
  return { calls, transport };
}

const everyPermission = new Set<ForgejoLifecyclePermission>([
  'pull_requests:comment',
  'pull_requests:merge',
  'issues:close',
  'labels:write',
  'projects:write',
  'releases:write',
  'packages:write',
  'wiki:write',
]);

describe('Forgejo iteration lifecycle', () => {
  it('merges and closes an approved iteration, then reports optional publishing steps independently', async () => {
    const { calls, transport } = mockTransport();
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await applyIterationReviewLifecycle(project, iteration, 'approved', 'Ship it.', adapter);

    expect(result).toMatchObject({ decision: 'approved', merged: true, issueClosed: true });
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'merge_pull_request', status: 'completed' }),
      expect.objectContaining({ action: 'close_issue', status: 'completed' }),
      expect.objectContaining({ action: 'publish_release', status: 'completed' }),
      expect.objectContaining({ action: 'upload_review_package', status: 'completed' }),
      expect.objectContaining({ action: 'publish_iteration_wiki', status: 'completed' }),
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/v1/repos/orchestra/orchestra/issues/14/comments', method: 'POST' }),
      expect.objectContaining({ path: '/api/v1/repos/orchestra/orchestra/pulls/14/merge', method: 'POST' }),
      expect.objectContaining({ path: '/api/v1/repos/orchestra/orchestra/issues/12', method: 'PATCH' }),
      expect.objectContaining({ path: '/api/v1/repos/orchestra/orchestra/releases', method: 'POST' }),
      expect.objectContaining({ path: expect.stringContaining('/api/packages/'), method: 'PUT' }),
      expect.objectContaining({ path: '/api/v1/repos/orchestra/orchestra/wiki/new', method: 'POST' }),
    ]));
  });

  it('routes default HTTP lifecycle calls through /api/v1 repository endpoints', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requested.push(`${init.method ?? 'GET'} ${url.pathname}`);
      if ((init.method ?? 'GET') === 'GET' && url.pathname.endsWith('/pulls/14')) {
        return new Response(JSON.stringify({ number: 14, html_url: iteration.pullRequestUrl, merged: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if ((init.method ?? 'GET') === 'GET' && url.pathname.endsWith('/labels')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if ((init.method ?? 'GET') === 'GET' && url.pathname.endsWith('/projects')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if ((init.method ?? 'GET') === 'GET' && url.pathname.includes('/wiki/page/')) {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify({ id: 1, name: 'iteration/approved', color: '2da44e' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const result = await applyIterationReviewLifecycle(project, iteration, 'approved', 'Ship it.');

    expect(result.merged).toBe(true);
    expect(requested).toEqual(expect.arrayContaining([
      'POST /api/v1/repos/orchestra/orchestra/issues/14/comments',
      'GET /api/v1/repos/orchestra/orchestra/pulls/14',
      'POST /api/v1/repos/orchestra/orchestra/pulls/14/merge',
    ]));
    expect(requested.some((call) => call.includes(' /repos/') && !call.includes('/api/v1/repos/'))).toBe(false);
  });

  it('never attempts a merge when changes are requested', async () => {
    const { calls, transport } = mockTransport();
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await applyIterationReviewLifecycle(project, iteration, 'changes_requested', 'Revise the empty state.', adapter);

    expect(result).toMatchObject({ decision: 'changes_requested', merged: false, issueClosed: false });
    expect(calls.some((call) => call.path.includes('/merge'))).toBe(false);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('makes merge a no-op with an explicit status when permission is absent', async () => {
    const { calls, transport } = mockTransport();
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: new Set() });

    const result = await adapter.finalizeApprovedIteration(project, iteration, {
      decision: 'approved',
      approvedBy: 'human',
    });

    expect(result).toMatchObject({ merged: false, issueClosed: false });
    expect(result.steps[0]).toMatchObject({ action: 'merge_pull_request', status: 'skipped' });
    expect(calls).toEqual([]);
  });

  it('does not close an issue when Forgejo rejects the merge', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const transport: ForgejoTransport = {
      async request<T>(path: string, init: RequestInit = {}): Promise<T | undefined> {
        calls.push({ path, method: init.method ?? 'GET' });
        if (path.endsWith('/pulls/14/merge')) throw new Error('Forgejo returned 409: merge conflict');
        return {} as T;
      },
    };
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await adapter.finalizeApprovedIteration(project, iteration, {
      decision: 'approved',
      approvedBy: 'human',
    });

    expect(result).toMatchObject({ merged: false, issueClosed: false });
    expect(result.steps[0]).toMatchObject({ action: 'merge_pull_request', status: 'failed' });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('returns a failed merge step and never merges when the PR head is stale', async () => {
    const expectedRevision = '0123456789abcdef0123456789abcdef01234567';
    const { calls, transport } = mockTransport('f'.repeat(40));
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await adapter.finalizeApprovedIteration(project, iteration, {
      decision: 'approved',
      approvedBy: 'human',
      expectedRevision,
    });

    expect(result).toMatchObject({ merged: false, issueClosed: false });
    expect(result.steps[0]).toMatchObject({
      action: 'merge_pull_request',
      status: 'failed',
      detail: expect.stringContaining(`expected ${expectedRevision}`),
    });
    expect(calls.some((call) => call.path.endsWith('/pulls/14/merge'))).toBe(false);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('passes the matching expected head to Forgejo for an atomic guarded merge', async () => {
    const expectedRevision = '0123456789abcdef0123456789abcdef01234567';
    const { calls, transport } = mockTransport(expectedRevision);
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await adapter.finalizeApprovedIteration(project, iteration, {
      decision: 'approved',
      approvedBy: 'human',
      expectedRevision,
    });

    expect(result.merged).toBe(true);
    const merge = calls.find((call) => call.path.endsWith('/pulls/14/merge'));
    expect(JSON.parse(String(merge?.body))).toMatchObject({ head_commit_id: expectedRevision });
  });

  it('does not let an optional review-comment failure prevent a successful merge', async () => {
    const { calls, transport: base } = mockTransport();
    const transport: ForgejoTransport = {
      request<T>(path: string, init?: RequestInit, allow?: readonly number[]) {
        if (path.endsWith('/issues/14/comments')) throw new Error('Comments are temporarily unavailable');
        return base.request<T>(path, init, allow);
      },
    };
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await applyIterationReviewLifecycle(project, iteration, 'approved', 'Approved.', adapter);

    expect(result.merged).toBe(true);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'record_review_comment', status: 'failed' }),
      expect.objectContaining({ action: 'merge_pull_request', status: 'completed' }),
    ]));
    expect(calls.some((call) => call.path.endsWith('/pulls/14/merge'))).toBe(true);
  });

  it('exposes all lifecycle capabilities and their configured state', () => {
    const adapter = createForgejoLifecycleAdapter({ permissions: new Set(['packages:write', 'wiki:write']) });
    const capabilities = adapter.capabilities();

    expect(capabilities.map((capability) => capability.name)).toEqual([
      'issue_pull_request_links', 'labels', 'projects', 'releases', 'packages', 'wiki',
    ]);
    expect(capabilities.find((capability) => capability.name === 'packages')?.enabled).toBe(true);
    expect(capabilities.find((capability) => capability.name === 'releases')?.enabled).toBe(false);
  });

  it('ensures lifecycle status labels and a label for every agent role', async () => {
    const { calls, transport } = mockTransport();
    const adapter = createForgejoLifecycleAdapter({ transport, permissions: everyPermission });

    const result = await adapter.ensureRepositoryLabels(project);
    const createdLabels = calls.filter((call) => call.path.endsWith('/labels') && call.method === 'POST');

    expect(result).toMatchObject({ status: 'completed' });
    expect(createdLabels).toHaveLength(18);
  });
});

describe('Forgejo artifact commits', () => {
  it('creates a new artifact file with POST after the target-branch lookup returns 404', async () => {
    const calls = contentFetch();

    await commitArtifact(project, iteration, artifact({
      type: 'build-submission',
      name: 'Build submission',
      mimeType: 'text/markdown',
      content: '# Build',
    }));

    const contentCalls = calls.filter((call) => call.url.pathname.includes('/contents/'));
    expect(contentCalls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(contentCalls[0]?.url.searchParams.get('ref')).toBe('iteration-1-agents');
    expect(JSON.parse(String(contentCalls[1]?.body))).not.toHaveProperty('sha');
  });

  it.each([
    {
      scenario: 'a same-iteration source revision',
      targetIteration: iteration,
      version: 2,
      sha: 'same-iteration-sha',
    },
    {
      scenario: 'a source file inherited by a later iteration branch',
      targetIteration: { ...iteration, id: 'e67a2fd5-e829-40dc-a6f5-d15e4758515d', number: 2, branchName: 'iteration-2-agents' },
      version: 3,
      sha: 'later-iteration-sha',
    },
  ])('updates $scenario with PUT and the target-branch SHA', async ({ targetIteration, version, sha }) => {
    const calls = contentFetch(sha);

    await commitArtifact(project, targetIteration, artifact({
      iterationId: targetIteration.id,
      version,
      content: `export const version = ${version};`,
    }));

    const contentCalls = calls.filter((call) => call.url.pathname.includes('/contents/'));
    expect(contentCalls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(contentCalls[0]?.url.searchParams.get('ref')).toBe(targetIteration.branchName);
    expect(JSON.parse(String(contentCalls[1]?.body))).toMatchObject({
      branch: targetIteration.branchName,
      sha,
    });
  });

  it('rejects reserved generated source paths before any repository mutation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(commitArtifact(project, iteration, artifact({
      type: 'source-file:.github/workflows/generated-release.yml',
      name: '.github/workflows/generated-release.yml',
    }))).rejects.toThrow('reserved-ci-workflows:write');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('generated repository safety policy', () => {
  it.each([
    '.github/workflows/release.yml',
    '.forgejo/workflows/test.yaml',
    '.env',
    '.env.production',
    'credentials.json',
    '.aws/credentials',
    'production-signing.key',
  ])('blocks %s without an explicit grant', (path) => {
    expect(() => assertSafeGeneratedSourcePath(path)).toThrow(/grant/);
  });

  it('allows ordinary repository-relative source paths', () => {
    expect(assertSafeGeneratedSourcePath('src/features/home.ts')).toBe('src/features/home.ts');
  });

  it('recognizes explicit, narrowly scoped grants for future trusted callers', () => {
    expect(assertSafeGeneratedSourcePath(
      '.github/workflows/release.yml',
      new Set(['reserved-ci-workflows:write'] as const),
    )).toBe('.github/workflows/release.yml');
    expect(assertSafeGeneratedSourcePath(
      '.env.example',
      new Set(['sensitive-root-files:write'] as const),
    )).toBe('.env.example');
  });

  it('creates generated repositories as private by default', async () => {
    const requests: Array<{ method: string; body?: BodyInit | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_request: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      requests.push({ method, body: init.body });
      if (method === 'GET') return new Response(null, { status: 404 });
      return new Response(JSON.stringify({
        name: 'orchestra',
        owner: { login: 'orchestra-agent' },
        html_url: 'https://forgejo.example/orchestra-agent/orchestra',
      }), { status: 201, headers: { 'content-type': 'application/json' } });
    }));

    await ensureProjectRepository({ ...project, repositoryOwner: null, repositoryUrl: null });

    const create = requests.find((request) => request.method === 'POST');
    expect(JSON.parse(String(create?.body))).toMatchObject({ private: false, auto_init: true });
  });

  it('publishes an existing private repository when FORGEJO_REPO_PRIVATE is false', async () => {
    const requests: Array<{ method?: string; url: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (method === 'GET') {
        return new Response(JSON.stringify({
          name: 'orchestra',
          owner: { login: 'orchestra-agent' },
          html_url: 'https://forgejo.example/orchestra-agent/orchestra',
          private: true,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        name: 'orchestra',
        owner: { login: 'orchestra-agent' },
        html_url: 'https://forgejo.example/orchestra-agent/orchestra',
        private: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await ensureProjectRepository({ ...project, repositoryOwner: null, repositoryUrl: null, repositoryName: 'orchestra' });

    expect(requests.some((request) => request.method === 'PATCH' && request.body?.includes('"private":false'))).toBe(true);
  });
});
