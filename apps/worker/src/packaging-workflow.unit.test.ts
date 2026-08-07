import { DEFAULT_PACKAGING_PLAN, PACKAGING_WORKFLOW_PATH } from '@orchestra/contracts';
import { describe, expect, it } from 'vitest';
import { packagingWorkflowPath, renderPackagingWorkflow } from './packaging-workflow.js';

describe('renderPackagingWorkflow', () => {
  it('renders only allowlisted steps from the packaging plan', () => {
    const yaml = renderPackagingWorkflow({
      ...DEFAULT_PACKAGING_PLAN,
      checks: [
        ...DEFAULT_PACKAGING_PLAN.checks,
        { id: 'unit-tests', kind: 'unit_tests', required: true },
      ],
    });
    expect(packagingWorkflowPath()).toBe(PACKAGING_WORKFLOW_PATH);
    expect(yaml).toContain('name: Iteration packaging');
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toContain('push:');
    expect(yaml).toContain('docker-build:');
    expect(yaml).toContain('container-health:');
    expect(yaml).toContain('unit-tests:');
    expect(yaml).toContain('docker build -f Dockerfile');
    expect(yaml).toContain('pnpm test');
    expect(yaml).not.toContain('rm -rf');
  });
});
