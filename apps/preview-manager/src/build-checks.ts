import Docker from 'dockerode';
import {
  detectUnitTestCommand,
  PACKAGING_CONTRACT_VERSION,
  PREVIEW_CONTRACT_VERSION,
  PREVIEW_CONTAINER_PORT,
  truncatePackagingLog,
  type PackagingBuildChecksRequest,
  type PackagingBuildChecksResult,
  type PackagingCheck,
  type PackagingCheckResult,
  type PackagingEvidence,
  type UnitTestCommand,
} from '@orchestra/contracts';
import { followBuildProgress, previewImageTag, removeDockerContainer, waitForHealthyContainer } from './docker-ops.js';
import type { SourceArchive } from './types.js';

export { detectUnitTestCommand, type UnitTestCommand };

function summarizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 500)
    || 'Packaging check failed.';
}

async function collectLogs(container: Docker.Container) {
  const logs = await container.logs({ stdout: true, stderr: true, tail: 120 }).catch(() => Buffer.alloc(0));
  return truncatePackagingLog(logs.toString('utf8'));
}

export async function runDockerBuildCheck(options: {
  docker: Docker;
  source: SourceArchive;
  image: string;
  labels: Record<string, string>;
}): Promise<{ result: PackagingCheckResult; imageDigest: string | null }> {
  const checkBase = { id: 'docker-build', kind: 'docker_build' as const, required: true };
  try {
    try {
      const existing = await options.docker.getImage(options.image).inspect();
      if (/^sha256:[0-9a-f]{64}$/u.test(existing.Id)) {
        return {
          imageDigest: existing.Id,
          result: {
            ...checkBase,
            status: 'passed',
            summary: 'Reused existing packaging image for this revision.',
            log: '',
          },
        };
      }
    } catch {
      // Build when the tagged image is absent.
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Packaging image build timed out.')), Number(process.env.PREVIEW_BUILD_TIMEOUT_MS ?? 600_000));
    try {
      const stream = await options.docker.buildImage(options.source.context as unknown as NodeJS.ReadableStream, {
        t: options.image,
        dockerfile: 'Dockerfile',
        version: '2',
        pull: true,
        rm: true,
        forcerm: true,
        memory: 2 * 1024 * 1024 * 1024,
        memswap: 2 * 1024 * 1024 * 1024,
        shmsize: 128 * 1024 * 1024,
        networkmode: process.env.PREVIEW_BUILD_NETWORK_MODE === 'none' ? 'none' : 'default',
        labels: options.labels,
        abortSignal: abort.signal,
      });
      await followBuildProgress(options.docker, stream);
    } finally {
      clearTimeout(timer);
    }
    const imageInspection = await options.docker.getImage(options.image).inspect();
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageInspection.Id)) {
      throw new Error('Docker returned no immutable packaging image digest.');
    }
    return {
      imageDigest: imageInspection.Id,
      result: {
        ...checkBase,
        status: 'passed',
        summary: 'Docker image built successfully.',
        log: `image=${imageInspection.Id}`,
      },
    };
  } catch (error) {
    return {
      imageDigest: null,
      result: {
        ...checkBase,
        status: 'failed',
        summary: summarizeError(error),
        log: summarizeError(error),
      },
    };
  }
}

