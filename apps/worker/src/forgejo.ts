import type { AgentRole, Project, ProjectArtifact, ProjectIteration } from '@orchestra/contracts';
import { createHash } from 'node:crypto';

interface ForgejoRepository { name: string; owner: { login: string }; html_url: string; private?: boolean }
interface ForgejoIssue { number: number; html_url: string }
interface ForgejoPull {
  number: number;
  html_url: string;
  merged?: boolean;
  head?: { sha?: string };
}
interface ForgejoLabel { id: number; name: string; color: string }
interface ForgejoProject { id: number; title: string }
interface ForgejoContent { sha: string; content?: string; encoding?: string }
interface ForgejoIssueComment { body?: string }

function forgejoConfig() {
  return {
    internalUrl: process.env.FORGEJO_URL ?? 'http://localhost:3001',
    publicUrl: process.env.FORGEJO_PUBLIC_URL ?? 'http://localhost:3001',
    username: process.env.FORGEJO_ADMIN_USER ?? 'orchestra-agent',
    password: process.env.FORGEJO_ADMIN_PASSWORD ?? 'orchestra-local-admin-change-me',
    // Local Forgejo has registration disabled; private repos 404 for anyone not
    // signed in as the agent, which makes Orchestra's repository links look empty.
    privateRepos: (process.env.FORGEJO_REPO_PRIVATE ?? 'false').toLowerCase() === 'true',
  };
}

interface ForgejoHttpResult<T> {
  status: number;
  data?: T;
}

