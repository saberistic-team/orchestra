import { z } from 'zod';
import { previewImageDigestSchema, previewRevisionSchema, previewRuntimeContractSchema, PREVIEW_CONTRACT_VERSION, PREVIEW_RUNTIME_CONTRACT } from './preview.js';

export const PACKAGING_CONTRACT_VERSION = 1 as const;
export const PACKAGING_WORKFLOW_PATH = '.forgejo/workflows/iteration-packaging.yml' as const;
export const DEFAULT_PACKAGING_MAX_ATTEMPTS = 4 as const;
export const PACKAGING_LOG_MAX_CHARS = 8_000 as const;

export const packagingCheckKindSchema = z.enum(['docker_build', 'container_health', 'unit_tests']);
export type PackagingCheckKind = z.infer<typeof packagingCheckKindSchema>;

export const packagingCheckSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u),
  kind: packagingCheckKindSchema,
  required: z.boolean().default(true),
}).strict();
export type PackagingCheck = z.infer<typeof packagingCheckSchema>;

export const packagingPlanSchema = z.object({
  contractVersion: z.literal(PACKAGING_CONTRACT_VERSION).default(PACKAGING_CONTRACT_VERSION),
  checks: z.array(packagingCheckSchema).min(1).max(8),
  acceptanceSummary: z.string().trim().min(1).max(2_000),
}).strict().superRefine((plan, ctx) => {
  const ids = new Set<string>();
  for (const check of plan.checks) {
    if (ids.has(check.id)) {
      ctx.addIssue({ code: 'custom', message: `Duplicate packaging check id: ${check.id}`, path: ['checks'] });
    }
    ids.add(check.id);
  }
  const requiredKinds = new Set(plan.checks.filter((check) => check.required).map((check) => check.kind));
  if (!requiredKinds.has('docker_build') || !requiredKinds.has('container_health')) {
    ctx.addIssue({
      code: 'custom',
      message: 'Planner packagingPlan must require docker_build and container_health.',
      path: ['checks'],
    });
  }
});
export type PackagingPlan = z.infer<typeof packagingPlanSchema>;

export const packagingCheckStatusSchema = z.enum(['passed', 'failed', 'skipped']);
export type PackagingCheckStatus = z.infer<typeof packagingCheckStatusSchema>;

export const packagingCheckResultSchema = z.object({
  id: z.string().trim().min(1).max(64),
  kind: packagingCheckKindSchema,
  required: z.boolean(),
  status: packagingCheckStatusSchema,
  summary: z.string().trim().min(1).max(500),
  log: z.string().max(PACKAGING_LOG_MAX_CHARS).default(''),
}).strict();
export type PackagingCheckResult = z.infer<typeof packagingCheckResultSchema>;

export const packagingEvidenceSchema = z.object({
  contractVersion: z.literal(PACKAGING_CONTRACT_VERSION),
  revision: previewRevisionSchema,
  imageDigest: previewImageDigestSchema.nullable().default(null),
  checks: z.array(packagingCheckResultSchema).min(1).max(8),
  passed: z.boolean(),
  attemptedAt: z.string().datetime(),
}).strict();
export type PackagingEvidence = z.infer<typeof packagingEvidenceSchema>;

export const packagingBuildChecksRequestSchema = z.object({
  contractVersion: z.literal(PACKAGING_CONTRACT_VERSION),
  projectId: z.string().uuid(),
  iterationId: z.string().uuid(),
  iterationNumber: z.number().int().positive(),
  repository: z.object({
    owner: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(255),
    url: z.string().url(),
    branch: z.string().trim().min(1).max(255),
  }).strict(),
  runtime: previewRuntimeContractSchema.default(PREVIEW_RUNTIME_CONTRACT),
  plan: packagingPlanSchema,
  /** When set, prefer this exact revision instead of the branch tip. */
  revision: previewRevisionSchema.optional(),
}).strict();
export type PackagingBuildChecksRequest = z.infer<typeof packagingBuildChecksRequestSchema>;

export const packagingBuildChecksResultSchema = z.object({
  contractVersion: z.literal(PACKAGING_CONTRACT_VERSION),
  evidence: packagingEvidenceSchema,
  previewContractVersion: z.literal(PREVIEW_CONTRACT_VERSION).default(PREVIEW_CONTRACT_VERSION),
}).strict();
export type PackagingBuildChecksResult = z.infer<typeof packagingBuildChecksResultSchema>;

