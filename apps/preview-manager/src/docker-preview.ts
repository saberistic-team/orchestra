import Docker from 'dockerode';
import {
  PREVIEW_CONTAINER_PORT,
  PREVIEW_CONTRACT_VERSION,
  PREVIEW_RUNTIME_CONTRACT,
  type PreviewDeploymentRequest,
  type PreviewDeploymentResult,
} from '@orchestra/contracts';
import { ForgejoSourceClient } from './forgejo-source.js';
import { previewPublicUrl, previewRouteName } from './preview-routing.js';

const PREVIEW_LABEL = 'orchestra.preview';
const PROJECT_LABEL = 'orchestra.preview.project-id';
const ITERATION_LABEL = 'orchestra.preview.iteration-id';
const REVISION_LABEL = 'orchestra.preview.revision';
const CONTEXT_DIGEST_LABEL = 'orchestra.preview.context-digest';
const EXPIRES_LABEL = 'orchestra.preview.expires-at';
const DEFAULT_NETWORK = 'orchestra-preview-runtime';

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dockerStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
}

function safeIdentifier(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 50);
}

function containerPortKey() {
  return `${PREVIEW_CONTAINER_PORT}/tcp`;
}

export function previewContainerOptions(input: {
  image: string;
  name: string;
  network: string;
  routeAlias: string;
  labels: Record<string, string>;
}): Docker.ContainerCreateOptions {
  const port = containerPortKey();
  return {
    name: input.name,
    Image: input.image,
    User: '65532:65532',
    Env: [
      `PORT=${PREVIEW_CONTAINER_PORT}`,
      'HOST=0.0.0.0',
      'NODE_ENV=production',
      'HOME=/tmp',
    ],
    Labels: input.labels,
    ExposedPorts: { [port]: {} },
    NetworkingConfig: {
      EndpointsConfig: { [input.network]: { Aliases: [input.routeAlias] } },
    },
    HostConfig: {
      NetworkMode: input.network,
      AutoRemove: false,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,mode=1777' },
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      ShmSize: 64 * 1024 * 1024,
      Init: true,
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '1', compress: 'false' } },
    },
  };
}

async function followBuild(docker: Docker, stream: NodeJS.ReadableStream) {
  return new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error: Error | null, output: Array<{ error?: string; errorDetail?: { message?: string } }>) => {
      if (error) return reject(error);
      const embedded = output?.find((entry) => entry.errorDetail?.message || entry.error);
      if (embedded) return reject(new Error((embedded.errorDetail?.message ?? embedded.error ?? 'Docker build failed.').slice(0, 2_000)));
      resolve();
    });
  });
}

async function removeContainer(docker: Docker, id: string) {
  try {
    await docker.getContainer(id).remove({ force: true, v: true });
  } catch (error) {
    if (dockerStatus(error) !== 404) throw error;
  }
}

function urls(name: string, imageDigest: string) {
  const internalUrl = new URL(`http://${name}:${PREVIEW_CONTAINER_PORT}/`);
  return { publicUrl: previewPublicUrl(name, imageDigest), internalUrl: internalUrl.toString() };
}