async function rawRequestWithStatus<T>(
  path: string,
  init: RequestInit = {},
  allow: number[] = [],
): Promise<ForgejoHttpResult<T>> {
  const config = forgejoConfig();
  const response = await fetch(new URL(path, config.internalUrl), {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (allow.includes(response.status)) return { status: response.status };
  const body = await response.text();
  if (!response.ok) throw new Error(`Forgejo ${init.method ?? 'GET'} ${path} returned ${response.status}: ${body.slice(0, 300)}`);
  if (response.status === 204 || !body.trim()) return { status: response.status };
  return { status: response.status, data: JSON.parse(body) as T };
}

async function rawRequest<T>(path: string, init: RequestInit = {}, allow: number[] = []): Promise<T | undefined> {
  return (await rawRequestWithStatus<T>(path, init, allow)).data;
}

async function request<T>(path: string, init: RequestInit = {}, allow: number[] = []): Promise<T | undefined> {
  return rawRequest<T>(`/api/v1${path}`, init, allow);
}

async function requestWithStatus<T>(
  path: string,
  init: RequestInit = {},
  allow: number[] = [],
): Promise<ForgejoHttpResult<T>> {
  return rawRequestWithStatus<T>(`/api/v1${path}`, init, allow);
}

export type ForgejoLifecyclePermission =
  | 'pull_requests:comment'
  | 'pull_requests:merge'
  | 'issues:close'
  | 'labels:write'
  | 'projects:write'
  | 'releases:write'
  | 'packages:write'
  | 'wiki:write';

export type ForgejoLifecycleCapabilityName =
  | 'issue_pull_request_links'
  | 'labels'
  | 'projects'
  | 'releases'
  | 'packages'
  | 'wiki';

export interface ForgejoLifecycleCapability {
  name: ForgejoLifecycleCapabilityName;
  supported: true;
  enabled: boolean;
  permission: ForgejoLifecyclePermission;
  description: string;
}

export interface ForgejoTransport {
  request<T>(path: string, init?: RequestInit, allow?: readonly number[]): Promise<T | undefined>;
}

export interface ForgejoLifecycleStep {
  capability: ForgejoLifecycleCapabilityName;
  action: string;
  status: 'completed' | 'skipped' | 'failed';
  detail: string;
}

export interface ForgejoIterationLifecycleResult {
  decision: 'approved' | 'changes_requested';
  merged: boolean;
  issueClosed: boolean;
  steps: ForgejoLifecycleStep[];
}

export interface ApprovedIterationAuthorization {
  decision: 'approved';
  approvedBy: 'human' | 'gate';
  /** Immutable preview/approval revision that the PR head must still match. */
  expectedRevision?: string;
}

export interface ForgejoLifecycleAdapterOptions {
  transport?: ForgejoTransport;
  permissions?: ReadonlySet<ForgejoLifecyclePermission>;
}

const httpTransport: ForgejoTransport = {
  request: <T>(path: string, init: RequestInit = {}, allow: readonly number[] = []) =>
    rawRequest<T>(path, init, [...allow]),
};

const capabilityDefinitions: readonly Omit<ForgejoLifecycleCapability, 'enabled'>[] = [
  {
    name: 'issue_pull_request_links',
    supported: true,
    permission: 'pull_requests:merge',
    description: 'Link iteration issues to pull requests, merge approved pulls into main, and close delivered issues.',
  },
  {
    name: 'labels',
    supported: true,
    permission: 'labels:write',
    description: 'Create lifecycle labels and apply them to iteration issues.',
  },
  {
    name: 'projects',
    supported: true,
    permission: 'projects:write',
    description: 'Create or reuse a repository project for iteration tracking.',
  },
  {
    name: 'releases',
    supported: true,
    permission: 'releases:write',
    description: 'Publish an approved iteration as a Forgejo release targeting main.',
  },
  {
    name: 'packages',
    supported: true,
    permission: 'packages:write',
    description: 'Upload an iteration review manifest to Forgejo\'s generic package registry.',
  },
  {
    name: 'wiki',
    supported: true,
    permission: 'wiki:write',
    description: 'Create or update a human-readable Iteration-N wiki page.',
  },
] as const;

const agentRoles: readonly AgentRole[] = [
  'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
  'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation',
];

const lifecycleLabels = [
  { name: 'iteration/in-progress', color: 'd29922', description: 'Agents are actively revising this iteration' },
  { name: 'iteration/changes-requested', color: 'cf222e', description: 'Human review requested another pass on this iteration' },
  { name: 'iteration/approved', color: '2da44e', description: 'Human-approved and merged Orchestra iteration' },
  { name: 'review/pending', color: '8250df', description: 'Waiting for human iteration review' },
  ...agentRoles.map((role) => ({
    name: `agent/${role}`,
    color: '0969da',
    description: `Work or artifacts produced by the ${role} agent`,
  })),
] as const;

function configuredLifecyclePermissions(): ReadonlySet<ForgejoLifecyclePermission> {
  const configured = process.env.FORGEJO_LIFECYCLE_PERMISSIONS ?? [
    'pull_requests:comment',
    'pull_requests:merge',
    'issues:close',
    'labels:write',
    'projects:write',
    'releases:write',
    'packages:write',
    'wiki:write',
  ].join(',');
  return new Set(configured.split(',').map((permission) => permission.trim()).filter(Boolean) as ForgejoLifecyclePermission[]);
}

function repositoryPath(project: Project): string {
  if (!project.repositoryOwner || !project.repositoryName) throw new Error('Project repository is not connected.');
  // Lifecycle transport calls rawRequest directly, so repository paths must include /api/v1.
  // Package uploads use /api/packages/... and are intentionally outside this helper.
  return `/api/v1/repos/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ForgejoLifecycleAdapter {
  private readonly transport: ForgejoTransport;
  private readonly permissions: ReadonlySet<ForgejoLifecyclePermission>;

  constructor(options: ForgejoLifecycleAdapterOptions = {}) {
    this.transport = options.transport ?? httpTransport;
    this.permissions = options.permissions ?? configuredLifecyclePermissions();
  }

  capabilities(): readonly ForgejoLifecycleCapability[] {
    return capabilityDefinitions.map((capability) => ({
      ...capability,
      enabled: this.permissions.has(capability.permission),
    }));
  }

  async recordReview(project: Project, iteration: ProjectIteration, decision: string, feedback: string): Promise<void> {
    if (!iteration.pullRequestNumber) return;
    this.require('pull_requests:comment');
    await this.transport.request(`${repositoryPath(project)}/issues/${iteration.pullRequestNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `## Human iteration review\n\n**Decision:** ${decision}\n\n${feedback || 'No additional feedback supplied.'}` }),
    });
  }

  async recordReviewStep(
    project: Project,
    iteration: ProjectIteration,
    decision: string,
    feedback: string,
  ): Promise<ForgejoLifecycleStep> {
    return this.step('issue_pull_request_links', 'record_review_comment', 'pull_requests:comment', async () => {
      await this.recordReview(project, iteration, decision, feedback);
      return `Human review was recorded on pull request #${iteration.pullRequestNumber}.`;
    });
  }

  async ensureRepositoryLabels(project: Project): Promise<ForgejoLifecycleStep> {
    return this.step('labels', 'ensure_lifecycle_labels', 'labels:write', async () => {
      await this.ensureLabels(project, lifecycleLabels);
      return `Ensured ${lifecycleLabels.length} lifecycle and role labels.`;
    });
  }

  async applyIssueLabels(
    project: Project,
    issueNumber: number,
    names: readonly string[],
    action = 'apply_issue_labels',
  ): Promise<ForgejoLifecycleStep> {
    return this.step('labels', action, 'labels:write', async () => {
      const definitions = lifecycleLabels.filter((label) => names.includes(label.name));
      const labels = await this.ensureLabels(project, definitions);
      const ids = names.map((name) => labels.get(name)?.id).filter((id): id is number => id !== undefined);
      if (ids.length !== names.length) throw new Error(`Not all requested labels were available: ${names.join(', ')}.`);
      await this.transport.request(`${repositoryPath(project)}/issues/${issueNumber}/labels`, {
        method: 'POST', body: JSON.stringify({ labels: ids }),
      });
      return `Applied ${names.join(', ')} to issue #${issueNumber}.`;
    });
  }

  async finalizeApprovedIteration(
    project: Project,
    iteration: ProjectIteration,
    authorization: ApprovedIterationAuthorization,
  ): Promise<ForgejoIterationLifecycleResult> {
    if (authorization.decision !== 'approved') throw new Error('A pull request can only be merged from an explicit approval.');
    if (!iteration.pullRequestNumber || !iteration.issueNumber) throw new Error('Iteration pull request and issue are required.');

    const steps: ForgejoLifecycleStep[] = [];
    const merge = await this.step('issue_pull_request_links', 'merge_pull_request', 'pull_requests:merge', async () => {
      const pull = await this.transport.request<ForgejoPull>(`${repositoryPath(project)}/pulls/${iteration.pullRequestNumber}`);
      if (authorization.expectedRevision) {
        const actualRevision = pull?.head?.sha;
        if (!actualRevision) {
          throw new Error('Forgejo did not return the pull request head revision; the guarded merge was not attempted.');
        }
        if (actualRevision !== authorization.expectedRevision) {
          throw new Error(`Pull request head is stale for this approval: expected ${authorization.expectedRevision}, found ${actualRevision}.`);
        }
      }
      if (pull?.merged) return `Pull request #${iteration.pullRequestNumber} was already merged into main.`;
      await this.transport.request(`${repositoryPath(project)}/pulls/${iteration.pullRequestNumber}/merge`, {
        method: 'POST',
        body: JSON.stringify({
          Do: 'merge',
          merge_when_checks_succeed: false,
          ...(authorization.expectedRevision ? { head_commit_id: authorization.expectedRevision } : {}),
        }),
      });
      return `Pull request #${iteration.pullRequestNumber} merged into main.`;
    });
    steps.push(merge);

    if (merge.status !== 'completed') {
      return { decision: 'approved', merged: false, issueClosed: false, steps };
    }

    const close = await this.step('issue_pull_request_links', 'close_issue', 'issues:close', async () => {
      await this.transport.request(`${repositoryPath(project)}/issues/${iteration.issueNumber}`, {
        method: 'PATCH', body: JSON.stringify({ state: 'closed' }),
      });
      return `Iteration issue #${iteration.issueNumber} closed.`;
    });
    steps.push(close);

    const label = await this.step('labels', 'label_issue_approved', 'labels:write', async () => {
      const labels = await this.ensureLabels(project, lifecycleLabels.filter((candidate) => candidate.name === 'iteration/approved'));
      const approved = labels.get('iteration/approved');
      if (!approved) throw new Error('Forgejo did not return the approved label.');
      await this.transport.request(`${repositoryPath(project)}/issues/${iteration.issueNumber}/labels`, {
        method: 'POST', body: JSON.stringify({ labels: [approved.id] }),
      });
      return 'Applied iteration/approved to the iteration issue.';
    });
    steps.push(label);

    const projectStep = await this.step('projects', 'ensure_delivery_project', 'projects:write', async () => {
      const projects = await this.transport.request<ForgejoProject[]>(`${repositoryPath(project)}/projects`) ?? [];
      if (!projects.some((candidate) => candidate.title === 'Orchestra delivery')) {
        await this.transport.request(`${repositoryPath(project)}/projects`, {
          method: 'POST',
          body: JSON.stringify({
            title: 'Orchestra delivery',
            description: 'Human and agent iteration lifecycle maintained by Orchestra.',
          }),
        });
      }
      return 'Repository delivery project is available.';
    });
    steps.push(projectStep);

    const release = await this.step('releases', 'publish_release', 'releases:write', async () => {
      const tag = `iteration-${iteration.number}`;
      await this.transport.request(`${repositoryPath(project)}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: 'main',
          name: `Iteration ${iteration.number}`,
          body: `Approved delivery for iteration ${iteration.number}. Pull request #${iteration.pullRequestNumber}; issue #${iteration.issueNumber}.`,
          draft: false,
          prerelease: false,
        }),
      }, [409, 422]);
      return `Release ${tag} published.`;
    });
    steps.push(release);

    const packageStep = await this.step('packages', 'upload_review_package', 'packages:write', async () => {
      const owner = encodeURIComponent(project.repositoryOwner!);
      const packageName = encodeURIComponent(`${project.repositoryName}-iterations`);
      const version = encodeURIComponent(String(iteration.number));
      const filename = encodeURIComponent('review-manifest.json');
      await this.transport.request(`/api/packages/${owner}/generic/${packageName}/${version}/${filename}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          iterationId: iteration.id,
          iterationNumber: iteration.number,
          issueNumber: iteration.issueNumber,
          pullRequestNumber: iteration.pullRequestNumber,
          branch: 'main',
          approvedBy: authorization.approvedBy,
        }),
      }, [409]);
      return 'Generic iteration review package uploaded.';
    });
    steps.push(packageStep);

    const wiki = await this.step('wiki', 'publish_iteration_wiki', 'wiki:write', async () => {
      const title = `Iteration-${iteration.number}`;
      const content = [
        `# Iteration ${iteration.number}`,
        '',
        `**Objective:** ${iteration.objective}`,
        '',
        `- Issue: #${iteration.issueNumber}`,
        `- Pull request: #${iteration.pullRequestNumber}`,
        '- Delivery branch: `main`',
        `- Approved by: ${authorization.approvedBy}`,
      ].join('\n');
      const existing = await this.transport.request(`${repositoryPath(project)}/wiki/page/${encodeURIComponent(title)}`, {}, [404]);
      if (existing) {
        await this.transport.request(`${repositoryPath(project)}/wiki/page/${encodeURIComponent(title)}`, {
          method: 'PATCH', body: JSON.stringify({ title, content, message: `docs: update iteration ${iteration.number} lifecycle` }),
        });
      } else {
        await this.transport.request(`${repositoryPath(project)}/wiki/new`, {
          method: 'POST', body: JSON.stringify({ title, content, message: `docs: publish iteration ${iteration.number} lifecycle` }),
        });
      }
      return `${title} wiki page published.`;
    });
    steps.push(wiki);

    return {
      decision: 'approved',
      merged: true,
      issueClosed: close.status === 'completed',
      steps,
    };
  }

  async changesRequested(project?: Project, iteration?: ProjectIteration): Promise<ForgejoIterationLifecycleResult> {
    const labelStep = project && iteration?.issueNumber
      ? await this.applyIssueLabels(project, iteration.issueNumber, ['iteration/changes-requested'], 'label_changes_requested')
      : undefined;
    return {
      decision: 'changes_requested',
      merged: false,
      issueClosed: false,
      steps: [
        {
          capability: 'issue_pull_request_links',
          action: 'retain_open_pull_request',
          status: 'completed',
          detail: 'Pull request and issue remain open and unmerged while the requested revision proceeds.',
        },
        ...(labelStep ? [labelStep] : []),
      ],
    };
  }

  private async ensureLabels(
    project: Project,
    definitions: readonly { name: string; color: string; description: string }[],
  ): Promise<Map<string, ForgejoLabel>> {
    const existing = await this.transport.request<ForgejoLabel[]>(`${repositoryPath(project)}/labels`) ?? [];
    const labels = new Map(existing.map((label) => [label.name, label]));
    for (const definition of definitions) {
      if (labels.has(definition.name)) continue;
      const created = await this.transport.request<ForgejoLabel>(`${repositoryPath(project)}/labels`, {
        method: 'POST', body: JSON.stringify(definition),
      });
      if (created) labels.set(created.name, created);
    }
    return labels;
  }

  private require(permission: ForgejoLifecyclePermission): void {
    if (!this.permissions.has(permission)) throw new Error(`Forgejo lifecycle permission ${permission} is not enabled.`);
  }

  private async step(
    capability: ForgejoLifecycleCapabilityName,
    action: string,
    permission: ForgejoLifecyclePermission,
    operation: () => Promise<string>,
  ): Promise<ForgejoLifecycleStep> {
    if (!this.permissions.has(permission)) {
      return { capability, action, status: 'skipped', detail: `Permission ${permission} is not enabled.` };
    }
    try {
      return { capability, action, status: 'completed', detail: await operation() };
    } catch (error) {
      return { capability, action, status: 'failed', detail: errorMessage(error) };
    }
  }
}