export const DEFAULT_PACKAGING_PLAN: PackagingPlan = {
  contractVersion: PACKAGING_CONTRACT_VERSION,
  checks: [
    { id: 'docker-build', kind: 'docker_build', required: true },
    { id: 'container-health', kind: 'container_health', required: true },
  ],
  acceptanceSummary: 'The iteration image must build from the root Dockerfile and serve a healthy GET /health on port 8080.',
};

export function cloneDefaultPackagingPlan(): PackagingPlan {
  return { ...DEFAULT_PACKAGING_PLAN, checks: [...DEFAULT_PACKAGING_PLAN.checks] };
}

function slugPackagingCheckId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'check';
}

/**
 * Normalize planner packaging drift before schema validation.
 * Models often emit dotted ids (`docker.build`) or hyphenated kinds (`docker-build`).
 */
export function normalizePackagingPlanDocument(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.checks)) return value;
  return {
    ...raw,
    checks: raw.checks.map((check) => {
      if (!check || typeof check !== 'object' || Array.isArray(check)) return check;
      const entry = { ...(check as Record<string, unknown>) };
      if (typeof entry.id === 'string') {
        const id = entry.id.trim();
        entry.id = /^[a-z][a-z0-9_-]*$/u.test(id) && id.length <= 64
          ? id
          : slugPackagingCheckId(id);
      }
      if (typeof entry.kind === 'string') {
        entry.kind = entry.kind.trim().toLowerCase().replace(/-/gu, '_');
      }
      return entry;
    }),
  };
}

/** Normalize planner packaging output; fall back to the preview-aligned default plan when raw is nullish. */
export function parsePlannerPackagingPlan(raw: unknown): PackagingPlan {
  if (raw == null) return cloneDefaultPackagingPlan();
  const parsed = packagingPlanSchema.safeParse(normalizePackagingPlanDocument(raw));
  if (!parsed.success) {
    throw new Error(`Planner returned an invalid packagingPlan: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.data;
}

export function resolvePackagingPlanFromArtifacts(
  artifacts: ReadonlyArray<{ type: string; content: string }> | undefined,
): PackagingPlan {
  const match = artifacts?.find((artifact) => artifact.type === 'packaging-plan');
  if (!match) return cloneDefaultPackagingPlan();
  try {
    return parsePlannerPackagingPlan(JSON.parse(match.content));
  } catch {
    return cloneDefaultPackagingPlan();
  }
}

export type UnitTestCommand = 'pnpm test' | 'yarn test' | 'npm test';

/** Shared package-manager policy for sandbox checks and Forgejo workflow YAML. */
export function detectUnitTestCommand(paths: readonly string[]): UnitTestCommand | undefined {
  const set = new Set(paths);
  if (set.has('pnpm-lock.yaml')) return 'pnpm test';
  if (set.has('yarn.lock')) return 'yarn test';
  if (set.has('package-lock.json') || set.has('package.json')) return 'npm test';
  return undefined;
}

export function packagingEvidenceSatisfiesPlan(evidence: PackagingEvidence, plan: PackagingPlan): boolean {
  if (!evidence.passed) return false;
  for (const check of plan.checks) {
    if (!check.required) continue;
    const result = evidence.checks.find((candidate) => candidate.id === check.id && candidate.kind === check.kind);
    if (!result || result.status !== 'passed') return false;
  }
  return true;
}

export function truncatePackagingLog(log: string, max: number = PACKAGING_LOG_MAX_CHARS): string {
  if (log.length <= max) return log;
  return `${log.slice(0, max - 20)}\n...[truncated]...`;
}

/** Append sandbox failure evidence into Builder context for the next remediation round. */
export function formatPackagingSandboxResults(evidence: PackagingEvidence, plan: PackagingPlan): string {
  const lines = [
    'PACKAGING_SANDBOX_RESULTS',
    `contractVersion=${PACKAGING_CONTRACT_VERSION}`,
    `revision=${evidence.revision}`,
    `passed=${evidence.passed}`,
    `acceptance=${plan.acceptanceSummary}`,
    'checks:',
  ];
  for (const check of evidence.checks) {
    lines.push(`- ${check.id} (${check.kind}) required=${check.required} status=${check.status}: ${check.summary}`);
    if (check.log.trim()) lines.push(truncatePackagingLog(check.log.trim(), 4_000));
  }
  return lines.join('\n');
}
