import type {
  AgentRole,
  ForgejoIssueAction,
  ForgejoIssueRef,
  ForgejoWorkPackage,
  ItemStatusLabel,
  PackagingCheckResult,
  PackagingPlan,
  Project,
  ProjectArtifact,
  ProjectIteration,
} from '@orchestra/contracts';
import {
  agentAssignmentLabel,
  forgejoAgentUsername,
  ITEM_STATUS_LABELS,
  organismAgentRoles,
  parseAgentAssignmentLabel,
} from '@orchestra/contracts';
import { packagingWorkflowPath, renderPackagingWorkflow } from './packaging-workflow.js';
import { createHash } from 'node:crypto';

export type ForgejoActor = 'admin' | AgentRole;

interface ForgejoRepository { name: string; owner: { login: string }; html_url: string; private?: boolean }
interface ForgejoIssue {
  number: number;
  html_url: string;
  title?: string;
  body?: string;
  state?: string;
  labels?: Array<{ name?: string } | string>;
}
interface ForgejoPull {
  number: number;
  html_url: string;
  merged?: boolean;
  head?: { sha?: string };
}
interface ForgejoLabel { id: number; name: string; color: string }
interface ForgejoProject { id: number; title: string }
interface ForgejoProjectColumn { id: number; title: string; name?: string }
interface ForgejoContent { sha: string; content?: string; encoding?: string }
interface ForgejoIssueComment { body?: string }

export const DELIVERY_PROJECT_TITLE = 'Orchestra delivery';
export const DELIVERY_BOARD_COLUMNS = [
  'Backlog',
  'Ready',
  'In progress',
  'Blocked',
  'Done',
  'Dormant',
] as const;

function forgejoConfig() {
  return {
    internalUrl: process.env.FORGEJO_URL ?? 'http://localhost:3001',
    publicUrl: process.env.FORGEJO_PUBLIC_URL ?? 'http://localhost:3001',
    username: process.env.FORGEJO_ADMIN_USER ?? 'orchestra-agent',
    password: process.env.FORGEJO_ADMIN_PASSWORD ?? 'orchestra-local-admin-change-me',
    agentPassword: process.env.FORGEJO_AGENT_PASSWORD ?? 'orchestra-local-agent-change-me',
    // Local Forgejo has registration disabled; private repos 404 for anyone not
    // signed in as the agent, which makes Orchestra's repository links look empty.
    privateRepos: (process.env.FORGEJO_REPO_PRIVATE ?? 'false').toLowerCase() === 'true',
  };
}

interface ForgejoHttpResult<T> {
  status: number;
  data?: T;
}

function credentialsFor(actor: ForgejoActor = 'admin'): { username: string; password: string } {
  const config = forgejoConfig();
  if (actor === 'admin') return { username: config.username, password: config.password };
  return { username: forgejoAgentUsername(actor), password: config.agentPassword };
}