export function createForgejoLifecycleAdapter(options: ForgejoLifecycleAdapterOptions = {}): ForgejoLifecycleAdapter {
  return new ForgejoLifecycleAdapter(options);
}

export function forgejoLifecycleCapabilities(
  permissions: ReadonlySet<ForgejoLifecyclePermission> = configuredLifecyclePermissions(),
): readonly ForgejoLifecycleCapability[] {
  return new ForgejoLifecycleAdapter({ permissions }).capabilities();
}

export async function ensureProjectLifecycleLabels(
  project: Project,
  adapter = createForgejoLifecycleAdapter(),
): Promise<ForgejoLifecycleStep> {
  return adapter.ensureRepositoryLabels(project);
}

export async function labelIterationStatus(
  project: Project,
  iteration: ProjectIteration,
  status: 'in-progress' | 'changes-requested' | 'approved' | 'review-pending',
  adapter = createForgejoLifecycleAdapter(),
): Promise<ForgejoLifecycleStep | undefined> {
  if (!iteration.issueNumber) return undefined;
  const name = status === 'review-pending' ? 'review/pending' : `iteration/${status}`;
  return adapter.applyIssueLabels(project, iteration.issueNumber, [name], `label_${status}`);
}

export async function labelIterationAgent(
  project: Project,
  iteration: ProjectIteration,
  role: AgentRole,
  adapter = createForgejoLifecycleAdapter(),
): Promise<ForgejoLifecycleStep | undefined> {
  if (!iteration.issueNumber) return undefined;
  return adapter.applyIssueLabels(project, iteration.issueNumber, [`agent/${role}`], `label_agent_${role}`);
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'project';
}

