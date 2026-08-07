import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACKAGING_PLAN,
  detectUnitTestCommand,
  packagingEvidenceSatisfiesPlan,
  packagingPlanSchema,
  packagingEvidenceSchema,
  parsePlannerPackagingPlan,
  resolvePackagingPlanFromArtifacts,
  truncatePackagingLog,
  PACKAGING_CONTRACT_VERSION,
} from './packaging.js';

describe('packagingPlanSchema', () => {
  it('accepts the default packaging plan', () => {
    expect(packagingPlanSchema.parse(DEFAULT_PACKAGING_PLAN)).toMatchObject({
      contractVersion: PACKAGING_CONTRACT_VERSION,
      checks: [
        { id: 'docker-build', kind: 'docker_build', required: true },
        { id: 'container-health', kind: 'container_health', required: true },
      ],
    });
  });

  it('rejects unknown check kinds and duplicate ids', () => {
    expect(() => packagingPlanSchema.parse({
      checks: [{ id: 'shell', kind: 'arbitrary_shell', required: true }],
      acceptanceSummary: 'no',
    })).toThrow();
    expect(() => packagingPlanSchema.parse({
      checks: [
        { id: 'docker-build', kind: 'docker_build', required: true },
        { id: 'docker-build', kind: 'container_health', required: true },
      ],
      acceptanceSummary: 'duplicate ids',
    })).toThrow(/Duplicate packaging check id/);
  });

  it('requires docker_build and container_health as required checks', () => {
    expect(() => packagingPlanSchema.parse({
      checks: [{ id: 'unit-tests', kind: 'unit_tests', required: true }],
      acceptanceSummary: 'only unit tests',
    })).toThrow(/must require docker_build and container_health/);
    expect(() => packagingPlanSchema.parse({
      checks: [
        { id: 'docker-build', kind: 'docker_build', required: false },
        { id: 'container-health', kind: 'container_health', required: true },
      ],
      acceptanceSummary: 'optional docker build',
    })).toThrow(/must require docker_build and container_health/);
  });
});

describe('parsePlannerPackagingPlan', () => {
  it('defaults when omitted and resolves artifact content', () => {
    expect(parsePlannerPackagingPlan(undefined)).toMatchObject({
      contractVersion: PACKAGING_CONTRACT_VERSION,
      checks: DEFAULT_PACKAGING_PLAN.checks,
    });
    expect(resolvePackagingPlanFromArtifacts([
      { type: 'packaging-plan', content: JSON.stringify(DEFAULT_PACKAGING_PLAN) },
    ])).toMatchObject({ checks: DEFAULT_PACKAGING_PLAN.checks });
    expect(resolvePackagingPlanFromArtifacts([{ type: 'other', content: '{}' }])).toMatchObject({
      checks: DEFAULT_PACKAGING_PLAN.checks,
    });
  });

  it('normalizes dotted check ids and hyphenated kinds before validation', () => {
    expect(parsePlannerPackagingPlan({
      checks: [
        { id: 'docker.build', kind: 'docker-build', required: true },
        { id: 'container.health', kind: 'container-health', required: true },
      ],
      acceptanceSummary: 'Build and health must pass before handoff.',
    })).toMatchObject({
      checks: [
        { id: 'docker-build', kind: 'docker_build', required: true },
        { id: 'container-health', kind: 'container_health', required: true },
      ],
    });
  });
});

describe('detectUnitTestCommand', () => {
  it('prefers lockfiles in package-manager order', () => {
    expect(detectUnitTestCommand(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm test');
    expect(detectUnitTestCommand(['yarn.lock', 'package.json'])).toBe('yarn test');
    expect(detectUnitTestCommand(['package-lock.json'])).toBe('npm test');
    expect(detectUnitTestCommand(['README.md'])).toBeUndefined();
  });
});

describe('packagingEvidenceSatisfiesPlan', () => {
  it('requires every required check to pass', () => {
    const evidence = packagingEvidenceSchema.parse({
      contractVersion: PACKAGING_CONTRACT_VERSION,
      revision: 'a'.repeat(40),
      imageDigest: `sha256:${'b'.repeat(64)}`,
      checks: [
        {
          id: 'docker-build',
          kind: 'docker_build',
          required: true,
          status: 'passed',
          summary: 'Image built',
          log: '',
        },
        {
          id: 'container-health',
          kind: 'container_health',
          required: true,
          status: 'failed',
          summary: 'Health failed',
          log: 'timeout',
        },
      ],
      passed: false,
      attemptedAt: '2026-08-05T12:00:00.000Z',
    });
    expect(packagingEvidenceSatisfiesPlan(evidence, DEFAULT_PACKAGING_PLAN)).toBe(false);

    const green = packagingEvidenceSchema.parse({
      ...evidence,
      checks: evidence.checks.map((check) => ({ ...check, status: 'passed' as const, summary: 'ok' })),
      passed: true,
    });
    expect(packagingEvidenceSatisfiesPlan(green, DEFAULT_PACKAGING_PLAN)).toBe(true);
  });
});

describe('truncatePackagingLog', () => {
  it('keeps short logs intact and truncates long ones', () => {
    expect(truncatePackagingLog('ok')).toBe('ok');
    const long = 'x'.repeat(10_000);
    const truncated = truncatePackagingLog(long, 100);
    expect(truncated.length).toBeLessThanOrEqual(100);
    expect(truncated).toContain('[truncated]');
  });
});
