import type { AgentArtifactDraft, AgentExecutionInput, DynamicExecutionPlan } from '@orchestra/contracts';
import { describe, expect, it } from 'vitest';
import {
  executeDynamicArtifactOrder,
  MAX_DYNAMIC_ARTIFACT_REVISIONS,
  type DynamicAgentModelActionRequest,
  type DynamicAgentModelActionResult,
  type DynamicArtifactExecutionGateways,
  type DynamicModelReasoningRequest,
  type DynamicModelResult,
} from './dynamic-agent-execution.js';

const now = '2026-08-04T12:00:00.000Z';
const input: AgentExecutionInput = {
  project: {
    id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
    name: 'Orchestra',
    intent: 'Turn a human intention into reviewed, traceable software.',
    audience: 'Project owners',
    success: 'A reviewed artifact is produced.',
    constraints: [],
    status: 'defining',
    currentIteration: 1,
    previewUrl: null,
    repositoryUrl: 'https://forgejo.example/orchestra/project',
    repositoryOwner: 'orchestra',
    repositoryName: 'project',
    createdAt: now,
    updatedAt: now,
  },
  iteration: {
    id: 'c67a2fd5-e829-40dc-a6f5-d15e4758515d',
    projectId: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
    number: 1,
    objective: 'Define a testable baseline.',
    status: 'active',
    startedAt: now,
    completedAt: null,
    issueNumber: 1,
    branchName: 'iteration-1-agents',
    pullRequestNumber: null,
    pullRequestUrl: null,
  },
  role: 'requirements',
  artifactType: 'requirements-baseline',
  context: 'The human approved a narrow first increment.',
  inputArtifacts: [],
};

function plan(
  actions: DynamicExecutionPlan['actions'],
  completionCheck: DynamicExecutionPlan['completionCheck'] = {
    type: 'continue',
    reason: 'Observe this bounded action before deciding what follows.',
  },
): DynamicExecutionPlan {
  return {
    protocolVersion: '1',
    goalAssessment: 'The artifact needs another bounded step.',
    contextVersion: 1,
    acknowledgedDecisionIds: [],
    actions,
    completionCheck,
  };
}

function action(id: string, activity: DynamicExecutionPlan['actions'][number]['activity']) {
  return {
    id,
    activity,
    activityVersion: '1.0',
    arguments: {},
    dependsOn: [],
    reason: `Run ${activity} because the current recorded state requires it.`,
  };
}

function inference(
  content: string,
  request: DynamicModelReasoningRequest,
  requestId: string,
): DynamicModelResult {
  return {
    provider: 'openrouter',
    model: `${request.role}-model`,
    content,
    requestId,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 },
  };
}

function draft(invocations: AgentArtifactDraft['modelInvocations']): AgentArtifactDraft {
  return {
    type: input.artifactType,
    name: input.artifactType,
    content: '# Requirements\n\nThe baseline is testable.',
    mimeType: 'text/markdown',
    producedBy: input.role,
    model: 'requirements-model',
    modelProvider: 'openrouter',
    modelInvocations: invocations,
    attachments: [],
    questions: [],
  };
}

function gateways(plans: unknown[]) {
  const reasoningRequests: DynamicModelReasoningRequest[] = [];
  const actionRequests: DynamicAgentModelActionRequest[] = [];
  let planIndex = 0;
  const gateway: DynamicArtifactExecutionGateways = {
    reason: async (request) => {
      reasoningRequests.push(request);
      const next = plans[planIndex++];
      if (next === undefined) throw new Error('No model plan was queued.');
      return inference(typeof next === 'string' ? next : JSON.stringify(next), request, `plan-${planIndex}`);
    },
    act: async (request): Promise<DynamicAgentModelActionResult> => {
      actionRequests.push(request);
      if (request.action === 'generate_candidate' || request.action === 'revise_candidate') {
        const round = request.action === 'generate_candidate' ? 0 : request.round;
        const candidate = {
          provider: 'openrouter' as const,
          model: 'requirements-model',
          content: JSON.stringify({ content: '# Requirements\n\nThe baseline is testable.' }),
          requestId: `${request.action}-${actionRequests.length}`,
          usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, cost: 0.002 },
        };
        return {
          action: request.action,
          candidate,
          invocation: {
            provider: candidate.provider,
            model: candidate.model,
            purpose: request.action === 'generate_candidate' ? 'generate' : 'revise',
            round,
            requestId: candidate.requestId,
            usage: candidate.usage,
          },
        };
      }
      if (request.action === 'quality_review') {
        const reviewed = {
          provider: 'openrouter' as const,
          model: 'reviewer-model',
          content: JSON.stringify({ status: 'pass', rationale: 'Complete.', findings: [] }),
          requestId: `review-${actionRequests.length}`,
          usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16, cost: 0.001 },
        };
        return {
          action: request.action,
          inference: reviewed,
          review: { status: 'pass', rationale: 'Complete.', findings: [] },
          invocation: {
            provider: reviewed.provider,
            model: reviewed.model,
            purpose: 'quality_review',
            round: request.round,
            requestId: reviewed.requestId,
            usage: reviewed.usage,
          },
        };
      }
      return { action: request.action, draft: draft(request.modelInvocations) };
    },
    now: () => 1_000,
  };
  return { gateway, reasoningRequests, actionRequests };
}