function extensionFor(mimeType: string) {
  if (mimeType === 'text/markdown') return 'md';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'application/yaml') return 'yaml';
  if (mimeType === 'image/svg+xml') return 'svg';
  return 'txt';
}

export type GeneratedSourcePathGrant = 'reserved-ci-workflows:write' | 'sensitive-root-files:write';

const reservedWorkflowTrees = ['.github/workflows', '.forgejo/workflows'] as const;
const sensitiveRootDirectories = ['.aws', '.azure', '.ssh', '.config/gcloud'] as const;

function isSensitiveRootPath(path: string): boolean {
  if (sensitiveRootDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`))) return true;
  const rootEntry = path.split('/', 1)[0]!;
  return /^\.env(?:\..*)?$/u.test(rootEntry)
    || /^(?:credentials?|secrets?|tokens?|auth)(?:\..*)?$/u.test(rootEntry)
    || /^service-account(?:[-_.].*)?$/u.test(rootEntry)
    || /^(?:\.git-credentials|\.npmrc|\.pypirc|\.netrc)$/u.test(rootEntry)
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/u.test(rootEntry)
    || /\.(?:key|pem|p12|pfx)$/u.test(rootEntry);
}

/**
 * Enforces the deny-by-default boundary for model-generated repository files.
 * Invalid or ambiguous paths are never grantable. Reserved automation and
 * credential paths require explicit capabilities that no agent currently has.
 */
export function assertSafeGeneratedSourcePath(
  path: string,
  grants: ReadonlySet<GeneratedSourcePathGrant> = new Set(),
): string {
  if (!path || path !== path.trim()) throw new Error('Generated source paths must be non-empty and cannot have surrounding whitespace.');
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`Generated source path is not a safe repository-relative path: ${path}.`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Generated source path is not a safe repository-relative path: ${path}.`);
  }
  const normalized = segments.join('/');
  const lower = normalized.toLowerCase();
  if (
    reservedWorkflowTrees.some((tree) => lower === tree || lower.startsWith(`${tree}/`))
    && !grants.has('reserved-ci-workflows:write')
  ) {
    throw new Error(`Generated source path requires the reserved-ci-workflows:write grant: ${path}.`);
  }
  if (isSensitiveRootPath(lower) && !grants.has('sensitive-root-files:write')) {
    throw new Error(`Generated source path requires the sensitive-root-files:write grant: ${path}.`);
  }
  return normalized;
}

