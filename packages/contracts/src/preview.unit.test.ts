import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CONTAINER_PORT,
  PREVIEW_CONTRACT_VERSION,
  PREVIEW_DOCKERFILE_PATH,
  PREVIEW_HEALTH_PATH,
  PREVIEW_RUNTIME_CONTRACT,
  previewDeploymentRequestSchema,
  previewDeploymentResultSchema,
} from './preview.js';

const request = {
  contractVersion: PREVIEW_CONTRACT_VERSION,
  projectId: '00000000-0000-4000-8000-000000000001',
  iterationId: '00000000-0000-4000-8000-000000000002',
  iterationNumber: 1,
  repository: {
    owner: 'orchestra-agent',
    name: 'reviewable-project',
    url: 'http://forgejo:3000/orchestra-agent/reviewable-project',
    branch: 'iteration-1-agents',
  },
  runtime: PREVIEW_RUNTIME_CONTRACT,
};

describe('deterministic preview contract', () => {
  it('pins one root Dockerfile runtime with a fixed port and health route', () => {
    expect(PREVIEW_RUNTIME_CONTRACT).toEqual({
      source: 'dockerfile',
      buildContext: '.',
      dockerfilePath: PREVIEW_DOCKERFILE_PATH,
      containerPort: PREVIEW_CONTAINER_PORT,
      health: { method: 'GET', path: PREVIEW_HEALTH_PATH },
    });
    expect(previewDeploymentRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects request-side runtime drift', () => {
    expect(() => previewDeploymentRequestSchema.parse({
      ...request,
      runtime: { ...PREVIEW_RUNTIME_CONTRACT, containerPort: 3000 },
    })).toThrow();
    expect(() => previewDeploymentRequestSchema.parse({
      ...request,
      runtime: { ...PREVIEW_RUNTIME_CONTRACT, health: { method: 'GET', path: '/ready' } },
    })).toThrow();
  });

  it('requires deployer evidence and both internal and public URLs', () => {
    const result = {
      contractVersion: PREVIEW_CONTRACT_VERSION,
      title: 'Iteration 1 preview',
      publicUrl: 'http://localhost:4173/',
      internalUrl: 'http://preview-runtime:8080/',
      revision: '0123456789abcdef0123456789abcdef01234567',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      expiresAt: '2026-08-03T14:00:00.000Z',
      source: 'managed' as const,
      runtime: PREVIEW_RUNTIME_CONTRACT,
    };

    expect(previewDeploymentResultSchema.parse(result)).toEqual(result);
    expect(() => previewDeploymentResultSchema.parse({ ...result, imageDigest: 'latest' })).toThrow();
    expect(() => previewDeploymentResultSchema.parse({ ...result, revision: 'iteration-1-agents' })).toThrow();
    expect(() => previewDeploymentResultSchema.parse({ ...result, revision: 'A'.repeat(40) })).toThrow();
    expect(() => previewDeploymentResultSchema.parse({ ...result, internalUrl: undefined })).toThrow();
  });
});
