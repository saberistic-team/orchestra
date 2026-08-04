import { z } from 'zod';

export const PREVIEW_CONTRACT_VERSION = 1 as const;
export const PREVIEW_DOCKERFILE_PATH = 'Dockerfile' as const;
export const PREVIEW_BUILD_CONTEXT = '.' as const;
export const PREVIEW_CONTAINER_PORT = 8080 as const;
export const PREVIEW_HEALTH_METHOD = 'GET' as const;
export const PREVIEW_HEALTH_PATH = '/health' as const;
export const PREVIEW_RUNTIME_SOURCE = 'dockerfile' as const;

/** The one runtime shape every generated repository and deployer can rely on. */
export const PREVIEW_RUNTIME_CONTRACT = Object.freeze({
  source: PREVIEW_RUNTIME_SOURCE,
  buildContext: PREVIEW_BUILD_CONTEXT,
  dockerfilePath: PREVIEW_DOCKERFILE_PATH,
  containerPort: PREVIEW_CONTAINER_PORT,
  health: Object.freeze({
    method: PREVIEW_HEALTH_METHOD,
    path: PREVIEW_HEALTH_PATH,
  }),
});

export const previewRuntimeContractSchema = z.object({
  source: z.literal(PREVIEW_RUNTIME_SOURCE),
  buildContext: z.literal(PREVIEW_BUILD_CONTEXT),
  dockerfilePath: z.literal(PREVIEW_DOCKERFILE_PATH),
  containerPort: z.literal(PREVIEW_CONTAINER_PORT),
  health: z.object({
    method: z.literal(PREVIEW_HEALTH_METHOD),
    path: z.literal(PREVIEW_HEALTH_PATH),
  }).strict(),
}).strict();
export type PreviewRuntimeContract = z.infer<typeof previewRuntimeContractSchema>;

export const previewDeploymentRequestSchema = z.object({
  contractVersion: z.literal(PREVIEW_CONTRACT_VERSION),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid(),
  iterationNumber: z.number().int().positive(),
  repository: z.object({
    owner: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(255),
    url: z.string().url(),
    branch: z.string().trim().min(1).max(255),
  }).strict(),
  runtime: previewRuntimeContractSchema,
}).strict();
export type PreviewDeploymentRequest = z.infer<typeof previewDeploymentRequestSchema>;

export const previewDeploymentSourceSchema = z.enum(['existing', 'adapter', 'managed']);
export type PreviewDeploymentSource = z.infer<typeof previewDeploymentSourceSchema>;

export const previewRevisionSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const previewImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const previewAttestationSchema = z.object({
  revision: previewRevisionSchema,
  imageDigest: previewImageDigestSchema,
  triedAt: z.string().datetime(),
}).strict();
export type PreviewAttestation = z.infer<typeof previewAttestationSchema>;

export const previewDeploymentResultSchema = z.object({
  contractVersion: z.literal(PREVIEW_CONTRACT_VERSION),
  title: z.string().trim().min(1).max(500),
  publicUrl: z.string().url(),
  internalUrl: z.string().url(),
  revision: previewRevisionSchema,
  imageDigest: previewImageDigestSchema,
  expiresAt: z.string().datetime(),
  source: previewDeploymentSourceSchema,
  runtime: previewRuntimeContractSchema,
}).strict();
export type PreviewDeploymentResult = z.infer<typeof previewDeploymentResultSchema>;