export async function ensureProjectRepository(project: Project) {
  const config = forgejoConfig();
  const owner = config.username;
  const name = project.repositoryName ?? `${slug(project.name)}-${project.id.slice(0, 8)}`;
  const existing = await request<ForgejoRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {}, [404]);
  const repository = existing ?? await request<ForgejoRepository>('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: project.intent.slice(0, 255),
      private: config.privateRepos,
      auto_init: true,
      default_branch: 'main',
      readme: 'Default',
    }),
  });
  // Existing private repos still 404 anonymously; keep local browse links working.
  if (existing?.private && !config.privateRepos) {
    await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ private: false }),
    });
  }
  return {
    owner: repository!.owner.login,
    name: repository!.name,
    url: `${config.publicUrl}/${repository!.owner.login}/${repository!.name}`,
  };
}

export async function createIterationIssue(project: Project, iteration: ProjectIteration) {
  if (iteration.issueNumber) return { number: iteration.issueNumber };
  const issue = await request<ForgejoIssue>(`/repos/${project.repositoryOwner}/${project.repositoryName}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: `Iteration ${iteration.number}: ${iteration.objective}`,
      body: `## Objective\n\n${iteration.objective}\n\nThis issue is maintained automatically by the Orchestra agent workflow. Artifacts, commits, and the review pull request will link back here.`,
      labels: [],
    }),
  });
  return { number: issue!.number, url: issue!.html_url };
}