function authorizationHeader(actor: ForgejoActor = 'admin'): string {
  const credentials = credentialsFor(actor);
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

async function rawRequestWithStatus<T>(
  path: string,
  init: RequestInit = {},
  allow: number[] = [],
  actor: ForgejoActor = 'admin',
): Promise<ForgejoHttpResult<T>> {
  const config = forgejoConfig();
  const response = await fetch(new URL(path, config.internalUrl), {
    ...init,
    headers: {
      authorization: authorizationHeader(actor),
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

async function rawRequest<T>(
  path: string,
  init: RequestInit = {},
  allow: number[] = [],
  actor: ForgejoActor = 'admin',
): Promise<T | undefined> {
  return (await rawRequestWithStatus<T>(path, init, allow, actor)).data;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  allow: number[] = [],
  actor: ForgejoActor = 'admin',
): Promise<T | undefined> {
  return rawRequest<T>(`/api/v1${path}`, init, allow, actor);
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
    rawRequest<T>(path, init, [...allow], 'admin'),
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

const itemStatusLabelDefinitions = ITEM_STATUS_LABELS.map((name) => ({
  name,
  color: name === 'item/done' ? '2da44e'
    : name === 'item/blocked' ? 'cf222e'
      : name === 'item/in-progress' ? 'd29922'
        : name === 'item/split' ? '8250df' : '6e7781',
  description: `Orchestra work-item status ${name}`,
}));

const lifecycleLabels = [
  { name: 'iteration/in-progress', color: 'd29922', description: 'Agents are actively revising this iteration' },
  { name: 'iteration/changes-requested', color: 'cf222e', description: 'Human review requested another pass on this iteration' },
  { name: 'iteration/approved', color: '2da44e', description: 'Human-approved and merged Orchestra iteration' },
  { name: 'review/pending', color: '8250df', description: 'Waiting for human iteration review' },
  ...itemStatusLabelDefinitions,
  ...agentRoles.map((role) => ({
    name: `agent/${role}`,
    color: '0969da',
    description: `Assigned to or worked by the ${role} agent`,
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
      const board = await ensureDeliveryProjectBoard(project, this.transport);
      if (!board.projectId) {
        return 'Forgejo projects REST API is unavailable; delivery board skipped.';
      }
      return board.columnsSupported
        ? `Repository delivery project #${board.projectId} is available with columns.`
        : `Repository delivery project #${board.projectId} is available.`;
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

export async function ensureAgentCollaborators(project: Project): Promise<void> {
  if (!project.repositoryOwner || !project.repositoryName) return;
  for (const role of organismAgentRoles) {
    const username = forgejoAgentUsername(role);
    await request(
      `/repos/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}/collaborators/${encodeURIComponent(username)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ permission: 'write' }),
      },
      [404, 422],
    );
  }
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
  const connected = {
    owner: repository!.owner.login,
    name: repository!.name,
    url: `${config.publicUrl}/${repository!.owner.login}/${repository!.name}`,
  };
  await ensureAgentCollaborators({
    ...project,
    repositoryOwner: connected.owner,
    repositoryName: connected.name,
    repositoryUrl: connected.url,
  });
  return connected;
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

export async function addIterationComment(
  project: Project,
  iteration: ProjectIteration,
  body: string,
  actor: ForgejoActor = 'admin',
) {
  if (!iteration.issueNumber || !project.repositoryOwner || !project.repositoryName) return;
  await addIssueComment(project, iteration.issueNumber, body, actor);
}

/** System-owned packaging workflow commit; agents cannot supply this path. */
export async function commitPackagingWorkflow(
  project: Project,
  iteration: ProjectIteration,
  plan: PackagingPlan,
): Promise<{ path: string; branch: string; url: string }> {
  if (!project.repositoryOwner || !project.repositoryName) throw new Error('Project repository is not connected.');
  const branch = iteration.branchName ?? `iteration-${iteration.number}-agents`;
  const path = assertSafeGeneratedSourcePath(packagingWorkflowPath(), new Set(['reserved-ci-workflows:write']));
  const content = renderPackagingWorkflow(plan);
  await request(`/repos/${project.repositoryOwner}/${project.repositoryName}/branches`, {
    method: 'POST', body: JSON.stringify({ new_branch_name: branch, old_branch_name: 'main' }),
  }, [409, 422]);
  const contentPath = `/repos/${encodeURIComponent(project.repositoryOwner)}/${encodeURIComponent(project.repositoryName)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const existing = await request<ForgejoContent>(`${contentPath}?ref=${encodeURIComponent(branch)}`, {}, [404]);
  if (existing && (typeof existing.sha !== 'string' || !existing.sha)) {
    throw new Error(`Forgejo returned existing content without a SHA for ${path} on ${branch}.`);
  }
  await request(contentPath, {
    method: existing ? 'PUT' : 'POST',
    body: JSON.stringify({
      branch,
      content: Buffer.from(content).toString('base64'),
      message: `system(packaging): ${existing ? 'update' : 'add'} iteration packaging workflow`,
      author: { name: 'Orchestra packaging', email: 'packaging@orchestra.local' },
      committer: { name: 'Orchestra', email: 'agent@orchestra.local' },
      ...(existing ? { sha: existing.sha } : {}),
    }),
  });
  const config = forgejoConfig();
  return {
    path,
    branch,
    url: `${config.publicUrl}/${project.repositoryOwner}/${project.repositoryName}/src/branch/${branch}/${path}`,
  };
}

export async function createPackagingCommitStatuses(
  project: Project,
  revision: string,
  checks: readonly PackagingCheckResult[],
): Promise<void> {
  if (!project.repositoryOwner || !project.repositoryName) return;
  for (const check of checks) {
    const state = check.status === 'passed' ? 'success'
      : check.status === 'skipped' ? 'success'
        : 'failure';
    await request(`/repos/${project.repositoryOwner}/${project.repositoryName}/statuses/${encodeURIComponent(revision)}`, {
      method: 'POST',
      body: JSON.stringify({
        context: `orchestra/packaging/${check.id}`,
        description: check.summary.slice(0, 140),
        state,
      }),
    }, [404, 422]);
  }
}

export async function resolveBranchRevision(
  project: Project,
  branch: string,
): Promise<string> {
  if (!project.repositoryOwner || !project.repositoryName) throw new Error('Project repository is not connected.');
  const ref = await request<{ commit?: { id?: string; sha?: string } }>(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/branches/${encodeURIComponent(branch)}`,
  );
  const sha = ref?.commit?.id ?? ref?.commit?.sha;
  if (!sha || !/^[a-f0-9]{40,64}$/u.test(sha)) {
    throw new Error(`Forgejo branch ${branch} did not return a commit revision.`);
  }
  return sha;
}

export async function addIterationCommentOnce(
  project: Project,
  iteration: ProjectIteration,
  body: string,
  operationKey: string,
  actor: ForgejoActor = 'admin',
): Promise<void> {
  if (!iteration.issueNumber || !project.repositoryOwner || !project.repositoryName) return;
  const path = `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${iteration.issueNumber}/comments`;
  const marker = `<!-- orchestra-operation:${createHash('sha256').update(operationKey).digest('hex')} -->`;
  const existing = await request<ForgejoIssueComment[]>(`${path}?limit=50`, {}, [], actor);
  if (existing?.some((comment) => comment.body?.includes(marker))) return;
  await request(path, {
    method: 'POST',
    body: JSON.stringify({ body: `${body}\n\n${marker}` }),
  }, [], actor);
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

export interface DeliveryProjectBoard {
  /** Null when Forgejo has no repository projects REST API (e.g. v16). */
  projectId: number | null;
  columnsSupported: boolean;
  columns: Record<string, number>;
}

const unsupportedDeliveryBoard = (): DeliveryProjectBoard => ({
  projectId: null,
  columnsSupported: false,
  columns: {},
});

function issueLabelNames(issue: ForgejoIssue): string[] {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
}

function toIssueRef(issue: ForgejoIssue, project: Project): ForgejoIssueRef {
  const config = forgejoConfig();
  return {
    number: issue.number,
    url: issue.html_url
      || `${config.publicUrl}/${project.repositoryOwner}/${project.repositoryName}/issues/${issue.number}`,
    title: issue.title ?? `Issue #${issue.number}`,
    body: issue.body ?? '',
    labels: issueLabelNames(issue),
    state: issue.state === 'closed' ? 'closed' : 'open',
  };
}

async function resolveLabelIds(project: Project, names: readonly string[]): Promise<number[]> {
  const existing = await request<ForgejoLabel[]>(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/labels`,
  ) ?? [];
  const byName = new Map(existing.map((label) => [label.name, label.id]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    await ensureProjectLifecycleLabels(project);
    const refreshed = await request<ForgejoLabel[]>(
      `/repos/${project.repositoryOwner}/${project.repositoryName}/labels`,
    ) ?? [];
    for (const label of refreshed) byName.set(label.name, label.id);
  }
  return names.map((name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`Forgejo label ${name} is not available.`);
    return id;
  });
}

export async function ensureDeliveryProjectBoard(
  project: Project,
  transport?: ForgejoTransport,
): Promise<DeliveryProjectBoard> {
  if (!project.repositoryOwner || !project.repositoryName) throw new Error('Project repository is not connected.');
  const listPath = transport
    ? `${repositoryPath(project)}/projects`
    : `/repos/${project.repositoryOwner}/${project.repositoryName}/projects`;
  const create = async () => {
    if (transport) {
      return transport.request<ForgejoProject>(listPath, {
        method: 'POST',
        body: JSON.stringify({
          title: DELIVERY_PROJECT_TITLE,
          description: 'Human and agent iteration lifecycle maintained by Orchestra.',
        }),
      }, [404, 405]);
    }
    return request<ForgejoProject>(listPath, {
      method: 'POST',
      body: JSON.stringify({
        title: DELIVERY_PROJECT_TITLE,
        description: 'Human and agent iteration lifecycle maintained by Orchestra.',
      }),
    }, [404, 405]);
  };
  // Forgejo v16 ships projects in the UI but has no public /repos/.../projects REST API yet
  // (see forgejo/discussions#466). Treat missing routes as unsupported, not fatal.
  const listed = transport
    ? await transport.request<ForgejoProject[]>(listPath, {}, [404, 405])
    : await request<ForgejoProject[]>(listPath, {}, [404, 405]);
  if (listed === undefined) return unsupportedDeliveryBoard();

  let board = listed.find((candidate) => candidate.title === DELIVERY_PROJECT_TITLE);
  if (!board) board = await create();
  if (!board?.id) return unsupportedDeliveryBoard();

  const columns: Record<string, number> = {};
  let columnsSupported = true;
  try {
    const columnsPath = transport
      ? `${repositoryPath(project)}/projects/${board.id}/columns`
      : `/repos/${project.repositoryOwner}/${project.repositoryName}/projects/${board.id}/columns`;
    const existing = transport
      ? await transport.request<ForgejoProjectColumn[]>(columnsPath, {}, [404, 405]) ?? []
      : await request<ForgejoProjectColumn[]>(columnsPath, {}, [404, 405]) ?? [];
    if (existing.length === 0 && !(await probeColumnsSupported(project, board.id, transport))) {
      columnsSupported = false;
    } else {
      const byTitle = new Map(existing.map((column) => [column.title || column.name || '', column.id]));
      for (const title of DELIVERY_BOARD_COLUMNS) {
        let id = byTitle.get(title);
        if (!id) {
          const created = transport
            ? await transport.request<ForgejoProjectColumn>(columnsPath, {
              method: 'POST',
              body: JSON.stringify({ title, name: title }),
            }, [404, 405])
            : await request<ForgejoProjectColumn>(columnsPath, {
              method: 'POST',
              body: JSON.stringify({ title, name: title }),
            }, [404, 405]);
          if (!created?.id) {
            columnsSupported = false;
            break;
          }
          id = created.id;
        }
        columns[title] = id;
      }
    }
  } catch {
    columnsSupported = false;
  }

  return { projectId: board.id, columnsSupported, columns };
}

async function probeColumnsSupported(
  project: Project,
  projectId: number,
  transport?: ForgejoTransport,
): Promise<boolean> {
  const path = transport
    ? `${repositoryPath(project)}/projects/${projectId}/columns`
    : `/repos/${project.repositoryOwner}/${project.repositoryName}/projects/${projectId}/columns`;
  try {
    const listed = transport
      ? await transport.request<ForgejoProjectColumn[]>(path, {}, [404, 405])
      : await request<ForgejoProjectColumn[]>(path, {}, [404, 405]);
    return Array.isArray(listed);
  } catch {
    return false;
  }
}

export async function placeIssueOnBoardColumn(
  project: Project,
  board: DeliveryProjectBoard,
  issueNumber: number,
  columnTitle: (typeof DELIVERY_BOARD_COLUMNS)[number],
): Promise<boolean> {
  if (!board.projectId || !board.columnsSupported) return false;
  const columnId = board.columns[columnTitle];
  if (!columnId || !project.repositoryOwner || !project.repositoryName) return false;
  const paths = [
    `/repos/${project.repositoryOwner}/${project.repositoryName}/projects/columns/${columnId}/issues/${issueNumber}`,
    `/repos/${project.repositoryOwner}/${project.repositoryName}/projects/${board.projectId}/columns/${columnId}/issues/${issueNumber}`,
  ];
  for (const path of paths) {
    try {
      await request(path, { method: 'POST', body: JSON.stringify({}) }, [404, 405, 409, 422]);
      return true;
    } catch {
      // try next shape
    }
  }
  return false;
}

export async function createWorkIssue(
  project: Project,
  input: {
    title: string;
    body: string;
    assigneeRoles: readonly AgentRole[];
    status?: ItemStatusLabel;
  },
  actor: ForgejoActor = 'manager',
): Promise<ForgejoIssueRef> {
  if (!project.repositoryOwner || !project.repositoryName) throw new Error('Project repository is not connected.');
  const labels = [
    ...(input.status ? [input.status] : ['item/backlog']),
    ...input.assigneeRoles.map((role) => agentAssignmentLabel(role)),
  ];
  const labelIds = await resolveLabelIds(project, labels);
  const issue = await request<ForgejoIssue>(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        labels: labelIds,
      }),
    },
    [],
    actor,
  );
  if (!issue) throw new Error('Forgejo did not return the created work issue.');
  return toIssueRef(issue, project);
}

export async function addIssueComment(
  project: Project,
  issueNumber: number,
  body: string,
  actor: ForgejoActor = 'admin',
): Promise<void> {
  if (!project.repositoryOwner || !project.repositoryName) return;
  await request(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${issueNumber}/comments`,
    { method: 'POST', body: JSON.stringify({ body }) },
    [],
    actor,
  );
}

export async function editIssue(
  project: Project,
  issueNumber: number,
  patch: { title?: string; body?: string; state?: 'open' | 'closed' },
  actor: ForgejoActor = 'admin',
): Promise<void> {
  if (!project.repositoryOwner || !project.repositoryName) return;
  await request(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${issueNumber}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    [],
    actor,
  );
}

export async function addIssueLabels(
  project: Project,
  issueNumber: number,
  labels: readonly string[],
  actor: ForgejoActor = 'admin',
): Promise<void> {
  if (!project.repositoryOwner || !project.repositoryName || labels.length === 0) return;
  const labelIds = await resolveLabelIds(project, labels);
  await request(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${issueNumber}/labels`,
    { method: 'POST', body: JSON.stringify({ labels: labelIds }) },
    [],
    actor,
  );
}

export async function removeIssueLabels(
  project: Project,
  issueNumber: number,
  labels: readonly string[],
  actor: ForgejoActor = 'admin',
): Promise<void> {
  if (!project.repositoryOwner || !project.repositoryName) return;
  for (const name of labels) {
    const ids = await resolveLabelIds(project, [name]);
    await request(
      `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${issueNumber}/labels/${ids[0]}`,
      { method: 'DELETE' },
      [404],
      actor,
    );
  }
}

export async function getIssue(project: Project, issueNumber: number): Promise<ForgejoIssueRef | undefined> {
  if (!project.repositoryOwner || !project.repositoryName) return undefined;
  const issue = await request<ForgejoIssue>(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues/${issueNumber}`,
    {},
    [404],
  );
  return issue ? toIssueRef(issue, project) : undefined;
}

export async function listOpenIssuesForAgent(project: Project, role: AgentRole): Promise<ForgejoIssueRef[]> {
  if (!project.repositoryOwner || !project.repositoryName) return [];
  const label = agentAssignmentLabel(role);
  const issues = await request<ForgejoIssue[]>(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues?state=open&labels=${encodeURIComponent(label)}&type=issues&limit=50`,
  ) ?? [];
  return issues.map((issue) => toIssueRef(issue, project));
}

export async function listOpenWorkIssues(project: Project): Promise<ForgejoIssueRef[]> {
  if (!project.repositoryOwner || !project.repositoryName) return [];
  const issues = await request<ForgejoIssue[]>(
    `/repos/${project.repositoryOwner}/${project.repositoryName}/issues?state=open&type=issues&limit=50`,
  ) ?? [];
  return issues
    .filter((issue) => issueLabelNames(issue).some((name) => name.startsWith('agent/') || name.startsWith('item/')))
    .map((issue) => toIssueRef(issue, project));
}

export async function setIssueItemStatus(
  project: Project,
  issueNumber: number,
  status: ItemStatusLabel,
  actor: ForgejoActor = 'admin',
): Promise<void> {
  const issue = await getIssue(project, issueNumber);
  if (!issue) return;
  const current = issue.labels.filter((label) => label.startsWith('item/'));
  const toRemove = current.filter((label) => label !== status);
  if (toRemove.length > 0) await removeIssueLabels(project, issueNumber, toRemove, actor);
  if (!issue.labels.includes(status)) await addIssueLabels(project, issueNumber, [status], actor);
}

export async function claimAgentIssues(
  project: Project,
  role: AgentRole,
  issues: readonly ForgejoIssueRef[],
): Promise<void> {
  const assignment = agentAssignmentLabel(role);
  for (const issue of issues) {
    if (!issue.labels.includes(assignment)) {
      await addIssueLabels(project, issue.number, [assignment], role);
    }
    await setIssueItemStatus(project, issue.number, 'item/in-progress', role);
    await addIssueComment(
      project,
      issue.number,
      `🟠 Started work on this issue.`,
      role,
    );
  }
}

export async function releaseAgentFromIssue(
  project: Project,
  role: AgentRole,
  issueNumber: number,
  comment?: string,
): Promise<void> {
  if (comment) await addIssueComment(project, issueNumber, comment, role);
  await removeIssueLabels(project, issueNumber, [agentAssignmentLabel(role)], role);
  const issue = await getIssue(project, issueNumber);
  if (!issue) return;
  const remainingAgents = issue.labels.filter((label) => label.startsWith('agent/'));
  if (remainingAgents.length === 0) {
    await setIssueItemStatus(project, issueNumber, 'item/done', role);
  }
}

export interface CreatedForgejoWorkIssue {
  number: number;
  title: string;
  key?: string;
  parentIssueNumber?: number;
}

export interface AppliedForgejoIssueActions {
  createdIssues: CreatedForgejoWorkIssue[];
  calledRoles: AgentRole[];
  completedIssueNumbers: number[];
}

function assertAssignableRoles(roles: readonly AgentRole[]): void {
  for (const role of roles) {
    if (role === 'deployment' || role === 'validation') {
      throw new Error(`Cannot assign Forgejo work to ${role} without release authorization.`);
    }
  }
}

export async function materializeWorkPackages(
  project: Project,
  iteration: ProjectIteration,
  packages: readonly ForgejoWorkPackage[],
  board?: DeliveryProjectBoard,
): Promise<Array<ForgejoIssueRef & { key: string }>> {
  const created: Array<ForgejoIssueRef & { key: string }> = [];
  const keyToNumber = new Map<string, number>();
  for (const pkg of packages) {
    assertAssignableRoles(pkg.assigneeRoles);
    let body = pkg.body;
    if (pkg.parentKey && keyToNumber.has(pkg.parentKey)) {
      body = `${body}\n\nParent work package: #${keyToNumber.get(pkg.parentKey)}`;
    }
    if (iteration.issueNumber) {
      body = `${body}\n\nIteration umbrella: #${iteration.issueNumber}`;
    }
    const issue = await createWorkIssue(project, {
      title: pkg.title,
      body,
      assigneeRoles: pkg.assigneeRoles,
      status: 'item/ready',
    }, 'manager');
    keyToNumber.set(pkg.key, issue.number);
    if (board) await placeIssueOnBoardColumn(project, board, issue.number, 'Ready');
    created.push({ ...issue, key: pkg.key });
  }
  return created;
}

export async function refreshUmbrellaWorkChecklist(
  project: Project,
  iteration: ProjectIteration,
  issues: ReadonlyArray<{ number: number; title: string; key?: string }>,
  actor: ForgejoActor = 'manager',
): Promise<void> {
  if (!iteration.issueNumber || issues.length === 0) return;
  const checklist = issues.map((issue) => `- [ ] #${issue.number} ${issue.title}${issue.key ? ` (\`${issue.key}\`)` : ''}`).join('\n');
  const current = await getIssue(project, iteration.issueNumber);
  const base = current?.body?.split('\n## Work packages')[0]?.trim()
    || `## Objective\n\n${iteration.objective}\n\nThis issue is maintained automatically by the Orchestra agent workflow.`;
  await editIssue(project, iteration.issueNumber, {
    body: `${base}\n\n## Work packages\n\n${checklist}`,
  }, actor);
}

export async function applyForgejoIssueActions(
  project: Project,
  iteration: ProjectIteration,
  actingRole: AgentRole,
  actions: readonly ForgejoIssueAction[],
  board?: DeliveryProjectBoard,
): Promise<AppliedForgejoIssueActions> {
  const createdIssues: CreatedForgejoWorkIssue[] = [];
  const calledRoles = new Set<AgentRole>();
  const completedIssueNumbers: number[] = [];

  for (const action of actions) {
    if (action.type === 'comment') {
      await addIssueComment(project, action.issueNumber, action.body, actingRole);
      continue;
    }
    if (action.type === 'edit') {
      await editIssue(project, action.issueNumber, {
        ...(action.title ? { title: action.title } : {}),
        ...(action.body ? { body: action.body } : {}),
      }, actingRole);
      continue;
    }
    if (action.type === 'addLabels') {
      await addIssueLabels(project, action.issueNumber, action.labels, actingRole);
      for (const label of action.labels) {
        const role = parseAgentAssignmentLabel(label);
        if (role && role !== actingRole) {
          calledRoles.add(role);
          await addIssueComment(
            project,
            action.issueNumber,
            `Called **${role}** onto this issue via \`${label}\`.`,
            actingRole,
          );
        }
      }
      continue;
    }
    if (action.type === 'removeLabels') {
      await removeIssueLabels(project, action.issueNumber, action.labels, actingRole);
      continue;
    }
    if (action.type === 'completeIssue') {
      await releaseAgentFromIssue(
        project,
        actingRole,
        action.issueNumber,
        action.comment
          ? action.comment
          : 'Finished contribution on this issue.',
      );
      completedIssueNumbers.push(action.issueNumber);
      continue;
    }
    if (action.type === 'createIssue') {
      assertAssignableRoles(action.assigneeRoles);
      let body = action.body;
      if (action.parentIssueNumber) {
        body = `${body}\n\nSplit from #${action.parentIssueNumber}`;
        await setIssueItemStatus(project, action.parentIssueNumber, 'item/split', actingRole);
      }
      if (iteration.issueNumber) body = `${body}\n\nIteration umbrella: #${iteration.issueNumber}`;
      const issue = await createWorkIssue(project, {
        title: action.title,
        body,
        assigneeRoles: action.assigneeRoles,
        status: 'item/ready',
      }, actingRole);
      createdIssues.push({
        number: issue.number,
        title: issue.title,
        key: action.key,
        ...(action.parentIssueNumber ? { parentIssueNumber: action.parentIssueNumber } : {}),
      });
      for (const role of action.assigneeRoles) {
        if (role !== actingRole) calledRoles.add(role);
      }
      if (action.parentIssueNumber) {
        await addIssueComment(
          project,
          action.parentIssueNumber,
          `Split out #${issue.number}: ${action.title}`,
          actingRole,
        );
      }
      if (board) await placeIssueOnBoardColumn(project, board, issue.number, 'Ready');
      await addIssueComment(
        project,
        issue.number,
        `Created${action.parentIssueNumber ? ` from #${action.parentIssueNumber}` : ''}.`,
        actingRole,
      );
    }
  }

  return {
    createdIssues,
    calledRoles: [...calledRoles],
    completedIssueNumbers,
  };
}

export function defaultManagerWorkPackages(
  project: Project,
  iteration: ProjectIteration,
): ForgejoWorkPackage[] {
  return [
    {
      key: 'charter-and-scope',
      title: `Iteration ${iteration.number}: charter and initial scope`,
      body: [
        `## Objective`,
        iteration.objective,
        '',
        `## Intent`,
        project.intent,
        '',
        `## Audience`,
        project.audience,
        '',
        `## Success`,
        project.success,
        '',
        'Manager owns the first framing. Product and Requirements collaborate on scope before design roles proceed.',
      ].join('\n'),
      assigneeRoles: ['manager', 'product', 'requirements'],
    },
    {
      key: 'design-baseline',
      title: `Iteration ${iteration.number}: design and architecture baseline`,
      body: [
        'Produce UX journeys, solution baseline, data model, and threat model for the bounded increment.',
        '',
        `Project: ${project.name}`,
        `Iteration objective: ${iteration.objective}`,
      ].join('\n'),
      assigneeRoles: ['ux', 'architecture', 'data', 'security'],
    },
    {
      key: 'plan-build-assure',
      title: `Iteration ${iteration.number}: plan, build, and assure`,
      body: [
        'Planner splits delivery into implementable packages, Builder submits the preview-ready increment, and Test/Reviewer/Gate assure evidence before human review.',
        '',
        `Iteration objective: ${iteration.objective}`,
      ].join('\n'),
      assigneeRoles: ['planner', 'builder', 'test', 'reviewer', 'gate'],
    },
  ];
}
