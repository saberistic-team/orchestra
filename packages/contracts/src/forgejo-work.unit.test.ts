import { describe, expect, it } from 'vitest';
import {
  agentAssignmentLabel,
  forgejoAgentUsername,
  forgejoIssueActionSchema,
  forgejoWorkPackagesDocumentSchema,
  formatForgejoIssuesContext,
  parseAgentAssignmentLabel,
} from './forgejo-work.js';

describe('forgejo work contracts', () => {
  it('accepts manager work packages and rejects unauthorized release assignees', () => {
    expect(forgejoWorkPackagesDocumentSchema.parse({
      packages: [{
        key: 'charter-shape',
        title: 'Shape the first delivery charter',
        body: 'Define intent, audience, success criteria, and the first bounded increment for review.',
        assigneeRoles: ['manager', 'product'],
      }],
    }).packages).toHaveLength(1);

    expect(() => forgejoWorkPackagesDocumentSchema.parse({
      packages: [{
        key: 'ship',
        title: 'Ship to production',
        body: 'Deploy the approved artifact to production without authorization.',
        assigneeRoles: ['deployment'],
      }],
    })).toThrow();

    expect(() => forgejoWorkPackagesDocumentSchema.parse({
      packages: [{
        key: 'backend-api',
        title: 'Build the backend API',
        body: 'Invented engineering roles must be rejected in favor of Orchestra delivery agents.',
        assigneeRoles: ['developer.backend'],
      }],
    })).toThrow();
  });

  it('parses issue actions including create and complete', () => {
    expect(forgejoIssueActionSchema.parse({
      type: 'createIssue',
      key: 'split-api',
      title: 'Define API contract for intake',
      body: 'Split the architecture work into a concrete API contract with acceptance criteria for Builder.',
      assigneeRoles: ['architecture', 'builder'],
      parentIssueNumber: 3,
    }).type).toBe('createIssue');
    expect(forgejoIssueActionSchema.parse({
      type: 'completeIssue',
      issueNumber: 3,
      comment: 'Acceptance criteria are met for this package.',
    }).type).toBe('completeIssue');
  });

  it('formats assignment labels and issue context for orders', () => {
    expect(agentAssignmentLabel('planner')).toBe('agent/planner');
    expect(forgejoAgentUsername('builder')).toBe('orchestra-builder');
    expect(parseAgentAssignmentLabel('agent/builder')).toBe('builder');
    expect(formatForgejoIssuesContext([{
      number: 7,
      url: 'https://forgejo.example/o/r/issues/7',
      title: 'Plan packaging checks',
      body: 'Require docker_build and container_health.',
      labels: ['agent/planner', 'item/ready'],
      state: 'open',
    }])).toContain('#7: Plan packaging checks');
  });
});
