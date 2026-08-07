import {
  packagingBuildChecksRequestSchema,
  previewDeploymentRequestSchema,
  type PackagingBuildChecksRequest,
  type PreviewDeploymentRequest,
} from '@orchestra/contracts';

export type { PreviewDeploymentRequest, PreviewDeploymentResult } from '@orchestra/contracts';
export type { PackagingBuildChecksRequest, PackagingBuildChecksResult } from '@orchestra/contracts';

export type PreviewRepositoryInput = PreviewDeploymentRequest['repository'];

export interface SourceArchive {
  revision: string;
  context: Buffer;
  contextDigest: string;
  paths: string[];
}

const REPOSITORY_SEGMENT = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,99})$/u;
const BRANCH = /^iteration-[1-9][0-9]*-agents$/u;
const GIT_REVISION = /^[0-9a-f]{40,64}$/u;

function assertManagedRepository(input: {
  repository: PreviewRepositoryInput;
  iterationNumber: number;
}) {
  if (!REPOSITORY_SEGMENT.test(input.repository.owner) || !REPOSITORY_SEGMENT.test(input.repository.name)) {
    throw new Error('Repository owner or name is invalid.');
  }
  if (!BRANCH.test(input.repository.branch)) throw new Error('Only managed iteration branches can be previewed.');
  if (input.repository.branch !== `iteration-${String(input.iterationNumber)}-agents`) {
    throw new Error('The repository branch does not match the requested iteration.');
  }
}

/** Strictly parses the small, versioned API exposed to the validation worker. */
export function parsePreviewDeploymentRequest(value: unknown): PreviewDeploymentRequest {
  const input = previewDeploymentRequestSchema.parse(value);
  assertManagedRepository(input);
  return input;
}

export function parsePackagingBuildChecksRequest(value: unknown): PackagingBuildChecksRequest {
  const input = packagingBuildChecksRequestSchema.parse(value);
  assertManagedRepository(input);
  if (input.revision && !GIT_REVISION.test(input.revision)) {
    throw new Error('Packaging revision must be an immutable git SHA.');
  }
  return input;
}