export async function addIterationComment(project: Project, iteration: ProjectIteration, body: string) {
  if (!iteration.issueNumber || !project.repositoryOwner || !project.repositoryName) return;
  await request(`/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${iteration.issueNumber}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
}

export async function addIterationCommentOnce(
  project: Project,
  iteration: ProjectIteration,
  body: string,
  operationKey: string,
): Promise<void> {
  if (!iteration.issueNumber || !project.repositoryOwner || !project.repositoryName) return;
  const path = `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${iteration.issueNumber}/comments`;
  const marker = `<!-- orchestra-operation:${createHash('sha256').update(operationKey).digest('hex')} -->`;
  const existing = await request<ForgejoIssueComment[]>(`${path}?limit=50`);
  if (existing?.some((comment) => comment.body?.includes(marker))) return;
  await request(path, {
    method: 'POST',
    body: JSON.stringify({ body: `${body}\n\n${marker}` }),
  });
}

function gitBlobSha(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function forgejoContentMatches(existing: ForgejoContent | undefined, content: string): boolean {
  if (!existing) return false;
  const expected = Buffer.from(content);
  if (existing.content && (existing.encoding === undefined || existing.encoding === 'base64')) {
    if (Buffer.from(existing.content.replaceAll(/\s/gu, ''), 'base64').equals(expected)) return true;
  }
  return existing.sha === gitBlobSha(expected);
}

export async function commitArtifact(project: Project, iteration: ProjectIteration, artifact: ProjectArtifact) {
  if (!project.repositoryOwner || !project.repositoryName) throw new Error('Project repository is not connected.');
  const branch = iteration.branchName ?? `iteration-${iteration.number}-agents`;
  const order = String(artifact.version).padStart(2, '0');
  const filename = `${order}-${artifact.producedBy}-${slug(artifact.name)}.${extensionFor(artifact.mimeType)}`;
  const isGeneratedSource = artifact.type.startsWith('source-file:');
  const requestedSourcePath = isGeneratedSource ? artifact.type.slice('source-file:'.length) : undefined;
  const path = requestedSourcePath !== undefined
    ? assertSafeGeneratedSourcePath(requestedSourcePath)
    : `artifacts/iteration-${String(iteration.number).padStart(2, '0')}/${filename}`;
  await request(`/repos/${project.repositoryOwner}/${project.repositoryName}/branches`, {
    method: 'POST', body: JSON.stringify({ new_branch_name: branch, old_branch_name: 'main' }),
  }, [409, 422]);
  const contentPath = `/repos/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const existing = await request<ForgejoContent>(`${contentPath}?ref=${encodeURIComponent(branch)}`, {}, [404]);
  if (existing && (typeof existing.sha !== 'string' || !existing.sha)) {
    throw new Error(`Forgejo returned existing content without a SHA for ${path} on ${branch}.`);
  }
  const config = forgejoConfig();
  const location = {
    path,
    branch,
    url: `${config.publicUrl}/${project.repositoryOwner}/${project.repositoryName}/src/branch/${branch}/${path}`,
  };
  if (forgejoContentMatches(existing, artifact.content)) return location;
  const write = await requestWithStatus(contentPath, {
    method: existing ? 'PUT' : 'POST',
    body: JSON.stringify({
      branch,
      content: Buffer.from(artifact.content).toString('base64'),
      message: `artifact(${artifact.producedBy}): ${existing ? 'update' : 'add'} ${artifact.name} v${artifact.version}`,
      author: { name: `${artifact.producedBy} agent`, email: `${artifact.producedBy}@orchestra.local` },
      committer: { name: 'Orchestra', email: 'agent@orchestra.local' },
      ...(existing ? { sha: existing.sha } : {}),
    }),
  }, [409, 422]);
  if (write.status === 409 || write.status === 422) {
    const concurrent = await request<ForgejoContent>(`${contentPath}?ref=${encodeURIComponent(branch)}`);
    if (!forgejoContentMatches(concurrent, artifact.content)) {
      throw new Error(`Forgejo reported a concurrent write conflict for ${path} on ${branch}.`);
    }
  }
  return location;
}

export async function createIterationPullRequest(project: Project, iteration: ProjectIteration) {
  if (iteration.pullRequestNumber) return { number: iteration.pullRequestNumber, url: iteration.pullRequestUrl! };
  if (!project.repositoryOwner || !project.repositoryName || !iteration.branchName) throw new Error('Iteration branch is not ready.');
  const pull = await request<ForgejoPull>(`/repos/${project.repositoryOwner}/${project.repositoryName}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      base: 'main',
      head: iteration.branchName,
      title: `Iteration ${iteration.number}: agent delivery package`,
      body: `Reviewable artifacts for iteration ${iteration.number}.\n\nCloses #${iteration.issueNumber ?? ''}`,
    }),
  });
  return { number: pull!.number, url: pull!.html_url };
}

