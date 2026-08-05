import { describe, expect, it } from 'vitest';
import {
  ALL_AGENT_MODEL_TASK_QUEUES,
  ALL_AGENT_TASK_QUEUES,
  MODEL_ROUTING_TASK_QUEUE,
  OLLAMA_INFERENCE_TASK_QUEUE,
  OPENROUTER_INFERENCE_TASK_QUEUE,
  PROJECT_ACTIVITY_TASK_QUEUE,
  PROJECT_WORKFLOW_TASK_QUEUE,
  VALIDATION_TASK_QUEUE,
  agentQuestionAnswerInputSchema,
  agentRelationshipCatalog,
  agentRoleDefinitions,
  agentRoleSchema,
  agentModelTaskQueue,
  agentTaskQueue,
  artifactFeedbackInputSchema,
  deliveryAgentGraph,
  iterationReviewProposalSchema,
  iterationReviewSchema,
  agentExecutionStateSchema,
  organismEventSchema,
  parseAgentModelTaskQueueRole,
  parseAgentRoles,
  parseAgentTaskQueueRole,
  projectBriefSchema,
  projectDetailSchema,
  projectMediaSchema,
  responsibilities,
} from './index.js';

describe('projectBriefSchema', () => {
  it('normalizes a valid brief and supplies constraints', () => {
    const brief = projectBriefSchema.parse({
      name: ' Orchestra ',
      intent: 'Enable non-technical people to create useful software.',
      audience: 'Small business owners',
      success: 'A user can approve and receive a working first release.',
    });
    expect(brief.name).toBe('Orchestra');
    expect(brief.constraints).toEqual([]);
  });

  it('rejects an underspecified intention', () => {
    expect(() => projectBriefSchema.parse({ name: 'X', intent: 'vague' })).toThrow();
  });
});

describe('agent organism contract', () => {
  it('shares the persistent runtime and event vocabulary with the live UI', () => {
    expect(agentExecutionStateSchema.options).toEqual([
      'observing', 'ready', 'planning', 'working', 'reviewing', 'communicating',
      'waiting_on_agent', 'waiting_on_human', 'monitoring', 'blocked', 'completed_for_iteration',
    ]);
    expect(organismEventSchema.parse({
      schemaVersion: '1.0',
      eventId: 'event-1',
      projectId: 'project-1',
      sequence: 1,
      type: 'agent.activity.started',
      correlationId: 'iteration:1:builder',
      actor: {
        projectId: 'project-1',
        role: 'builder',
        workflowId: 'project/project-1/agent/builder',
      },
      subjectRole: 'builder',
      summary: 'Implementing the approved work package.',
      payload: { activityType: 'implementation' },
      createdAt: '2026-08-04T12:00:00.000Z',
    })).toMatchObject({ type: 'agent.activity.started', sequence: 1 });
  });

  it('defines every normative role and its responsibility once', () => {
    expect(agentRoleDefinitions).toHaveLength(14);
    expect(new Set(agentRoleDefinitions.map((definition) => definition.role)).size).toBe(14);
    expect(Object.keys(responsibilities)).toHaveLength(14);
    expect(agentRoleDefinitions.find((definition) => definition.role === 'deployment')?.cannot)
      .toContain('Deploy an unauthorized artifact');
    expect(agentRoleDefinitions.find((definition) => definition.role === 'validation')?.cannot)
      .toContain('Claim business success from technical test results alone');
  });

  it('keeps release agents visible without making them part of an unauthorized iteration', () => {
    expect(deliveryAgentGraph.map((definition) => definition.role)).toEqual(expect.arrayContaining(['deployment', 'validation']));
    expect(deliveryAgentGraph.find((definition) => definition.role === 'deployment'))
      .toMatchObject({ dependsOn: ['gate'], activation: 'authorized_release' });
    expect(deliveryAgentGraph.find((definition) => definition.role === 'validation'))
      .toMatchObject({ dependsOn: ['deployment'], activation: 'authorized_release' });
    expect(agentRelationshipCatalog).toContainEqual(expect.objectContaining({
      from: 'gate', to: 'deployment', kind: 'authorizes',
    }));
  });

  it('exposes the canonical organism ledger and structured proposal evidence in project detail', () => {
    expect(projectDetailSchema.keyof().options).toEqual(expect.arrayContaining([
      'agentGoals',
      'agentActionPlans',
      'agentActions',
      'agentObligations',
      'organismEvents',
      'artifactVersions',
      'findings',
      'modelInvocations',
      'repositoryOperations',
    ]));
    const agentPositions = Object.fromEntries(agentRoleSchema.options.map((role) => [
      role,
      role === 'deployment' || role === 'validation' ? 'not_required' : 'ready',
    ]));
    const proposal = iterationReviewProposalSchema.parse({
      id: 'proposal-1',
      projectId: 'project-1',
      iterationId: 'iteration-1',
      iterationNumber: 1,
      type: 'iteration_review_proposal',
      objectiveStatus: 'satisfied',
      includedRevision: 'a'.repeat(40),
      completedOutcomes: ['Builder produced Build submission v1'],
      openFindings: [],
      agentPositions,
      gateStatus: 'pass',
      gateRationale: 'The deterministic Gate check passed.',
      managerRationale: 'The current revision is ready for human review.',
      recommendation: 'send_for_human_review',
      createdAt: '2026-08-04T12:00:00.000Z',
    });
    expect(proposal).toMatchObject({
      proposalVersion: 1,
      status: 'proposed',
      knownLimitations: [],
      budgetSnapshot: { modelInvocationCount: 0, totalTokens: 0, openRouterCostUsd: 0 },
    });
  });
});