async function inspectReadyContainer(docker: Docker, id: string, network: string) {
  const inspected = await docker.getContainer(id).inspect();
  if (!inspected.State.Running || inspected.State.Health?.Status !== 'healthy') return undefined;
  if (!/^sha256:[0-9a-f]{64}$/u.test(inspected.Image)) return undefined;
  const name = inspected.Name.replace(/^\//u, '');
  const routeAlias = previewRouteName(name, inspected.Image);
  if (!inspected.NetworkSettings.Networks[network]?.Aliases?.includes(routeAlias)) return undefined;
  return { inspected, ...urls(name, inspected.Image) };
}

async function waitForHealthyContainer(docker: Docker, id: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last = 'starting';
  while (Date.now() < deadline) {
    const inspected = await docker.getContainer(id).inspect();
    if (!inspected.State.Running) {
      throw new Error(`Preview container stopped with exit code ${inspected.State.ExitCode}.`);
    }
    last = inspected.State.Health?.Status ?? 'missing';
    if (last === 'unhealthy') {
      const detail = inspected.State.Health?.Log.at(-1)?.Output?.trim().slice(0, 1_000);
      throw new Error(`Preview container health check failed.${detail ? ` ${detail}` : ''}`);
    }
    if (last === 'healthy') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Preview container did not become healthy before the timeout (last status: ${last}).`);
}

export class DockerPreviewManager {
  private readonly docker: Docker;
  private readonly source: ForgejoSourceClient;
  private readonly network: string;
  private readonly deployments = new Map<string, Promise<PreviewDeploymentResult>>();

  constructor(options: { docker?: Docker; source?: ForgejoSourceClient; network?: string } = {}) {
    this.docker = options.docker ?? new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock' });
    this.source = options.source ?? new ForgejoSourceClient();
    this.network = options.network ?? process.env.PREVIEW_RUNTIME_NETWORK ?? DEFAULT_NETWORK;
  }

  async ready() {
    await this.docker.ping();
  }

  async reconcileGateway() {
    await this.ensureNetwork();
    await this.ensureGatewayConnected();
  }

  async deploy(input: PreviewDeploymentRequest): Promise<PreviewDeploymentResult> {
    const key = `${input.projectId}:${input.iterationId}`;
    const existing = this.deployments.get(key);
    if (existing) return existing;
    const operation = this.deployOnce(input).finally(() => this.deployments.delete(key));
    this.deployments.set(key, operation);
    return operation;
  }

  private async ensureNetwork() {
    try {
      const inspected = await this.docker.getNetwork(this.network).inspect();
      if (!inspected.Internal) throw new Error(`Preview network ${this.network} must be internal.`);
    } catch (error) {
      if (dockerStatus(error) !== 404) throw error;
      await this.docker.createNetwork({
        Name: this.network,
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        CheckDuplicate: true,
        Labels: { [PREVIEW_LABEL]: 'true' },
      });
    }
  }

  private async ensureGatewayConnected() {
    const configuredName = process.env.PREVIEW_GATEWAY_CONTAINER_NAME?.trim();
    let containerId: string;
    if (configuredName) {
      const inspected = await this.docker.getContainer(configuredName).inspect();
      if (!inspected.State.Running) throw new Error('Preview gateway container is not running.');
      containerId = inspected.Id;
    } else {
      const candidates = await this.docker.listContainers({
        all: false,
        filters: { label: ['com.docker.compose.service=preview-gateway'] },
      });
      if (candidates.length !== 1) {
        throw new Error(`Expected exactly one running preview gateway container; found ${candidates.length}.`);
      }
      containerId = candidates[0]!.Id;
    }
    const before = await this.docker.getContainer(containerId).inspect();
    const endpoint = before.NetworkSettings.Networks[this.network];
    if (endpoint?.Aliases?.includes('preview-gateway')) return;
    if (endpoint) {
      await this.docker.getNetwork(this.network).disconnect({ Container: containerId, Force: true });
    }
    let connectionError: unknown;
    try {
      await this.docker.getNetwork(this.network).connect({
        Container: containerId,
        EndpointConfig: { Aliases: ['preview-gateway'] },
      });
    } catch (error) {
      connectionError = error;
    }
    const attached = await this.docker.getContainer(containerId).inspect();
    if (!attached.NetworkSettings.Networks[this.network]?.Aliases?.includes('preview-gateway')) {
      if (connectionError) throw connectionError;
      throw new Error('Preview gateway could not join the isolated runtime network.');
    }
  }

  async cleanupExpired() {
    await this.reconcileGateway();
    const now = Date.now();
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`${PREVIEW_LABEL}=true`] } });
    for (const container of containers) {
      const expires = Date.parse(container.Labels[EXPIRES_LABEL] ?? '');
      if (Number.isFinite(expires) && expires <= now) await removeContainer(this.docker, container.Id);
    }
    const remaining = (await this.docker.listContainers({ all: true, filters: { label: [`${PREVIEW_LABEL}=true`] } }))
      .sort((left, right) => right.Created - left.Created);
    const maximum = Math.floor(positiveNumber(process.env.PREVIEW_MAX_ACTIVE, 8));
    for (const container of remaining.slice(maximum)) await removeContainer(this.docker, container.Id);
    const images = await this.docker.listImages({ all: true, filters: { label: [`${PREVIEW_LABEL}=true`] } });
    for (const image of images) {
      const expires = Date.parse(image.Labels?.[EXPIRES_LABEL] ?? '');
      if (Number.isFinite(expires) && expires <= now) {
        await this.docker.getImage(image.Id).remove({ force: true }).catch(() => undefined);
      }
    }
  }

  private async deployOnce(input: PreviewDeploymentRequest): Promise<PreviewDeploymentResult> {
    await this.cleanupExpired();
    const source = await this.source.fetch(input.repository);
    const name = safeIdentifier(`orchestra-preview-${input.projectId.slice(0, 8)}-${input.iterationNumber}-${source.revision.slice(0, 12)}`);
    const image = safeIdentifier(`orchestra-preview-${input.projectId.slice(0, 12)}`) + `:${source.revision.slice(0, 12)}`;
    const ttlMs = positiveNumber(process.env.PREVIEW_TTL_MS, 24 * 60 * 60 * 1_000);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const labels = {
      [PREVIEW_LABEL]: 'true',
      [PROJECT_LABEL]: input.projectId,
      [ITERATION_LABEL]: input.iterationId,
      [REVISION_LABEL]: source.revision,
      [CONTEXT_DIGEST_LABEL]: source.contextDigest,
      [EXPIRES_LABEL]: expiresAt,
    };

    const candidates = await this.docker.listContainers({
      all: true,
      filters: { label: [`${ITERATION_LABEL}=${input.iterationId}`, `${REVISION_LABEL}=${source.revision}`] },
    });
    for (const candidate of candidates) {
      const reusable = await inspectReadyContainer(this.docker, candidate.Id, this.network).catch(() => undefined);
      if (!reusable) continue;
      const digest = reusable.inspected.Image;
      if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) continue;
      return {
        contractVersion: PREVIEW_CONTRACT_VERSION,
        title: `Iteration ${input.iterationNumber} local Docker preview`,
        publicUrl: reusable.publicUrl,
        internalUrl: reusable.internalUrl,
        revision: source.revision,
        imageDigest: digest,
        expiresAt: candidate.Labels[EXPIRES_LABEL] ?? expiresAt,
        source: 'managed',
        runtime: PREVIEW_RUNTIME_CONTRACT,
      };
    }

    await removeContainer(this.docker, name);
    const buildTimeout = positiveNumber(process.env.PREVIEW_BUILD_TIMEOUT_MS, 10 * 60 * 1_000);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Preview image build timed out.')), buildTimeout);
    try {
      // dockerode supports Buffer build contexts at runtime (and sends Content-Length),
      // although its public overload currently omits Buffer from the input union.
      const stream = await this.docker.buildImage(source.context as unknown as NodeJS.ReadableStream, {
        t: image,
        dockerfile: 'Dockerfile',
        version: '2',
        pull: true,
        rm: true,
        forcerm: true,
        memory: 2 * 1024 * 1024 * 1024,
        memswap: 2 * 1024 * 1024 * 1024,
        shmsize: 128 * 1024 * 1024,
        networkmode: process.env.PREVIEW_BUILD_NETWORK_MODE === 'none' ? 'none' : 'default',
        labels,
        abortSignal: abort.signal,
      });
      await followBuild(this.docker, stream);
    } finally {
      clearTimeout(timer);
    }

    const imageInspection = await this.docker.getImage(image).inspect();
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageInspection.Id)) throw new Error('Docker returned no immutable preview image digest.');
    const exposed = Object.keys(imageInspection.Config.ExposedPorts ?? {});
    if (exposed.length !== 1 || exposed[0] !== containerPortKey()) {
      throw new Error(`Preview image must expose only ${containerPortKey()}.`);
    }
    const healthTest = imageInspection.Config.Healthcheck?.Test ?? [];
    if (healthTest.length === 0 || healthTest[0] === 'NONE') throw new Error('Preview image has no active Docker health check.');
    if (Object.keys(imageInspection.Config.Volumes ?? {}).length > 0) {
      throw new Error('Preview images cannot declare writable Docker volumes.');
    }

    const container = await this.docker.createContainer(previewContainerOptions({
      image,
      name,
      network: this.network,
      routeAlias: previewRouteName(name, imageInspection.Id),
      labels,
    }));
    try {
      await container.start();
      const deploymentUrls = urls(name, imageInspection.Id);
      await waitForHealthyContainer(
        this.docker,
        container.id,
        positiveNumber(process.env.PREVIEW_HEALTH_TIMEOUT_MS, 90_000),
      );
      return {
        contractVersion: PREVIEW_CONTRACT_VERSION,
        title: `Iteration ${input.iterationNumber} local Docker preview`,
        ...deploymentUrls,
        revision: source.revision,
        imageDigest: imageInspection.Id,
        expiresAt,
        source: 'managed',
        runtime: PREVIEW_RUNTIME_CONTRACT,
      };
    } catch (error) {
      const logs = await container.logs({ stdout: true, stderr: true, tail: 40 }).catch(() => Buffer.alloc(0));
      await removeContainer(this.docker, container.id).catch(() => undefined);
      const suffix = logs.length > 0 ? ` Logs: ${logs.toString('utf8').slice(-2_000)}` : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    }
  }
}