export async function recordPullReview(
  project: Project,
  iteration: ProjectIteration,
  decision: string,
  feedback: string,
  adapter = createForgejoLifecycleAdapter(),
) {
  if (!iteration.pullRequestNumber || !project.repositoryOwner || !project.repositoryName) return;
  await adapter.recordReview(project, iteration, decision, feedback);
}

export async function applyIterationReviewLifecycle(
  project: Project,
  iteration: ProjectIteration,
  decision: 'approved' | 'changes_requested',
  feedback: string,
  adapter = createForgejoLifecycleAdapter(),
  expectedRevision?: string,
): Promise<ForgejoIterationLifecycleResult> {
  const review = await adapter.recordReviewStep(project, iteration, decision, feedback);
  if (decision === 'changes_requested') {
    const result = await adapter.changesRequested(project, iteration);
    return { ...result, steps: [review, ...result.steps] };
  }
  const result = await adapter.finalizeApprovedIteration(project, iteration, {
    decision: 'approved',
    approvedBy: 'human',
    expectedRevision,
  });
  return { ...result, steps: [review, ...result.steps] };
}

export function agentCommitSummary(role: AgentRole, artifact: ProjectArtifact) {
  return `✅ **${role} agent** committed [${artifact.name}](${artifact.repositoryUrl ?? '#'}) v${artifact.version}.`;
}