describe('human-in-the-loop contracts', () => {
  it('normalizes nullable preview evidence and accepts a revision-bound review attestation', () => {
    const commonMedia = {
      id: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      iterationId: '00000000-0000-4000-8000-000000000003',
      kind: 'preview',
      title: 'Iteration preview',
      url: 'https://preview.example.test/',
      createdAt: '2026-08-03T12:00:00.000Z',
    };
    expect(projectMediaSchema.parse(commonMedia)).toMatchObject({
      sourceRevision: null,
      imageDigest: null,
      expiresAt: null,
    });
    expect(projectMediaSchema.parse({
      ...commonMedia,
      sourceRevision: 'a'.repeat(40),
      imageDigest: `sha256:${'b'.repeat(64)}`,
      expiresAt: '2026-08-03T14:00:00.000Z',
    })).toMatchObject({ sourceRevision: 'a'.repeat(40) });

    expect(iterationReviewSchema.parse({
      decision: 'approve',
      previewAttestation: {
        revision: 'a'.repeat(40),
        imageDigest: `sha256:${'b'.repeat(64)}`,
        triedAt: '2026-08-03T13:00:00.000Z',
      },
    }).previewAttestation).toEqual({
      revision: 'a'.repeat(40),
      imageDigest: `sha256:${'b'.repeat(64)}`,
      triedAt: '2026-08-03T13:00:00.000Z',
    });
    expect(() => iterationReviewSchema.parse({
      decision: 'approve',
      previewAttestation: {
        revision: 'a'.repeat(40),
        triedAt: '2026-08-03T13:00:00.000Z',
      },
    })).toThrow();
  });

  it('supports option, custom, and agent-decides question answers', () => {
    expect(agentQuestionAnswerInputSchema.parse({
      resolution: 'selected_option',
      optionId: '419a0a3b-3b0a-4af0-9177-b3a96e1239aa',
    }).resolution).toBe('selected_option');
    expect(agentQuestionAnswerInputSchema.parse({ resolution: 'custom', answer: 'Use a staged rollout.' }).resolution)
      .toBe('custom');
    expect(agentQuestionAnswerInputSchema.parse({ resolution: 'agent_decides' }).resolution).toBe('agent_decides');
    expect(() => agentQuestionAnswerInputSchema.parse({ resolution: 'selected_option' })).toThrow();
  });

  it('requires one possibly-empty feedback value for every agent in a structured review', () => {
    const agentFeedback = agentRoleSchema.options.map((role) => ({
      role,
      feedback: role === 'builder' ? 'Keep the implementation bounded.' : '',
    }));
    const review = iterationReviewSchema.parse({
      decision: 'request_changes',
      overallDirection: 'Tighten the first increment.',
      agentFeedback,
      artifactFeedback: [{
        artifactId: '1c92e7e9-8da1-4cb9-8515-fc80d967326c',
        feedback: 'Clarify the recovery state.',
      }],
    });
    expect(review.agentFeedback).toHaveLength(14);
    expect(review.agentFeedback?.find((entry) => entry.role === 'manager')?.feedback).toBe('');
    expect(review.feedback).toBe('');

    expect(() => iterationReviewSchema.parse({
      decision: 'approve',
      agentFeedback: agentFeedback.slice(1),
    })).toThrow();
  });

  it('preserves the legacy review shape and permits an empty artifact feedback value', () => {
    expect(iterationReviewSchema.parse({ decision: 'approved', feedback: '' })).toMatchObject({
      decision: 'approved',
      feedback: '',
    });
    expect(artifactFeedbackInputSchema.parse({
      artifactId: '4768ed4c-a221-4218-ab2d-36f2904963e0',
      feedback: '',
    }).feedback).toBe('');
  });
});