describe('dynamic artifact execution loop', () => {
  it('rejects capability output that violates its strict registered schema', async () => {
    const harness = gateways([
      plan([action('generate', 'model.generate_artifact')]),
      plan([], { type: 'blocked', code: 'INVALID_OUTPUT', reason: 'The capability output was invalid.' }),
    ]);
    const originalAct = harness.gateway.act;
    harness.gateway.act = async (request, operationKey) => ({
      ...await originalAct(request, operationKey),
      undocumented: true,
    }) as DynamicAgentModelActionResult;

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-strict-output',
      input,
      contextVersion: 1,
    }, harness.gateway);

    expect(result.status).toBe('blocked');
    expect(result.trace.observations[0]).toMatchObject({
      status: 'failed',
      error: { code: 'ACTIVITY_FAILED', message: expect.stringContaining('unknown fields') },
    });
  });

  it('rejects runtime limit overrides that exceed the bounded contract', async () => {
    const harness = gateways([]);
    const result = await executeDynamicArtifactOrder({
      executionId: 'order-invalid-limits',
      input,
      contextVersion: 1,
      limits: { maxActionsPerPlan: 100 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'blocked',
      trace: { invocations: [] },
    });
    if (result.status === 'waiting_for_human' || result.status === 'completed') {
      throw new Error('Expected invalid limits to block before planning.');
    }
    expect(result.reason).toContain('Invalid execution limits');
    expect(harness.reasoningRequests).toEqual([]);
  });

  it('plans, observes, replans and completes only after deterministic verification', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], {
        type: 'completed',
        reason: 'The current candidate passed independent review.',
        evidenceRefs: [],
      }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-1', input, contextVersion: 1,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completion.');
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate', 'quality_review', 'finalize_candidate',
    ]);
    expect(result.trace).toMatchObject({
      status: 'completed',
      usage: { planningRounds: 3, actions: 2, modelCalls: 5, totalTokens: 91, cost: 0.006 },
      verification: { passed: true },
    });
    expect(result.trace.invocations).toEqual(result.draft.modelInvocations);
    expect(result.draft.modelInvocations?.map((entry) => entry.purpose)).toEqual([
      'plan', 'generate', 'plan', 'quality_review', 'plan',
    ]);
  });

  it('resolves required evidence against workflow-owned records instead of model-authored strings', async () => {
    const requiredEvidenceRef = 'evidence:acceptance-baseline';
    const completionClaim = {
      type: 'completed' as const,
      reason: 'The model claims the required evidence is present.',
      evidenceRefs: [requiredEvidenceRef],
    };
    const plans = [
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], completionClaim),
    ];
    const accepted = await executeDynamicArtifactOrder({
      executionId: 'order-recorded-evidence',
      input,
      contextVersion: 1,
      requiredEvidenceRefs: [requiredEvidenceRef],
      availableEvidenceRefs: [requiredEvidenceRef],
    }, gateways(plans).gateway);
    expect(accepted).toMatchObject({
      status: 'completed',
      trace: {
        verification: {
          checks: expect.arrayContaining([expect.objectContaining({
            name: 'required_evidence_resolved',
            passed: true,
            evidenceRefs: [requiredEvidenceRef],
          })]),
        },
      },
    });

    const rejectedHarness = gateways([
      plan([action(requiredEvidenceRef, 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], completionClaim),
      plan([], { type: 'blocked', code: 'EVIDENCE_MISSING', reason: 'Recorded evidence is absent.' }),
    ]);
    const rejectedAct = rejectedHarness.gateway.act;
    rejectedHarness.gateway.act = async (request, operationKey) => {
      const result = await rejectedAct(request, operationKey);
      if (result.action !== 'generate_candidate' && result.action !== 'revise_candidate') return result;
      return {
        ...result,
        candidate: { ...result.candidate, requestId: requiredEvidenceRef },
        invocation: { ...result.invocation, requestId: requiredEvidenceRef },
      };
    };
    const rejected = await executeDynamicArtifactOrder({
      executionId: 'order-self-asserted-evidence',
      input,
      contextVersion: 1,
      requiredEvidenceRefs: [requiredEvidenceRef],
    }, rejectedHarness.gateway);
    expect(rejected).toMatchObject({ status: 'blocked' });
    expect(rejected.trace.observations).toContainEqual(expect.objectContaining({
      activity: 'control.verify_completion',
      status: 'failed',
      error: expect.objectContaining({ message: expect.stringContaining(requiredEvidenceRef) }),
    }));
  });

  it('checkpoints quality findings and resolves them only after a successful revision', async () => {
    const decision = {
      decisionKey: 'requirements.revision_authority',
      question: 'May the requirements agent apply the bounded review revision?',
      options: [
        { value: 'apply', label: 'Apply revision' },
        { value: 'defer', label: 'Defer revision' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    } as const;
    const beforeDecision = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], {
        type: 'human_input_required',
        reason: 'The bounded revision requires recorded authority.',
        decision,
      }),
    ]);
    const reviewAct = beforeDecision.gateway.act;
    beforeDecision.gateway.act = async (request, operationKey) => {
      const result = await reviewAct(request, operationKey);
      if (result.action === 'quality_review') {
        result.review = {
          status: 'revise',
          rationale: 'Acceptance evidence is incomplete.',
          findings: ['Cite the acceptance criterion that supports the success claim.'],
        };
      }
      return result;
    };

    const waiting = await executeDynamicArtifactOrder({
      executionId: 'order-finding-checkpoint', input, contextVersion: 1,
    }, beforeDecision.gateway);
    if (waiting.status !== 'waiting_for_human') throw new Error('Expected a durable checkpoint.');
    expect(waiting.trace.findings).toEqual([
      expect.objectContaining({
        findingId: 'quality:1:review-1:0',
        candidateVersion: 1,
        category: 'traceability',
        severity: 'medium',
        ownerRole: 'requirements',
        disposition: 'remediate_current',
        status: 'open',
        evidenceRefs: expect.arrayContaining(['review-2']),
      }),
    ]);
    expect(waiting.checkpoint.findings).toEqual(waiting.trace.findings);

    const afterDecision = gateways([
      plan([action('revise-1', 'model.revise_artifact')]),
      plan([action('review-2', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'The revised candidate passed review.', evidenceRefs: [] }),
    ]);
    const completed = await executeDynamicArtifactOrder({
      executionId: waiting.checkpoint.executionId,
      input,
      contextVersion: 1,
      checkpoint: JSON.parse(JSON.stringify(waiting.checkpoint)),
    }, afterDecision.gateway);

    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') throw new Error('Expected completion after revision.');
    expect(completed.trace.findings).toEqual([
      expect.objectContaining({
        findingId: 'quality:1:review-1:0',
        status: 'resolved',
        resolvedByActionId: 'revise-1',
        resolvedInCandidateVersion: 2,
        evidenceRefs: expect.arrayContaining([
          'order-finding-checkpoint/round/4/action/revise-1/model.revise_artifact@1.0',
        ]),
      }),
    ]);
  });

  it('keeps an unresolved quality finding open when execution terminates blocked', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'blocked', reason: 'Revision authority is unavailable.', code: 'REVISION_BLOCKED' }),
    ]);
    const act = harness.gateway.act;
    harness.gateway.act = async (request, operationKey) => {
      const result = await act(request, operationKey);
      if (result.action === 'quality_review') {
        result.review = {
          status: 'revise',
          rationale: 'A required section is absent.',
          findings: ['The required recovery behavior is missing.'],
        };
      }
      return result;
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-open-finding', input, contextVersion: 1,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'blocked',
      trace: {
        findings: [expect.objectContaining({
          category: 'completeness',
          status: 'open',
          ownerRole: 'requirements',
        })],
      },
    });
  });

  it('sends each model call only the remaining cross-worker budget envelope', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'Reviewed.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-provider-budgets',
      input,
      contextVersion: 1,
      enforceProviderBudgets: true,
      limits: { maxTokens: 1_000, maxCost: 1, maxWallClockMs: 10_000 },
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(harness.reasoningRequests.map((request) => request.inferenceBudget)).toEqual([
      { maxTotalTokens: 1_000, maxCost: 1, deadlineEpochMs: 11_000 },
      { maxTotalTokens: 955, maxCost: 0.997, deadlineEpochMs: 11_000 },
      { maxTotalTokens: 924, maxCost: 0.995, deadlineEpochMs: 11_000 },
    ]);
    expect(harness.actionRequests.slice(0, 2).map((request) => request.inferenceBudget)).toEqual([
      { maxTotalTokens: 985, maxCost: 0.999, deadlineEpochMs: 11_000 },
      { maxTotalTokens: 940, maxCost: 0.996, deadlineEpochMs: 11_000 },
    ]);
    expect(harness.actionRequests.at(-1)).toMatchObject({ action: 'finalize_candidate' });
  });

  it('executes nothing from an invalid plan and uses a bounded repair request', async () => {
    const invalid = plan([{
      ...action('shell-1', 'model.generate_artifact'),
      activity: 'system.shell',
    }]);
    const harness = gateways([
      invalid,
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'Reviewed.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-repaired', input, contextVersion: 1,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(harness.reasoningRequests.map((request) => request.purpose)).toEqual([
      'plan', 'plan_repair', 'plan', 'plan',
    ]);
    expect(harness.actionRequests.filter((request) => request.action !== 'finalize_candidate'))
      .toHaveLength(2);
    if (result.status !== 'completed') throw new Error('Expected completion.');
    expect(result.trace.plans[0]).toMatchObject({ accepted: false, repairAttempt: 0 });
    expect(result.trace.plans[1]).toMatchObject({ accepted: true, repairAttempt: 1 });
  });

  it('does not start an action after planning consumes the remaining model-call budget', async () => {
    const harness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-model-budget',
      input,
      contextVersion: 1,
      limits: { maxModelCalls: 1 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'budget_exhausted',
      trace: {
        usage: { modelCalls: 1, actions: 0 },
        invocations: [expect.objectContaining({ purpose: 'plan', requestId: 'plan-1' })],
      },
    });
    expect(harness.actionRequests).toEqual([]);
  });

  it('does not start an action after planning consumes the remaining token budget', async () => {
    const harness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-token-budget',
      input,
      contextVersion: 1,
      limits: { maxTokens: 15 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'budget_exhausted',
      trace: { usage: { totalTokens: 15, actions: 0 } },
    });
    expect(harness.actionRequests).toEqual([]);
  });

  it('allows deterministic completion when the final successful action exactly consumes every budget ceiling', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan(
        [action('review-1', 'model.review_artifact')],
        {
          type: 'completed',
          reason: 'The final in-budget review passed.',
          evidenceRefs: [],
        },
      ),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-exact-budget-completion',
      input,
      contextVersion: 1,
      limits: {
        maxPlanningRounds: 2,
        maxTotalActions: 2,
        maxModelCalls: 4,
        maxTokens: 76,
        maxCost: 0.005,
      },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'completed',
      trace: {
        status: 'completed',
        usage: {
          planningRounds: 2,
          actions: 2,
          modelCalls: 4,
          totalTokens: 76,
          cost: 0.005,
        },
      },
    });
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate',
      'quality_review',
      'finalize_candidate',
    ]);
  });

  it('permits zero-cost local inference when the configured cost ceiling is zero', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'Local review passed.', evidenceRefs: [] }),
    ]);
    const originalReason = harness.gateway.reason;
    harness.gateway.reason = async (request, operationKey) => {
      const result = await originalReason(request, operationKey);
      return { ...result, provider: 'ollama', usage: { ...result.usage!, cost: 0 } };
    };
    const originalAct = harness.gateway.act;
    harness.gateway.act = async (request, operationKey) => {
      const result = await originalAct(request, operationKey);
      if (result.action === 'finalize_candidate') return result;
      if (result.action === 'quality_review') {
        return {
          ...result,
          inference: { ...result.inference, provider: 'ollama', usage: { ...result.inference.usage!, cost: 0 } },
          invocation: { ...result.invocation, provider: 'ollama', usage: { ...result.invocation.usage!, cost: 0 } },
        };
      }
      return {
        ...result,
        candidate: { ...result.candidate, provider: 'ollama', usage: { ...result.candidate.usage!, cost: 0 } },
        invocation: { ...result.invocation, provider: 'ollama', usage: { ...result.invocation.usage!, cost: 0 } },
      };
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-zero-cost-local',
      input,
      contextVersion: 1,
      limits: { maxCost: 0 },
    }, harness.gateway);

    expect(result).toMatchObject({ status: 'completed', trace: { usage: { cost: 0 } } });
  });

  it('rejects completion when the final action reports usage above a ceiling', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan(
        [action('review-1', 'model.review_artifact')],
        {
          type: 'completed',
          reason: 'The final review passed but exceeded its execution budget.',
          evidenceRefs: [],
        },
      ),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-over-budget-completion',
      input,
      contextVersion: 1,
      limits: { maxTokens: 75 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'budget_exhausted',
      trace: { usage: { totalTokens: 76 } },
    });
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate',
      'quality_review',
    ]);
  });

  it('blocks when a planning result omits usage instead of treating unknown tokens and cost as zero', async () => {
    const harness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);
    const reason = harness.gateway.reason;
    harness.gateway.reason = async (request, operationKey) => ({
      ...await reason(request, operationKey),
      usage: undefined,
    });

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-missing-plan-usage', input, contextVersion: 1,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'blocked',
      trace: {
        invocations: [expect.objectContaining({ purpose: 'plan', requestId: 'plan-1', usage: undefined })],
      },
    });
    if (result.status === 'waiting_for_human' || result.status === 'completed') {
      throw new Error('Expected missing usage to block execution.');
    }
    expect(result.reason).toContain('token and cost budgets cannot be enforced');
    expect(harness.actionRequests).toEqual([]);
  });

  it('blocks when a non-local planning result reports tokens but omits cost', async () => {
    const harness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);
    const reason = harness.gateway.reason;
    harness.gateway.reason = async (request, operationKey) => ({
      ...await reason(request, operationKey),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-missing-plan-cost', input, contextVersion: 1,
    }, harness.gateway);

    expect(result).toMatchObject({ status: 'blocked' });
    if (result.status === 'waiting_for_human' || result.status === 'completed') {
      throw new Error('Expected missing cost usage to block execution.');
    }
    expect(result.reason).toContain('did not report cost usage');
    expect(harness.actionRequests).toEqual([]);
  });

  it('blocks immediately when an action result omits usage', async () => {
    const harness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);
    const act = harness.gateway.act;
    harness.gateway.act = async (request, operationKey) => {
      const result = await act(request, operationKey);
      if (result.action === 'generate_candidate') {
        result.candidate.usage = undefined;
        result.invocation.usage = undefined;
      }
      return result;
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-missing-action-usage', input, contextVersion: 1,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'blocked',
      trace: {
        usage: { modelCalls: 2, actions: 1 },
        observations: [expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ code: 'MODEL_USAGE_UNAVAILABLE' }),
        })],
      },
    });
    expect(harness.actionRequests).toHaveLength(1);
  });

  it('rechecks wall-clock immediately before starting a planning call', async () => {
    const harness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);
    const ticks = [1_000, 1_000, 2_000];
    let tick = 0;
    harness.gateway.now = () => ticks[Math.min(tick++, ticks.length - 1)]!;

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-wall-clock-before-planning',
      input,
      contextVersion: 1,
      limits: { maxWallClockMs: 1_000 },
    }, harness.gateway);

    expect(result).toMatchObject({ status: 'budget_exhausted' });
    expect(harness.reasoningRequests).toEqual([]);
    expect(harness.actionRequests).toEqual([]);
  });

  it('carries the elapsed wall-clock budget through a human-decision checkpoint', async () => {
    const waitingHarness = gateways([plan([], {
      type: 'human_input_required',
      reason: 'A recorded decision is required before generation.',
      decision: {
        decisionKey: 'requirements.output_depth',
        question: 'How detailed should the output be?',
        options: [
          { value: 'brief', label: 'Brief' },
          { value: 'detailed', label: 'Detailed' },
        ],
        allowCustomAnswer: true,
        allowAgentDecide: true,
      },
    })]);
    const waiting = await executeDynamicArtifactOrder({
      executionId: 'order-wall-clock-resume',
      input,
      contextVersion: 1,
      limits: { maxWallClockMs: 1_000 },
    }, waitingHarness.gateway);
    if (waiting.status !== 'waiting_for_human') throw new Error('Expected a human-decision checkpoint.');
    waiting.checkpoint.elapsedMs = 999;

    const resumedHarness = gateways([plan([action('generate-1', 'model.generate_artifact')])]);
    const ticks = [1_000, 1_000, 1_002];
    let tick = 0;
    resumedHarness.gateway.now = () => ticks[Math.min(tick++, ticks.length - 1)]!;
    const result = await executeDynamicArtifactOrder({
      executionId: waiting.checkpoint.executionId,
      input,
      contextVersion: 1,
      limits: { maxWallClockMs: 1_000 },
      checkpoint: waiting.checkpoint,
    }, resumedHarness.gateway);

    expect(result).toMatchObject({
      status: 'budget_exhausted',
      trace: { usage: { actions: 0 } },
    });
    expect(resumedHarness.actionRequests).toEqual([]);
  });

  it('turns a premature model completion claim into an observation and replans', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([], { type: 'completed', reason: 'Candidate exists.', evidenceRefs: [] }),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'Candidate is reviewed.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-verify', input, contextVersion: 1,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completion.');
    expect(result.trace.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activity: 'control.verify_completion',
        status: 'failed',
        error: expect.objectContaining({ code: 'COMPLETION_CHECK_FAILED' }),
      }),
    ]));
  });

  it('rejects a repeated review until the candidate has materially changed', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([action('review-again', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'The existing review is current.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-repeat-review', input, contextVersion: 1,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completion.');
    expect(result.trace.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted: false,
        validationIssues: expect.arrayContaining([expect.stringContaining('REPEATED_ACTION')]),
      }),
    ]));
    expect(harness.actionRequests.filter((request) => request.action === 'quality_review')).toHaveLength(1);
  });

  it('exposes a model-owned decision as waiting_for_human rather than a technical failure', async () => {
    const decision = {
      decisionKey: 'product.persistence_strategy',
      question: 'Which persistence strategy should this iteration use?',
      options: [
        { value: 'sqlite', label: 'Embedded SQLite' },
        { value: 'postgres', label: 'PostgreSQL' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    } as const;
    const harness = gateways([plan([], {
      type: 'human_input_required',
      reason: 'The persistence choice exceeds this role authority.',
      decision,
    })]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-human', input, contextVersion: 1,
      limits: { maxNoProgressRounds: 1 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'waiting_for_human',
      decision: { decisionKey: decision.decisionKey },
      trace: { status: 'waiting_for_human' },
      checkpoint: { executionId: 'order-human', candidateVersion: 0 },
    });
    expect(harness.actionRequests).toEqual([]);
  });

  it('ignores artifact actions attached to a terminal human decision', async () => {
    const decision = {
      decisionKey: 'manager.charter_questions',
      question: 'How should the unresolved charter questions be handled?',
      options: [
        { value: 'answer_now', label: 'Answer now' },
        { value: 'defer', label: 'Defer' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: false,
    } as const;
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([action('generate-decision-brief', 'model.generate_artifact')], {
        type: 'human_input_required',
        reason: 'The reviewed candidate contains unresolved human questions.',
        decision,
      }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-terminal-human-action',
      input,
      contextVersion: 1,
      discardTerminalControlActions: true,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'waiting_for_human',
      decision: { decisionKey: decision.decisionKey },
    });
    expect(harness.actionRequests.filter((request) =>
      request.action === 'generate_candidate')).toHaveLength(1);
    expect(result.trace.plans.at(-1)).toMatchObject({
      accepted: true,
      actions: [],
      completionType: 'human_input_required',
    });
  });

  it('keeps rejecting repeated generation for a continuing plan', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('generate-again', 'model.generate_artifact')]),
      plan([], {
        type: 'blocked',
        code: 'NO_SAFE_NEXT_STEP',
        reason: 'No safe next step remains.',
      }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-repeat-generation-still-rejected',
      input,
      contextVersion: 1,
      discardTerminalControlActions: true,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('NO_SAFE_NEXT_STEP'),
    });
    expect(result.trace.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted: false,
        validationIssues: expect.arrayContaining([expect.stringContaining('REPEATED_ACTION')]),
      }),
    ]));
    expect(harness.actionRequests.filter((request) =>
      request.action === 'generate_candidate')).toHaveLength(1);
  });

  it('observes one mutating artifact action before planning the next one', async () => {
    const reviewAfterGeneration = action('review-after-generation', 'model.review_artifact');
    reviewAfterGeneration.dependsOn = ['generate-1'];
    const harness = gateways([
      plan([
        action('generate-1', 'model.generate_artifact'),
        reviewAfterGeneration,
      ]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'The candidate passed review.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-serialized-artifact-actions',
      input,
      contextVersion: 1,
      serializeArtifactActions: true,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate',
      'quality_review',
      'finalize_candidate',
    ]);
    expect(result.trace.plans[0]).toMatchObject({
      accepted: true,
      actions: [expect.objectContaining({ id: 'generate-1' })],
      completionType: 'continue',
    });
  });

  it('discards model-authored arguments whose inputs are owned by workflow state', async () => {
    const generate = action('generate-1', 'model.generate_artifact');
    generate.arguments = { candidate: 'planner-controlled content' };
    const harness = gateways([
      plan([generate]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'The candidate passed review.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-workflow-owned-arguments',
      input,
      contextVersion: 1,
      discardModelAuthoredArguments: true,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(result.trace.plans[0]).toMatchObject({ accepted: true });
    expect(harness.actionRequests[0]).toMatchObject({ action: 'generate_candidate' });
  });

  it('strips planner-only keys from otherwise valid human decision options', async () => {
    const decision = {
      decisionKey: 'manager.revision_limit',
      question: 'How should the bounded revision proceed?',
      options: [
        { key: 'target', value: 'target', label: 'Provide targeted feedback' },
        { key: 'defer', value: 'defer', label: 'Defer the decision' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    };
    const harness = gateways([plan([], {
      type: 'human_input_required',
      reason: 'The automated revision budget is exhausted.',
      decision,
    } as never)]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-normalized-decision-options',
      input,
      contextVersion: 1,
      normalizeDecisionOptions: true,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'waiting_for_human',
      decision: {
        options: [
          { value: 'target', label: 'Provide targeted feedback' },
          { value: 'defer', label: 'Defer the decision' },
        ],
      },
    });
  });

  it('normalizes prompt and colon aliases without inventing decision content', async () => {
    const decision = {
      decisionKey: 'decision:approve-charter',
      prompt: 'Should the current charter be approved?',
      options: [
        { value: 'approve', label: 'Approve' },
        { value: 'revise', label: 'Revise' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    };
    const harness = gateways([plan([], {
      type: 'human_input_required',
      reason: 'The current candidate contains unresolved questions.',
      decision,
    } as never)]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-normalized-decision-envelope',
      input,
      contextVersion: 1,
      normalizeDecisionEnvelope: true,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'waiting_for_human',
      decision: {
        decisionKey: 'decision.approve-charter',
        question: 'Should the current charter be approved?',
      },
    });
  });

  it('completes instead of repeating review after the current candidate passed', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([action('review-project-charter-1', 'model.review_artifact')]),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-workflow-owned-completion-transition',
      input,
      contextVersion: 1,
      normalizeArtifactStateTransitions: true,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate',
      'quality_review',
      'finalize_candidate',
    ]);
    expect(result.trace.plans.at(-1)).toMatchObject({
      accepted: true,
      actions: [],
      completionType: 'completed',
    });
  });

  it('synthesizes the one valid state transition when the planner returns empty continue', async () => {
    const harness = gateways([
      plan([]),
      plan([]),
      plan([]),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-workflow-owned-empty-transition',
      input,
      contextVersion: 1,
      normalizeArtifactStateTransitions: true,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate',
      'quality_review',
      'finalize_candidate',
    ]);
  });

  it('revises instead of repeating review after recorded findings', async () => {
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([action('repeat-review', 'model.review_artifact')]),
      plan([action('review-revision', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'The revision passed review.', evidenceRefs: [] }),
    ]);
    const originalAct = harness.gateway.act;
    let reviewCount = 0;
    harness.gateway.act = async (request, operationKey) => {
      const result = await originalAct(request, operationKey);
      if (request.action !== 'quality_review' || reviewCount++ > 0 || result.action !== 'quality_review') return result;
      return {
        ...result,
        review: { status: 'revise', rationale: 'One bounded correction is needed.', findings: ['Clarify scope.'] },
      };
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-workflow-owned-revision-transition',
      input,
      contextVersion: 1,
      normalizeArtifactStateTransitions: true,
    }, harness.gateway);

    expect(result.status).toBe('completed');
    expect(harness.actionRequests.map((request) => request.action)).toEqual([
      'generate_candidate',
      'quality_review',
      'revise_candidate',
      'quality_review',
      'finalize_candidate',
    ]);
  });

  it('binds workflow-owned context metadata while preserving decision acknowledgement checks', async () => {
    const stalePlan = plan([], {
      type: 'blocked',
      code: 'NEEDS_DIRECTION',
      reason: 'The current order needs durable direction.',
    });
    stalePlan.contextVersion = 0;
    const harness = gateways([stalePlan]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-bound-context-version',
      input,
      contextVersion: 7,
      bindPlanningContextVersion: true,
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('NEEDS_DIRECTION'),
    });
    expect(result.trace.plans).toEqual([
      expect.objectContaining({ accepted: true }),
    ]);

    const missingDecision = gateways([stalePlan, stalePlan, stalePlan]);
    const decisionResult = await executeDynamicArtifactOrder({
      executionId: 'order-bound-context-still-checks-decisions',
      input,
      contextVersion: 7,
      requiredDecisionIds: ['decision-1'],
      bindPlanningContextVersion: true,
    }, missingDecision.gateway);
    expect(decisionResult).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('decision-1'),
    });
  });

  it('resumes after a human decision from the recorded candidate instead of regenerating it', async () => {
    const decision = {
      decisionKey: 'requirements.acceptance_depth',
      question: 'Should acceptance evidence include the extended edge-case suite?',
      options: [
        { value: 'core', label: 'Core cases' },
        { value: 'extended', label: 'Extended cases' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    } as const;
    const beforeDecision = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([], {
        type: 'human_input_required',
        reason: 'The requested evidence depth requires product-owner direction.',
        decision,
      }),
    ]);

    const waiting = await executeDynamicArtifactOrder({
      executionId: 'order-resume', input, contextVersion: 1,
    }, beforeDecision.gateway);

    expect(waiting.status).toBe('waiting_for_human');
    if (waiting.status !== 'waiting_for_human') throw new Error('Expected a human-decision checkpoint.');
    expect(waiting.checkpoint).toMatchObject({
      executionId: 'order-resume',
      candidateVersion: 1,
      usage: { planningRounds: 2, actions: 1 },
    });
    expect(waiting.trace.invocations).toEqual(waiting.checkpoint.invocations);

    const decisionId = 'decision:requirements.acceptance_depth';
    const acknowledgedPlan = (
      actions: DynamicExecutionPlan['actions'],
      completionCheck: DynamicExecutionPlan['completionCheck'],
    ): DynamicExecutionPlan => ({
      ...plan(actions, completionCheck),
      acknowledgedDecisionIds: [decisionId],
      contextVersion: 2,
    });
    const afterDecision = gateways([
      acknowledgedPlan(
        [action('review-1', 'model.review_artifact')],
        { type: 'continue', reason: 'Review the retained candidate.' },
      ),
      acknowledgedPlan([], {
        type: 'completed',
        reason: 'The retained candidate passed review with the approved evidence depth.',
        evidenceRefs: [],
      }),
    ]);

    const completed = await executeDynamicArtifactOrder({
      executionId: waiting.checkpoint.executionId,
      input: { ...input, context: `${input.context}\nThe human selected extended cases.` },
      contextVersion: 2,
      requiredDecisionIds: [decisionId],
      checkpoint: waiting.checkpoint,
    }, afterDecision.gateway);

    expect(completed.status).toBe('completed');
    expect(afterDecision.actionRequests.map((request) => request.action)).toEqual([
      'quality_review',
      'finalize_candidate',
    ]);
    if (completed.status !== 'completed') throw new Error('Expected resumed completion.');
    expect(completed.trace).toMatchObject({
      executionId: 'order-resume',
      usage: { planningRounds: 4, actions: 2 },
    });
  });

  it('revises a checkpointed candidate after new human direction invalidates its prior review', async () => {
    const decision = {
      decisionKey: 'requirements.defaults',
      question: 'May the agent fill reasonable defaults?',
      options: [
        { value: 'apply', label: 'Apply reasonable defaults' },
        { value: 'defer', label: 'Leave questions open' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    } as const;
    const beforeDecision = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], {
        type: 'human_input_required',
        reason: 'The approved draft still contains unresolved questions.',
        decision,
      }),
    ]);
    const waiting = await executeDynamicArtifactOrder({
      executionId: 'order-refresh-after-human',
      input,
      contextVersion: 1,
      normalizeArtifactStateTransitions: true,
    }, beforeDecision.gateway);
    if (waiting.status !== 'waiting_for_human') throw new Error('Expected a human-decision checkpoint.');

    const afterDecision = gateways([
      plan([], { type: 'completed', reason: 'The prior review passed.', evidenceRefs: [] }),
      plan([]),
      plan([], { type: 'completed', reason: 'The revised candidate passed review.', evidenceRefs: [] }),
    ]);
    const completed = await executeDynamicArtifactOrder({
      executionId: waiting.checkpoint.executionId,
      input: { ...input, context: `${input.context}\nThe human authorized reasonable defaults.` },
      contextVersion: 30,
      bindPlanningContextVersion: true,
      normalizeArtifactStateTransitions: true,
      refreshCandidateAfterHumanDecision: true,
      checkpoint: waiting.checkpoint,
    }, afterDecision.gateway);

    expect(completed.status).toBe('completed');
    expect(afterDecision.actionRequests.map((request) => request.action)).toEqual([
      'revise_candidate',
      'quality_review',
      'finalize_candidate',
    ]);
    expect(afterDecision.actionRequests[0]?.review).toMatchObject({
      status: 'revise',
      findings: [expect.stringContaining('newly recorded human decision')],
    });
  });

  it('honors an acknowledged human acceptance after the bounded revision limit is exhausted', async () => {
    const decision = {
      decisionKey: 'ux.revision_limit_override',
      question: 'How should we proceed after exhausting the revision limit?',
      options: [
        { value: 'accept', label: 'Accept with documented deviations' },
        { value: 'revise', label: 'Allow another revision' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    } as const;
    const beforeDecision = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([], {
        type: 'human_input_required',
        reason: 'The revision limit requires recorded human direction.',
        decision,
      }),
    ]);
    const waiting = await executeDynamicArtifactOrder({
      executionId: 'order-human-review-waiver',
      input,
      contextVersion: 1,
      normalizeArtifactStateTransitions: true,
    }, beforeDecision.gateway);
    if (waiting.status !== 'waiting_for_human') throw new Error('Expected a human-decision checkpoint.');
    waiting.checkpoint.revisionCount = MAX_DYNAMIC_ARTIFACT_REVISIONS;
    waiting.checkpoint.review = {
      status: 'revise',
      rationale: 'The candidate has documented deviations.',
      findings: ['Defer the remaining UX detail to the backlog.'],
      candidateVersion: waiting.checkpoint.candidateVersion,
    };
    waiting.checkpoint.findings = [{
      findingId: 'quality:1:review-limit:0',
      candidateVersion: waiting.checkpoint.candidateVersion,
      category: 'completeness',
      severity: 'medium',
      ownerRole: 'requirements',
      disposition: 'remediate_current',
      summary: 'A bounded detail remains.',
      evidenceRefs: ['review-limit'],
      raisedByActionId: 'review-limit',
      status: 'open',
    }];
    const decisionId = 'question:ux.revision_limit_override';
    const completedPlan = plan([action('review-waived', 'model.review_artifact')], {
      type: 'continue',
      reason: 'Perform a non-mutating review to document the accepted deviations.',
    });
    completedPlan.acknowledgedDecisionIds = [decisionId];
    const afterDecision = gateways([completedPlan]);
    const originalAct = afterDecision.gateway.act;
    afterDecision.gateway.act = async (request, operationKey) => {
      const result = await originalAct(request, operationKey);
      if (result.action !== 'finalize_candidate') return result;
      return {
        ...result,
        draft: {
          ...result.draft,
          questions: [{
            decisionKey: 'ux.deferred_detail',
            question: 'Which deferred UX detail should be implemented next?',
            options: [{ value: 'later', label: 'Decide from the backlog later' }],
            allowCustomAnswer: true,
            allowAgentDecide: false,
          }],
        },
      };
    };

    const completed = await executeDynamicArtifactOrder({
      executionId: waiting.checkpoint.executionId,
      input: { ...input, context: `${input.context}\nThe human accepted the current candidate with documented deviations.` },
      contextVersion: 2,
      requiredDecisionIds: [decisionId],
      bindPlanningContextVersion: true,
      normalizeArtifactStateTransitions: true,
      refreshCandidateAfterHumanDecision: true,
      honorHumanReviewWaiver: true,
      deferQuestionsAfterHumanReviewWaiver: true,
      checkpoint: waiting.checkpoint,
    }, afterDecision.gateway);

    expect(completed.status).toBe('completed');
    expect(afterDecision.actionRequests.map((request) => request.action)).toEqual(['finalize_candidate']);
    if (completed.status !== 'completed') throw new Error('Expected completion through the human review waiver.');
    expect(completed.draft.questions).toEqual([]);
    expect(completed.trace.findings).toEqual([
      expect.objectContaining({
        status: 'resolved',
        disposition: 'defer_to_next_iteration',
        resolvedByActionId: 'human-decision-review-waiver',
        evidenceRefs: expect.arrayContaining([decisionId]),
      }),
    ]);
  });

  it('does not complete an artifact that still contains an unresolved human question', async () => {
    const decision = {
      decisionKey: 'product.export_format',
      question: 'Which export format should be the default?',
      options: [
        { value: 'pdf', label: 'PDF' },
        { value: 'markdown', label: 'Markdown' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    } as const;
    const harness = gateways([
      plan([action('generate-1', 'model.generate_artifact')]),
      plan([action('review-1', 'model.review_artifact')]),
      plan([], { type: 'completed', reason: 'Reviewed.', evidenceRefs: [] }),
      plan([], {
        type: 'human_input_required',
        reason: 'The artifact question requires human authority.',
        decision,
      }),
    ]);
    const act = harness.gateway.act;
    harness.gateway.act = async (request, operationKey) => {
      const result = await act(request, operationKey);
      if (result.action === 'finalize_candidate') result.draft.questions = [decision];
      return result;
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-unresolved-question', input, contextVersion: 1,
    }, harness.gateway);

    expect(result).toMatchObject({ status: 'waiting_for_human' });
    expect(result.trace.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        activity: 'control.verify_completion',
        error: expect.objectContaining({
          code: 'COMPLETION_CHECK_FAILED',
          message: expect.stringContaining('unresolved human question'),
        }),
      }),
    ]));
  });

  it('blocks after the configured number of invalid-plan repairs', async () => {
    const malformed = '{not-json';
    const harness = gateways([malformed, malformed]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-invalid', input, contextVersion: 1,
      limits: { maxPlanRepairAttempts: 1 },
    }, harness.gateway);

    expect(result).toMatchObject({ status: 'blocked' });
    if (result.status === 'waiting_for_human' || result.status === 'completed') {
      throw new Error('Expected a blocked result.');
    }
    expect(result.reason).toContain('Plan validation failed after 1 repair attempt');
    expect(harness.actionRequests).toEqual([]);
  });

  it('applies the repair cap per planning round while retaining cumulative audit usage', async () => {
    const unknown = (id: string) => plan([{
      ...action(id, 'model.generate_artifact'),
      activity: 'system.shell',
    }]);
    const harness = gateways([
      unknown('invalid-generate'),
      plan([action('generate-1', 'model.generate_artifact')]),
      unknown('invalid-review'),
      plan([action('review-1', 'model.review_artifact')]),
      '{malformed',
      plan([], { type: 'completed', reason: 'Reviewed.', evidenceRefs: [] }),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-repair-per-round',
      input,
      contextVersion: 1,
      limits: { maxPlanRepairAttempts: 1 },
    }, harness.gateway);

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completion.');
    expect(result.trace.usage.planRepairAttempts).toBe(3);
  });

  it('rejects oversized capability results before they enter workflow state', async () => {
    const harness = gateways([
      plan([action('generate-large', 'model.generate_artifact')]),
      plan([], { type: 'blocked', reason: 'The bounded generation activity failed.' }),
    ]);
    const act = harness.gateway.act;
    harness.gateway.act = async (request, operationKey) => {
      const result = await act(request, operationKey);
      if (result.action === 'generate_candidate') {
        result.candidate.content = 'x'.repeat(1_000_001);
      }
      return result;
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-large-result', input, contextVersion: 1,
    }, harness.gateway);

    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.trace.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: 'generate-large',
        status: 'failed',
        error: expect.objectContaining({
          code: 'ACTIVITY_FAILED',
          message: expect.stringContaining('result limit'),
        }),
      }),
    ]));
  });

  it('terminates a no-progress loop as budget_exhausted', async () => {
    const harness = gateways([
      plan([]),
      plan([]),
    ]);

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-no-progress', input, contextVersion: 1,
      limits: { maxNoProgressRounds: 2 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'budget_exhausted',
      trace: { status: 'budget_exhausted', usage: { planningRounds: 2 } },
    });
  });

  it('does not count failed actions as material progress', async () => {
    const harness = gateways([
      plan([action('generate-failed-1', 'model.generate_artifact')]),
      plan([action('generate-failed-2', 'model.generate_artifact')]),
    ]);
    harness.gateway.act = async (request) => {
      harness.actionRequests.push(request);
      throw new Error('Provider unavailable.');
    };

    const result = await executeDynamicArtifactOrder({
      executionId: 'order-failed-no-progress', input, contextVersion: 1,
      limits: { maxNoProgressRounds: 2 },
    }, harness.gateway);

    expect(result).toMatchObject({
      status: 'budget_exhausted',
      trace: { usage: { planningRounds: 2, actions: 2, modelCalls: 4 } },
    });
  });
});