export async function runContainerHealthCheck(options: {
  docker: Docker;
  image: string;
  name: string;
  network: string;
  labels: Record<string, string>;
  createContainer: (input: {
    image: string;
    name: string;
    network: string;
    routeAlias: string;
    labels: Record<string, string>;
  }) => Docker.ContainerCreateOptions;
  routeAlias: string;
}): Promise<PackagingCheckResult> {
  const checkBase = { id: 'container-health', kind: 'container_health' as const, required: true };
  await removeDockerContainer(options.docker, options.name);
  let container: Docker.Container | undefined;
  try {
    container = await options.docker.createContainer(options.createContainer({
      image: options.image,
      name: options.name,
      network: options.network,
      routeAlias: options.routeAlias,
      labels: options.labels,
    }));
    await container.start();
    await waitForHealthyContainer(
      options.docker,
      container.id,
      Number(process.env.PREVIEW_HEALTH_TIMEOUT_MS ?? 90_000),
    );
    const log = await collectLogs(container);
    await removeDockerContainer(options.docker, container.id);
    return {
      ...checkBase,
      status: 'passed',
      summary: `Container healthy on port ${PREVIEW_CONTAINER_PORT}.`,
      log,
    };
  } catch (error) {
    const log = container ? await collectLogs(container) : '';
    if (container) await removeDockerContainer(options.docker, container.id).catch(() => undefined);
    return {
      ...checkBase,
      status: 'failed',
      summary: summarizeError(error),
      log: truncatePackagingLog([summarizeError(error), log].filter(Boolean).join('\n')),
    };
  }
}

export async function runUnitTestsCheck(options: {
  docker: Docker;
  source: SourceArchive;
  check: PackagingCheck;
}): Promise<PackagingCheckResult> {
  const command = detectUnitTestCommand(options.source.paths);
  if (!command) {
    return {
      id: options.check.id,
      kind: 'unit_tests',
      required: options.check.required,
      status: options.check.required ? 'failed' : 'skipped',
      summary: options.check.required
        ? 'No package.json or supported lockfile was present for unit_tests.'
        : 'Skipped unit_tests; no package manager manifest found.',
      log: '',
    };
  }
  const name = `orchestra-packaging-tests-${Date.now().toString(36)}`;
  await removeDockerContainer(options.docker, name);
  let container: Docker.Container | undefined;
  try {
    const install = command.startsWith('pnpm')
      ? 'corepack enable && pnpm install --frozen-lockfile'
      : command.startsWith('yarn')
        ? 'yarn install --frozen-lockfile'
        : 'npm ci || npm install';
    container = await options.docker.createContainer({
      name,
      Image: process.env.PACKAGING_NODE_IMAGE ?? 'node:26-alpine',
      WorkingDir: '/app',
      Cmd: ['sh', '-c', `${install} && ${command}`],
      HostConfig: {
        AutoRemove: false,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Memory: 1_024 * 1_024 * 1_024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256,
        NetworkMode: 'default',
      },
    });
    await container.putArchive(options.source.context, { path: '/app' });
    await container.start();
    const wait = await container.wait();
    const log = await collectLogs(container);
    await removeDockerContainer(options.docker, container.id);
    if (wait.StatusCode !== 0) {
      return {
        id: options.check.id,
        kind: 'unit_tests',
        required: options.check.required,
        status: 'failed',
        summary: `${command} exited with code ${wait.StatusCode}.`,
        log,
      };
    }
    return {
      id: options.check.id,
      kind: 'unit_tests',
      required: options.check.required,
      status: 'passed',
      summary: `${command} passed.`,
      log,
    };
  } catch (error) {
    if (container) await removeDockerContainer(options.docker, container.id).catch(() => undefined);
    return {
      id: options.check.id,
      kind: 'unit_tests',
      required: options.check.required,
      status: 'failed',
      summary: summarizeError(error),
      log: summarizeError(error),
    };
  }
}

export function assemblePackagingEvidence(options: {
  revision: string;
  imageDigest: string | null;
  checks: PackagingCheckResult[];
}): PackagingEvidence {
  const requiredFailed = options.checks.some((check) => check.required && check.status !== 'passed');
  return {
    contractVersion: PACKAGING_CONTRACT_VERSION,
    revision: options.revision,
    imageDigest: options.imageDigest,
    checks: options.checks,
    passed: !requiredFailed,
    attemptedAt: new Date().toISOString(),
  };
}

export function packagingBuildChecksResult(evidence: PackagingEvidence): PackagingBuildChecksResult {
  return {
    contractVersion: PACKAGING_CONTRACT_VERSION,
    evidence,
    previewContractVersion: PREVIEW_CONTRACT_VERSION,
  };
}

export { previewImageTag };