describe('Temporal task queue topology', () => {
  it('gives all 14 agents and their model workflows unique, simple queues', () => {
    expect(ALL_AGENT_TASK_QUEUES).toHaveLength(14);
    expect(ALL_AGENT_MODEL_TASK_QUEUES).toHaveLength(14);
    expect(new Set(ALL_AGENT_TASK_QUEUES).size).toBe(14);
    expect(new Set(ALL_AGENT_MODEL_TASK_QUEUES).size).toBe(14);

    const everyQueue = [
      PROJECT_WORKFLOW_TASK_QUEUE,
      PROJECT_ACTIVITY_TASK_QUEUE,
      VALIDATION_TASK_QUEUE,
      MODEL_ROUTING_TASK_QUEUE,
      OLLAMA_INFERENCE_TASK_QUEUE,
      OPENROUTER_INFERENCE_TASK_QUEUE,
      ...ALL_AGENT_TASK_QUEUES,
      ...ALL_AGENT_MODEL_TASK_QUEUES,
    ];
    expect(new Set(everyQueue).size).toBe(everyQueue.length);
    expect(everyQueue.every((queue) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(queue))).toBe(true);

    for (const role of agentRoleSchema.options) {
      expect(ALL_AGENT_TASK_QUEUES).toContain(agentTaskQueue(role));
      expect(ALL_AGENT_MODEL_TASK_QUEUES).toContain(agentModelTaskQueue(role));
    }
  });

  it('expands grouped worker selectors and de-duplicates in canonical role order', () => {
    expect(parseAgentRoles()).toEqual(agentRoleSchema.options);
    expect(parseAgentRoles(' iteration, release ')).toEqual(agentRoleSchema.options);
    expect(parseAgentRoles('BUILD,manager,build')).toEqual(['manager', 'builder']);
    expect(parseAgentRoles('shape,plan')).toEqual(['manager', 'requirements', 'product', 'planner']);
    expect(parseAgentRoles('release')).toEqual(['deployment', 'validation']);
  });

  it('rejects malformed selectors and only parses exact queue names back to roles', () => {
    expect(() => parseAgentRoles('manager,unknown')).toThrow(/unknown/i);
    expect(() => parseAgentRoles('manager,,builder')).toThrow(/empty/i);
    expect(() => parseAgentRoles('__proto__')).toThrow(/unknown/i);

    expect(parseAgentTaskQueueRole('orchestra-agent-builder')).toBe('builder');
    expect(parseAgentModelTaskQueueRole('orchestra-model-builder')).toBe('builder');
    expect(parseAgentTaskQueueRole('orchestra-agent-builder-extra')).toBeUndefined();
    expect(parseAgentModelTaskQueueRole('orchestra-agent-builder')).toBeUndefined();
    expect(parseAgentTaskQueueRole(undefined)).toBeUndefined();
  });
});
