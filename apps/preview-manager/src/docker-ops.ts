import Docker from 'dockerode';
import { PREVIEW_CONTAINER_PORT, PREVIEW_HEALTH_PATH } from '@orchestra/contracts';

export function dockerStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : undefined;
}

export function safeDockerIdentifier(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 50);
}

export function previewImageTag(projectId: string, revision: string) {
  return `${safeDockerIdentifier(`orchestra-preview-${projectId.slice(0, 12)}`)}:${revision.slice(0, 12)}`;
}

export async function followBuildProgress(docker: Docker, stream: NodeJS.ReadableStream) {
  return new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error: Error | null, output: Array<{ error?: string; errorDetail?: { message?: string } }>) => {
      if (error) return reject(error);
      const embedded = output?.find((entry) => entry.errorDetail?.message || entry.error);
      if (embedded) return reject(new Error((embedded.errorDetail?.message ?? embedded.error ?? 'Docker build failed.').slice(0, 2_000)));
      resolve();
    });
  });
}

export async function removeDockerContainer(docker: Docker, id: string) {
  try {
    await docker.getContainer(id).remove({ force: true, v: true });
  } catch (error) {
    if (dockerStatus(error) !== 404) throw error;
  }
}

export function previewContainerOptions(input: {
  image: string;
  name: string;
  network: string;
  routeAlias: string;
  labels: Record<string, string>;
}): Docker.ContainerCreateOptions {
  const port = `${PREVIEW_CONTAINER_PORT}/tcp`;
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
    // Override image HEALTHCHECKs that use `localhost` (Alpine often resolves that
    // to ::1 while the app listens on IPv4 only → connection refused).
    Healthcheck: {
      Test: [
        'CMD-SHELL',
        `wget -q --spider http://127.0.0.1:${PREVIEW_CONTAINER_PORT}${PREVIEW_HEALTH_PATH} || curl -fsS http://127.0.0.1:${PREVIEW_CONTAINER_PORT}${PREVIEW_HEALTH_PATH} >/dev/null || exit 1`,
      ],
      Interval: 2_000_000_000,
      Timeout: 3_000_000_000,
      Retries: 5,
      StartPeriod: 10_000_000_000,
    },
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

export async function waitForHealthyContainer(docker: Docker, id: string, timeoutMs: number) {
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
