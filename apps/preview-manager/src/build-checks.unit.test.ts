import { describe, expect, it } from 'vitest';
import { detectUnitTestCommand, assemblePackagingEvidence } from './build-checks.js';
import { PACKAGING_CONTRACT_VERSION } from '@orchestra/contracts';
import { PREVIEW_CONTAINER_NAME } from './preview-routing.js';

describe('detectUnitTestCommand', () => {
  it('prefers pnpm, then yarn, then npm from lockfiles', () => {
    expect(detectUnitTestCommand(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm test');
    expect(detectUnitTestCommand(['yarn.lock', 'package.json'])).toBe('yarn test');
    expect(detectUnitTestCommand(['package-lock.json'])).toBe('npm test');
    expect(detectUnitTestCommand(['README.md'])).toBeUndefined();
  });
});

describe('packaging health container names', () => {
  it('keeps packaging probes outside the gateway-routable preview name space', () => {
    const packagingName = 'orchestra-pkg-e5ec03f6-1-0123456789ab';
    expect(PREVIEW_CONTAINER_NAME.test(packagingName)).toBe(false);
    expect(PREVIEW_CONTAINER_NAME.test('orchestra-preview-e5ec03f6-1-0123456789ab')).toBe(true);
  });
});

describe('assemblePackagingEvidence', () => {
  it('fails when any required check did not pass', () => {
    const evidence = assemblePackagingEvidence({
      revision: 'a'.repeat(40),
      imageDigest: null,
      checks: [{
        id: 'docker-build',
        kind: 'docker_build',
        required: true,
        status: 'failed',
        summary: 'build failed',
        log: 'error',
      }],
    });
    expect(evidence.contractVersion).toBe(PACKAGING_CONTRACT_VERSION);
    expect(evidence.passed).toBe(false);
  });
});
