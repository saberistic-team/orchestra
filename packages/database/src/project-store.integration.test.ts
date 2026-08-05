import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  agentRoleSchema,
  canonicalDynamicJson,
  defaultDynamicExecutionLimits,
  emptyDynamicExecutionUsage,
  type AgentOrder,
  type AgentMessage,
  type DynamicExecutionTrace,
  type IterationReviewProposal,
} from '@orchestra/contracts';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStore } from './index.js';

function gateLedgerOrder(orderId: string, iterationId: string): AgentOrder {
  return {
    orderId,
    type: 'EVALUATE_GATE',
    objective: 'Evaluate the immutable candidate against every required evidence source.',
    scope: {
      included: [iterationId],
      excluded: [],
      affectedComponents: [],
      workPackageRefs: ['gate-decision'],
    },
    expectedOutputs: [{
      artifactType: 'gate-decision',
      description: 'A structured Gate decision.',
      required: true,
      ownerRole: 'gate',
    }],
    acceptanceCriteria: [{
      criterionId: `${orderId}:deterministic-readiness`,
      description: 'The parent workflow independently confirms complete evidence.',
      mandatory: true,
      requirementRefs: ['test-evidence', 'review-decision'],
      verificationMethod: 'Deterministic parent readiness check',
    }],
    requiredEvidence: [{
      evidenceType: 'TEST',
      description: 'Revision-bound executable test evidence.',
      required: true,
      subjectRefs: ['test-evidence'],
    }],
    dependencies: [],
    constraints: { allowedTools: ['model.review_artifact'] },
    loopPolicy: {
      mode: 'GATING',
      reasoningDepth: 'STANDARD',
      evidenceStrength: 'STRICT',
      requiredCollaborators: [],
      optionalCollaborators: [],
      maxParallelActions: 1,
      maxIterations: 2,
      maxRemediationRounds: 1,
      requiredApprovals: [],
      requiredGates: [],
      onMissingInformation: 'BLOCK',
      onConflict: 'BLOCK',
      onFailure: 'REPLAN',
      interruptionPolicy: 'SAFE_BOUNDARY',
    },
    authority: {
      grantId: `${orderId}:authority`,
      issuerRole: 'manager',
      level: 'ITERATION',
      permittedActions: ['EVALUATE_GATE'],
      permittedTargets: ['gate'],
      scopeRefs: [iterationId],
      mayDelegate: false,
    },
    sourceArtifactVersions: [],
    priority: 'HIGH',
  };
}

describe('ProjectStore integration', () => {
  let container: StartedPostgreSqlContainer;
  let store: ProjectStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      'postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15',
    ).start();
    store = new ProjectStore(container.getConnectionUri());
    await store.migrate('packages/database/drizzle');
  });

  afterAll(async () => {
    await store?.close();
    await container?.stop();
  });

  it('round-trips a project through PostgreSQL', async () => {
    const created = await store.create({
      name: 'Orchestra',
      intent: 'Help a person build software from their intentions.',
      audience: 'Non-technical founders',
      success: 'A reviewed first release is produced safely.',
      constraints: ['Self-hostable'],
    });
    await expect(store.find(created.id)).resolves.toEqual(created);
    const detail = await store.detail(created.id);
    expect(detail?.iterations).toHaveLength(1);
    expect(detail?.artifacts[0]).toMatchObject({ type: 'project-intent', status: 'ready_for_review' });
    expect(detail?.events[0].title).toBe('Project studio opened');
    const iteration = detail?.iterations[0];
    if (!iteration) throw new Error('Expected initial iteration.');
    await expect(store.addArtifact(created.id, iteration.id, {
      type: 'requirements-baseline',
      name: 'Requirements baseline',
      content: '# Requirements',
      mimeType: 'text/markdown',
      producedBy: 'requirements',
      model: 'qwen/qwen3.5-27b',
      modelProvider: 'openrouter',
      modelInvocations: [{
        provider: 'openrouter',
        model: 'qwen/qwen3.5-27b',
        purpose: 'generate',
        round: 0,
        requestId: 'generation-123',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.002 },
      }],
      executionTrace: {
        protocolVersion: '1',
        executionId: 'requirements-order-1',
        status: 'completed',
        terminalReason: 'Deterministic completion checks passed.',
        limits: defaultDynamicExecutionLimits,
        usage: emptyDynamicExecutionUsage,
        plans: [],
        observations: [],
        invocations: [{
          provider: 'openrouter',
          model: 'qwen/qwen3.5-27b',
          purpose: 'generate',
          round: 0,
          requestId: 'generation-123',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.002 },
        }],
        findings: [],
        verification: {
          passed: true,
          checks: [{
            name: 'artifact_exists',
            passed: true,
            evidenceRefs: [],
            reason: 'The artifact was persisted.',
          }],
        },
      },
    })).resolves.toMatchObject({
      modelProvider: 'openrouter',
      modelInvocations: [expect.objectContaining({ requestId: 'generation-123', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.002 } })],
      executionTrace: expect.objectContaining({ executionId: 'requirements-order-1', status: 'completed' }),
    });
    const projects = await store.list();
    expect(projects[0]).toMatchObject({ id: created.id, artifactCount: 2 });
  });

  it('idempotently supersedes the active review proposal when human guidance reopens an iteration', async () => {
    const project = await store.create({
      name: 'Review supersession studio',
      intent: 'Ensure later human direction invalidates the pending delivery candidate.',
      audience: 'Delivery reviewers',
      success: 'A superseded candidate can no longer report Gate pass.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const agentPositions = Object.fromEntries(agentRoleSchema.options.map((role) => [
      role,
      role === 'deployment' || role === 'validation' ? 'not_required' : 'ready',
    ])) as IterationReviewProposal['agentPositions'];
    await store.recordIterationReviewProposal({
      projectId: project.id,
      iterationId: iteration.id,
      iterationNumber: iteration.number,
      includedRevision: 'a'.repeat(40),
      objectiveStatus: 'satisfied',
      completedOutcomes: ['The bounded iteration outcome is complete.'],
      openFindings: [],
      agentPositions,
      gateStatus: 'pass',
      gateRationale: 'All required evidence is traceable.',
      managerRationale: 'The candidate is ready for human review.',
      recommendation: 'send_for_human_review',
      knownLimitations: [],
      budgetSnapshot: {
        modelInvocationCount: 1,
        totalTokens: 10,
        openRouterCostUsd: 0,
        repositoryOperationCount: 1,
        activeMutationCount: 0,
      },
      correlationId: `iteration:${iteration.number}:review`,
      operationKey: `iteration:${iteration.id}:review-proposal:1`,
    });

    await expect(store.supersedeIterationReviewProposal(project.id, iteration.number)).resolves.toBe(true);
    await expect(store.supersedeIterationReviewProposal(project.id, iteration.number)).resolves.toBe(true);
    expect((await store.detail(project.id))?.iterationReviewProposals).toEqual([
      expect.objectContaining({ status: 'superseded', gateStatus: 'pass' }),
    ]);
  });

  it('reopens a completed logical order when parent verification blocks and safely completes it after retry', async () => {
    const project = await store.create({
      name: 'Parent verification ledger',
      intent: 'Keep Gate completion truthful across deterministic parent verification.',
      audience: 'Delivery operators',
      success: 'No failed parent check leaves a satisfied Gate obligation.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const order = gateLedgerOrder(`${project.id}:i1:run1:gate`, iteration.id);
    const correlationId = 'iteration:1:gate';
    const revision = 'a'.repeat(40);

    await store.recordAgentOrderLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      correlationId,
      revision,
    );
    let detail = await store.detail(project.id);
    expect(detail?.agentGoals.filter((goal) => goal.role === 'gate')).toEqual([
      expect.objectContaining({ status: 'active', completedAt: null }),
    ]);
    expect(detail?.agentObligations.filter((obligation) => obligation.ownerRole === 'gate'))
      .toHaveLength(3);

    await store.recordAgentExecutionLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      'completed',
      undefined,
      ['gate-artifact-1'],
      correlationId,
      revision,
    );
    detail = await store.detail(project.id);
    expect(detail?.agentGoals.find((goal) => goal.role === 'gate')).toMatchObject({
      status: 'satisfied',
      completedAt: expect.any(String),
    });
    expect(detail?.agentObligations.filter((obligation) => obligation.ownerRole === 'gate'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'satisfied',
          satisfactionEvidence: ['gate-artifact-1'],
          satisfiedAt: expect.any(String),
        }),
      ]));

    const parentFailure = 'Required upstream artifact is absent: review-decision';
    for (let replay = 0; replay < 2; replay += 1) {
      await store.recordAgentExecutionLedger(
        project.id,
        iteration.id,
        'gate',
        order,
        'blocked',
        undefined,
        [],
        correlationId,
        revision,
        parentFailure,
      );
    }
    detail = await store.detail(project.id);
    expect(detail?.agentGoals.filter((goal) => goal.role === 'gate')).toEqual([
      expect.objectContaining({ status: 'blocked', completedAt: null }),
    ]);
    expect(detail?.agentActionPlans.find((plan) => plan.role === 'gate')).toMatchObject({
      status: 'blocked',
      completedAt: null,
    });
    const blockedObligations = detail?.agentObligations.filter((obligation) => obligation.ownerRole === 'gate') ?? [];
    expect(blockedObligations).toHaveLength(3);
    expect(blockedObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'blocked',
        satisfactionEvidence: [],
        disposition: parentFailure,
        satisfiedAt: null,
      }),
    ]));

    await store.recordAgentExecutionLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      'completed',
      undefined,
      ['gate-artifact-2'],
      correlationId,
      revision,
    );
    detail = await store.detail(project.id);
    expect(detail?.agentGoals.find((goal) => goal.role === 'gate')).toMatchObject({
      status: 'satisfied',
      completedAt: expect.any(String),
    });
    expect(detail?.agentObligations.filter((obligation) => obligation.ownerRole === 'gate'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'satisfied',
          satisfactionEvidence: ['gate-artifact-2'],
          disposition: null,
          satisfiedAt: expect.any(String),
        }),
      ]));
  });

  it('idempotently projects dynamic quality findings and preserves their resolution lifecycle', async () => {
    const project = await store.create({
      name: 'Quality finding ledger',
      intent: 'Project durable quality findings without duplicating activity replays.',
      audience: 'Delivery operators',
      success: 'Open and resolved findings retain one canonical identity.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const order = gateLedgerOrder(`${project.id}:i1:quality`, iteration.id);
    const correlationId = 'iteration:1:gate:quality';
    const revision = 'b'.repeat(40);
    const openTrace: DynamicExecutionTrace = {
      protocolVersion: '1',
      executionId: order.orderId,
      status: 'blocked',
      terminalReason: 'A review finding still requires remediation.',
      limits: defaultDynamicExecutionLimits,
      usage: emptyDynamicExecutionUsage,
      plans: [],
      observations: [],
      invocations: [],
      findings: [{
        findingId: 'quality:1:review-1:0',
        candidateVersion: 1,
        category: 'traceability',
        severity: 'medium',
        ownerRole: 'gate',
        disposition: 'remediate_current',
        summary: 'Cite the immutable test evidence used by the decision.',
        evidenceRefs: [`${order.orderId}/round/2/action/review-1/model.review_artifact@1.0`],
        raisedByActionId: 'review-1',
        status: 'open',
      }],
    };

    for (let replay = 0; replay < 2; replay += 1) {
      await store.recordAgentExecutionLedger(
        project.id,
        iteration.id,
        'gate',
        order,
        'blocked',
        openTrace,
        [],
        correlationId,
        revision,
      );
    }

    let projected = (await store.detail(project.id))?.findings.filter((finding) =>
      finding.correlationId === correlationId && finding.category === 'traceability') ?? [];
    expect(projected).toEqual([expect.objectContaining({
      raisedByRole: 'gate',
      ownerRole: 'gate',
      severity: 'medium',
      status: 'open',
      disposition: 'remediate_current',
      subjectReferences: ['candidate:1'],
      evidenceReferences: openTrace.findings[0]?.evidenceRefs,
      sourceRevision: revision,
      resolvedAt: null,
    })]);

    const resolvedTrace: DynamicExecutionTrace = {
      ...openTrace,
      status: 'completed',
      terminalReason: 'The revised candidate passed independent review.',
      findings: [{
        ...openTrace.findings[0]!,
        status: 'resolved',
        evidenceRefs: [...openTrace.findings[0]!.evidenceRefs, `${order.orderId}/round/3/action/revise-1/model.revise_artifact@1.0`],
        resolvedByActionId: 'revise-1',
        resolvedInCandidateVersion: 2,
      }],
    };
    await store.recordAgentExecutionLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      'completed',
      resolvedTrace,
      ['gate-decision-1'],
      correlationId,
      revision,
    );

    projected = (await store.detail(project.id))?.findings.filter((finding) =>
      finding.correlationId === correlationId && finding.category === 'traceability') ?? [];
    expect(projected).toEqual([expect.objectContaining({
      status: 'resolved',
      resolvedAt: expect.any(String),
      evidenceReferences: resolvedTrace.findings[0]?.evidenceRefs,
    })]);
  });

  it('persists accepted trace plans completed in the same ledger transaction', async () => {
    const project = await store.create({
      name: 'Completed trace plan timestamps',
      intent: 'Persist a completed trace plan without relying on database clock precision.',
      audience: 'Delivery operators',
      success: 'Created and completed timestamps satisfy the plan lifecycle constraint.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const order = gateLedgerOrder('completed-trace-plan-order', iteration.id);
    await store.recordAgentOrderLedger(project.id, iteration.id, 'gate', order, 'iteration:1:gate');
    const trace: DynamicExecutionTrace = {
      executionId: 'completed-trace-plan-execution',
      status: 'completed',
      terminalReason: 'The candidate passed review.',
      limits: defaultDynamicExecutionLimits,
      usage: emptyDynamicExecutionUsage,
      plans: [{
        round: 1,
        repairAttempt: 0,
        goalAssessment: 'The reviewed candidate is ready.',
        actions: [{
          id: 'review-1',
          activity: 'model.review_artifact',
          activityVersion: '1.0',
          dependsOn: [],
          reason: 'Review the retained candidate.',
        }],
        completionType: 'completed',
        accepted: true,
        validationIssues: [],
      }],
      observations: [],
      invocations: [],
      findings: [],
    };

    await expect(store.recordAgentExecutionLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      'completed',
      trace,
      ['gate-decision-1'],
      'iteration:1:gate',
    )).resolves.toBeUndefined();
    await expect(store.recordAgentExecutionLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      'completed',
      {
        ...trace,
        plans: trace.plans.map((plan) => ({
          ...plan,
          actions: plan.actions.map((action) => ({
            ...action,
            id: 'review-2',
            reason: 'Project the replayed action into the same stable plan position.',
          })),
        })),
      },
      ['gate-decision-1'],
      'iteration:1:gate',
    )).resolves.toBeUndefined();
    expect((await store.detail(project.id))?.agentActionPlans).toContainEqual(expect.objectContaining({
      role: 'gate',
      status: 'completed',
      completedAt: expect.any(String),
    }));
    expect((await store.detail(project.id))?.agentActions.filter((action) => action.role === 'gate')).toEqual([
      expect.objectContaining({
        position: 0,
        summary: 'Project the replayed action into the same stable plan position.',
      }),
    ]);
  });

  it('audits model invocations for every dynamic terminal state without duplicating resumed completion', async () => {
    const project = await store.create({
      name: 'Dynamic invocation audit',
      intent: 'Retain provider usage even when a dynamic execution does not produce an artifact.',
      audience: 'Delivery operators',
      success: 'Every terminal execution state has an idempotent model invocation record.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const order = gateLedgerOrder(`${project.id}:i1:invocation-audit`, iteration.id);
    const correlationId = 'iteration:1:gate:invocation-audit';
    const invocationTrace = (
      executionId: string,
      status: DynamicExecutionTrace['status'],
    ): DynamicExecutionTrace => ({
      protocolVersion: '1',
      executionId,
      status,
      terminalReason: `Execution reached ${status}.`,
      limits: defaultDynamicExecutionLimits,
      usage: {
        ...emptyDynamicExecutionUsage,
        modelCalls: 1,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cost: 0.001,
      },
      plans: [],
      observations: [],
      invocations: [{
        provider: 'openrouter',
        model: 'audit/model',
        purpose: 'plan',
        round: 1,
        requestId: `${executionId}:request`,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.001 },
      }],
      findings: [],
    });

    const waitingTrace = invocationTrace('audit-waiting', 'waiting_for_human');
    const resumedTrace = invocationTrace('audit-resumed', 'waiting_for_human');
    const blockedTrace = invocationTrace('audit-blocked', 'blocked');
    const exhaustedTrace = invocationTrace('audit-exhausted', 'budget_exhausted');
    for (const trace of [waitingTrace, resumedTrace, blockedTrace, exhaustedTrace]) {
      for (let replay = 0; replay < 2; replay += 1) {
        await store.recordAgentExecutionLedger(
          project.id,
          iteration.id,
          'gate',
          order,
          trace.status,
          trace,
          [],
          correlationId,
        );
      }
    }

    const completedTrace: DynamicExecutionTrace = {
      ...resumedTrace,
      status: 'completed',
      terminalReason: 'The resumed execution completed.',
    };
    const completedArtifact = await store.addArtifact(project.id, iteration.id, {
      type: 'gate-decision',
      name: 'Gate decision',
      content: '# Gate\n\nPassed.',
      mimeType: 'text/markdown',
      producedBy: 'gate',
      model: 'audit/model',
      modelProvider: 'openrouter',
      modelInvocations: completedTrace.invocations,
      executionTrace: completedTrace,
    }, iteration.number, 'audit-resumed/artifact-commit');
    await store.recordAgentExecutionLedger(
      project.id,
      iteration.id,
      'gate',
      order,
      'completed',
      completedTrace,
      [completedArtifact.id],
      correlationId,
    );

    const audited = (await store.detail(project.id))?.modelInvocations?.filter((invocation) =>
      invocation.correlationId === correlationId || invocation.externalRequestId === 'audit-resumed:request') ?? [];
    expect(audited).toHaveLength(4);
    expect(audited).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalRequestId: 'audit-waiting:request',
        totalTokens: 15,
        responseMetadata: { dynamicTerminalStatus: 'waiting_for_human' },
      }),
      expect.objectContaining({
        externalRequestId: 'audit-resumed:request',
        responseMetadata: { dynamicTerminalStatus: 'completed' },
      }),
      expect.objectContaining({
        externalRequestId: 'audit-blocked:request',
        responseMetadata: { dynamicTerminalStatus: 'blocked' },
      }),
      expect.objectContaining({
        externalRequestId: 'audit-exhausted:request',
        responseMetadata: { dynamicTerminalStatus: 'budget_exhausted' },
      }),
    ]));
  });

  it('returns one artifact version and event for concurrent operation-key replays', async () => {
    const project = await store.create({
      name: 'Artifact replay studio',
      intent: 'Make retried activity completion safe.',
      audience: 'Workflow operators',
      success: 'One operation produces one artifact version.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const draft = {
      type: 'requirements-baseline',
      name: 'Requirements baseline',
      content: '# Requirements\n\nRetry-safe.',
      mimeType: 'text/markdown' as const,
      producedBy: 'requirements' as const,
      model: 'qwen3.5:9b',
      modelInvocations: [{
        provider: 'ollama' as const,
        model: 'qwen3.5:9b',
        purpose: 'plan' as const,
        round: 1,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0 },
      }],
    };
    const operationKey = 'agent-order-42:record:artifact:0';
    const operationManifestHash = `sha256:${createHash('sha256').update(canonicalDynamicJson(draft)).digest('hex')}`;
    const persistence = {
      operationManifestHash,
      modelInvocationOperationPrefix: 'agent-order-42:record',
      operationPayload: draft,
      stageForRepository: true,
      storage: 'repository' as const,
    };

    const [first, replay] = await Promise.all([
      store.addArtifact(project.id, iteration.id, draft, iteration.number, operationKey, persistence),
      store.addArtifact(project.id, iteration.id, draft, iteration.number, operationKey, persistence),
    ]);

    expect(replay).toEqual(first);
    expect(first.version).toBe(1);
    expect(first).toMatchObject({ status: 'draft', repositoryPath: null, executionTrace: undefined });
    await expect(store.loadArtifactOperationDraft(project.id, operationKey)).resolves.toEqual(draft);
    let detail = await store.detail(project.id);
    expect(detail?.artifacts.filter((artifact) => artifact.type === draft.type)).toEqual([first]);
    expect(detail?.events.filter((event) => event.title === 'Requirements baseline is ready')).toHaveLength(0);

    const completed = await store.locateArtifact(
      first.id,
      'artifacts/iteration-01/01-requirements-requirements-baseline.md',
      'https://forgejo.example/artifact',
      { iterationNumber: iteration.number, eventOperationKey: `${operationKey}:event` },
    );
    expect(completed).toMatchObject({ status: 'ready_for_review', repositoryPath: expect.any(String) });
    detail = await store.detail(project.id);
    expect(detail?.events.filter((event) => event.title === 'Requirements baseline is ready')).toHaveLength(1);

    const completedReplay = await store.addArtifact(
      project.id,
      iteration.id,
      draft,
      iteration.number,
      operationKey,
      persistence,
    );
    expect(completedReplay).toEqual(completed);
    await expect(store.addArtifact(project.id, iteration.id, {
      ...draft,
      content: '# Different payload',
    }, iteration.number, operationKey, persistence)).rejects.toThrow(
      'Artifact operation agent-order-42:record:artifact:0 was already used with a different payload.',
    );
    await expect(store.addArtifact(
      project.id,
      iteration.id,
      draft,
      iteration.number,
      operationKey,
      { ...persistence, operationManifestHash: `sha256:${'b'.repeat(64)}` },
    )).rejects.toThrow('already used with a different payload');

    const boundEnvelope = {
      iterationId: iteration.id,
      type: 'product-scope',
      producedBy: 'product' as const,
      storage: 'ledger' as const,
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    };
    const boundDraft = {
      ...draft,
      type: boundEnvelope.type,
      name: 'Product scope',
      producedBy: boundEnvelope.producedBy,
    };
    const boundOperationKey = 'agent-order-bound:record:artifact:0';
    const boundHash = `sha256:${createHash('sha256')
      .update(canonicalDynamicJson({ draft: boundDraft, envelope: boundEnvelope }))
      .digest('hex')}`;
    const boundArtifact = await store.addArtifact(
      project.id,
      iteration.id,
      boundDraft,
      iteration.number,
      boundOperationKey,
      {
        operationManifestHash: boundHash,
        operationPayload: boundDraft,
        storage: boundEnvelope.storage,
        sourceRevision: boundEnvelope.sourceRevision,
      },
    );
    await expect(store.loadArtifactOperationDraft(
      project.id,
      boundOperationKey,
      boundEnvelope,
    )).resolves.toEqual(boundDraft);
    await expect(store.loadArtifactOperationDraft(project.id, boundOperationKey, {
      ...boundEnvelope,
      sourceRevision: 'fedcba9876543210fedcba9876543210fedcba98',
    })).rejects.toThrow('does not match its requested recovery envelope');
    await store.rejectArtifacts(project.id, [boundArtifact.id]);
    await expect(store.loadArtifactOperationDraft(
      project.id,
      boundOperationKey,
      boundEnvelope,
    )).resolves.toBeUndefined();
    const rejectedDetail = await store.detail(project.id);
    expect(rejectedDetail?.artifacts.find((artifact) => artifact.id === boundArtifact.id)?.status)
      .toBe('superseded');
    expect(rejectedDetail?.artifactVersions?.find((version) => version.artifactId === boundArtifact.id)?.status)
      .toBe('superseded');

    await store.addArtifact(project.id, iteration.id, {
      ...draft,
      type: 'product-scope',
      name: 'Product scope',
      producedBy: 'product',
    }, iteration.number, 'agent-order-43:record:artifact:0', {
      operationManifestHash: `sha256:${'c'.repeat(64)}`,
      modelInvocationOperationPrefix: 'agent-order-43:record',
    });
    await expect(store.loadArtifactOperationDraft(
      project.id,
      'agent-order-43:record:artifact:0',
    )).rejects.toThrow('missing its recovery snapshot');
    detail = await store.detail(project.id);
    expect(detail?.modelInvocations?.filter((invocation) => invocation.purpose === 'plan')).toHaveLength(3);
  });

  it('transitions durable agent messages monotonically', async () => {
    const project = await store.create({
      name: 'Message transition studio',
      intent: 'Keep delivery and acknowledgement state durable across workflow retries.',
      audience: 'Delivery operators',
      success: 'Message state advances monotonically and terminal outcomes stay static.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const message: AgentMessage = {
      schemaVersion: '1.0',
      messageId: 'message-transition-1',
      idempotencyKey: 'message-transition-1',
      projectId: project.id,
      iterationId: iteration.id,
      correlationId: 'message-transition-thread',
      sender: {
        projectId: project.id,
        role: 'planner',
        workflowId: `project/${project.id}/agent/planner`,
      },
      recipients: ['builder', 'test'].map((role) => ({
        projectId: project.id,
        role: role as 'builder' | 'test',
        workflowId: `project/${project.id}/agent/${role}`,
      })),
      kind: 'STATUS',
      name: 'order.ready',
      priority: 'NORMAL',
      graphVersion: 1,
      projectStateVersion: 1,
      senderStateVersion: 1,
      authority: {
        grantId: 'message-transition-grant',
        issuerRole: 'planner',
        level: 'ITERATION',
        permittedActions: ['STATUS'],
        permittedTargets: ['builder', 'test'],
        scopeRefs: [iteration.id],
        mayDelegate: false,
      },
      payload: { summary: 'The bounded order is ready.' },
      acknowledgementRequired: true,
      createdAt: new Date().toISOString(),
    };

    await expect(store.recordAgentMessage(message)).resolves.toMatchObject({
      messageId: message.messageId,
      status: 'pending',
      live: true,
    });
    await expect(store.transitionAgentMessage(project.id, message.idempotencyKey, 'delivered', 'builder'))
      .resolves.toMatchObject({ status: 'pending', live: true });
    await expect(store.transitionAgentMessage(project.id, message.idempotencyKey, 'acknowledged', 'builder'))
      .resolves.toMatchObject({ status: 'pending', live: true });
    await expect(store.transitionAgentMessage(project.id, message.idempotencyKey, 'delivered', 'test'))
      .resolves.toMatchObject({ status: 'pending', live: true });
    await expect(store.transitionAgentMessage(project.id, message.idempotencyKey, 'completed', 'test'))
      .resolves.toMatchObject({ status: 'acknowledged', live: false });
    await expect(store.transitionAgentMessage(project.id, message.idempotencyKey, 'completed', 'builder'))
      .resolves.toMatchObject({ status: 'completed', live: false });
    await expect(store.transitionAgentMessage(project.id, message.idempotencyKey, 'failed'))
      .resolves.toMatchObject({ status: 'completed', live: false });

    await store.recordAgentMessage({
      ...message,
      messageId: 'message-transition-2',
      idempotencyKey: 'message-transition-2',
    });
    await expect(store.transitionAgentMessage(project.id, 'message-transition-2', 'failed'))
      .resolves.toMatchObject({ status: 'blocked', live: false });
  });

  it('rejects unknown causation and topic replies beyond the durable response-depth budget', async () => {
    const project = await store.create({
      name: 'Bounded topic studio',
      intent: 'Keep agent discussion useful without allowing recursive reply storms.',
      audience: 'Delivery operators',
      success: 'Every reply has a durable parent and bounded response depth.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const base: AgentMessage = {
      schemaVersion: '1.0',
      messageId: 'bounded-topic-0',
      idempotencyKey: 'bounded-topic-0',
      projectId: project.id,
      iterationId: iteration.id,
      correlationId: 'bounded-topic-thread',
      sender: {
        projectId: project.id,
        role: 'planner',
        workflowId: `project/${project.id}/agent/planner`,
      },
      recipients: [{
        projectId: project.id,
        role: 'builder',
        workflowId: `project/${project.id}/agent/builder`,
      }],
      kind: 'STATUS',
      name: 'topic.update',
      priority: 'NORMAL',
      graphVersion: 1,
      projectStateVersion: 1,
      senderStateVersion: 1,
      authority: {
        grantId: 'bounded-topic-grant',
        issuerRole: 'planner',
        level: 'ITERATION',
        permittedActions: ['STATUS'],
        permittedTargets: ['builder'],
        scopeRefs: [iteration.id],
        mayDelegate: false,
      },
      payload: { summary: 'Bounded topic update.' },
      acknowledgementRequired: false,
      createdAt: new Date().toISOString(),
    };

    await expect(store.recordAgentMessage({
      ...base,
      messageId: 'bounded-topic-unknown',
      idempotencyKey: 'bounded-topic-unknown',
      causationId: 'missing-parent',
    })).rejects.toThrow('references unknown causation');

    await store.recordAgentMessage(base);
    let parentMessageId = base.messageId;
    for (let depth = 1; depth <= 8; depth += 1) {
      const messageId = `bounded-topic-${depth}`;
      await expect(store.recordAgentMessage({
        ...base,
        messageId,
        idempotencyKey: messageId,
        causationId: parentMessageId,
      })).resolves.toMatchObject({ messageId });
      parentMessageId = messageId;
    }
    await expect(store.recordAgentMessage({
      ...base,
      messageId: 'bounded-topic-9',
      idempotencyKey: 'bounded-topic-9',
      causationId: parentMessageId,
    })).rejects.toThrow('exceeds topic response depth 8');
    await expect(store.listAgentMessages(project.id)).resolves.toHaveLength(9);
  });

  it('applies a durable cooldown to repeated semantic findings', async () => {
    const project = await store.create({
      name: 'Finding cooldown studio',
      intent: 'Prevent persistent actors from amplifying the same finding into a message storm.',
      audience: 'Delivery operators',
      success: 'A repeated finding is suppressed until its cooldown expires.',
      constraints: [],
    });
    const iteration = (await store.detail(project.id))?.iterations[0];
    if (!iteration) throw new Error('Expected an initial iteration.');
    const createdAt = new Date();
    const finding: AgentMessage = {
      schemaVersion: '1.0',
      messageId: 'finding-cooldown-1',
      idempotencyKey: 'finding-cooldown-1',
      projectId: project.id,
      iterationId: iteration.id,
      correlationId: 'authentication-session-policy',
      sender: {
        projectId: project.id,
        role: 'security',
        workflowId: `project/${project.id}/agent/security`,
      },
      recipients: [{
        projectId: project.id,
        role: 'builder',
        workflowId: `project/${project.id}/agent/builder`,
      }],
      kind: 'FINDING',
      name: 'authentication.session_policy_missing',
      priority: 'HIGH',
      graphVersion: 1,
      projectStateVersion: 1,
      senderStateVersion: 1,
      authority: {
        grantId: 'finding-cooldown-grant',
        issuerRole: 'security',
        level: 'ITERATION',
        permittedActions: ['FINDING'],
        permittedTargets: ['builder'],
        scopeRefs: [iteration.id],
        mayDelegate: false,
      },
      payload: { summary: 'The current implementation does not define session expiry.' },
      acknowledgementRequired: true,
      createdAt: createdAt.toISOString(),
    };

    await expect(store.recordAgentMessage(finding)).resolves.toMatchObject({ kind: 'finding' });
    await expect(store.recordAgentMessage({
      ...finding,
      messageId: 'finding-cooldown-2',
      idempotencyKey: 'finding-cooldown-2',
      createdAt: new Date(createdAt.getTime() + 1_000).toISOString(),
    })).rejects.toThrow('inside the 30-second repeat cooldown');
    await expect(store.recordAgentMessage({
      ...finding,
      messageId: 'finding-cooldown-3',
      idempotencyKey: 'finding-cooldown-3',
      createdAt: new Date(createdAt.getTime() + 31_000).toISOString(),
    })).resolves.toMatchObject({ kind: 'finding' });
  });

  it('durably records questions, comments, exhaustive review feedback, and repository lifecycle', async () => {
    const project = await store.create({
      name: 'Human review studio',
      intent: 'Keep every consequential delivery decision visible and reviewable by a person.',
      audience: 'Project owners and delivery teams',
      success: 'Questions and structured review direction survive workflow restarts.',
      constraints: [],
    });
    const initial = await store.detail(project.id);
    const iteration = initial?.iterations[0];
    const artifact = initial?.artifacts[0];
    expect(iteration).toBeDefined();
    expect(artifact).toBeDefined();
    if (!iteration || !artifact) throw new Error('Expected the initial iteration and intent artifact.');

    const preflightRejectedArtifact = await store.addArtifact(
      project.id,
      iteration.id,
      {
        type: 'source-file:orphan.ts',
        name: 'Rejected source attachment',
        content: 'export const orphan = true;',
        mimeType: 'text/plain',
        producedBy: 'builder',
        model: 'builder-model',
      },
      iteration.number,
      'preflight-rejected-source-artifact',
    );
    await store.rejectArtifacts(project.id, [preflightRejectedArtifact.id]);

    const previewRevision = 'a'.repeat(40);
    const previewImageDigest = `sha256:${'b'.repeat(64)}`;
    const previewTriedAt = '2026-08-03T13:00:00.000Z';
    const previewExpiresAt = '2026-08-03T14:00:00.000Z';
    const previewMediaOperationKey = 'media:preview:iteration-1';
    const previewMedia = await store.addMedia({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'preview',
      title: 'Iteration 1 preview',
      url: 'https://preview.example.test/human-review-studio/iteration-1',
      sourceRevision: previewRevision,
      imageDigest: previewImageDigest,
      expiresAt: previewExpiresAt,
    }, previewMediaOperationKey);
    expect(previewMedia).toMatchObject({
      sourceRevision: previewRevision,
      imageDigest: previewImageDigest,
      expiresAt: previewExpiresAt,
    });
    await expect(store.addMedia({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'preview',
      title: 'Retry title is intentionally ignored',
      url: 'https://preview.example.test/retry-output',
      sourceRevision: previewRevision,
      imageDigest: previewImageDigest,
      expiresAt: previewExpiresAt,
    }, previewMediaOperationKey)).resolves.toMatchObject({ id: previewMedia.id });

    const questionInput = {
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'requirements' as const,
      decisionKey: 'recovery.behavior',
      question: 'Which recovery behavior should be the default?',
      context: 'The requirement baseline contains two safe choices.',
      options: [
        { value: 'retry', label: 'Retry safely' },
        { value: 'return', label: 'Return to the previous step' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    };
    const question = await store.addAgentQuestion(questionInput, 'question:recovery-behavior');
    const replayedQuestion = await store.addAgentQuestion(questionInput, 'question:recovery-behavior');
    expect(replayedQuestion.id).toBe(question.id);
    await expect(store.addAgentQuestion({
      ...questionInput,
      question: 'A conflicting question must not reuse the same operation key.',
    }, 'question:recovery-behavior')).rejects.toThrow('different payload');
    expect(question.options.map((option) => option.value)).toEqual(['retry', 'return']);
    const answered = await store.answerProjectAgentQuestion(project.id, question.id, { resolution: 'agent_decides' });
    expect(answered).toMatchObject({ status: 'answered', answer: { resolution: 'agent_decides' } });
    await expect(store.answerProjectAgentQuestion(project.id, question.id, { resolution: 'agent_decides' }))
      .resolves.toMatchObject({
        id: question.id,
        status: 'answered',
        answer: { id: answered.answer?.id, resolution: 'agent_decides' },
      });

    const reusedQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'product',
      decisionKey: 'recovery.behavior',
      question: 'What should happen after the same recoverable failure?',
      options: [
        { value: 'retry', label: 'Retry safely' },
        { value: 'return', label: 'Return to the previous step' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    });
    expect(reusedQuestion).toMatchObject({
      status: 'answered',
      reusedFromQuestionId: question.id,
      answer: { resolution: 'agent_decides', answeredBy: 'human' },
    });

    const baselineQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'requirements',
      decisionKey: 'accessibility.wcag_baseline',
      question: 'Which WCAG baseline should the product use?',
      options: [
        { value: 'wcag-2.1-aa', label: 'WCAG 2.1 AA' },
        { value: 'wcag-2.2-aa', label: 'WCAG 2.2 AA' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    const baselineChoice = baselineQuestion.options.find((option) => option.value === 'wcag-2.2-aa')!;
    await store.answerProjectAgentQuestion(project.id, baselineQuestion.id, {
      resolution: 'selected_option',
      optionId: baselineChoice.id,
    });
    const aliasedBaselineQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'builder',
      decisionKey: 'accessibility.wcag_baseline',
      question: 'Which conformance baseline should the criterion registry use?',
      options: [
        { value: 'wcag21aa', label: 'WCAG 2.1 Level AA' },
        { value: 'wcag22aa', label: 'WCAG 2.2 Level AA' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    expect(aliasedBaselineQuestion).toMatchObject({
      status: 'answered',
      reusedFromQuestionId: baselineQuestion.id,
      answer: { resolution: 'selected_option', answeredBy: 'human' },
    });

    const exportQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'requirements',
      decisionKey: 'exports.package_format',
      question: 'Which export package should the handoff use?',
      options: [
        { value: 'zip_markdown_html_json', label: 'ZIP with Markdown, HTML, and provenance JSON' },
        { value: 'zip_pdf_provenance', label: 'ZIP with PDF and provenance JSON' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    await store.answerProjectAgentQuestion(project.id, exportQuestion.id, {
      resolution: 'selected_option',
      optionId: exportQuestion.options.find((option) => option.value === 'zip_pdf_provenance')!.id,
    });
    const aliasedExportQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'architecture',
      decisionKey: 'export.format_choice',
      question: 'What canonical export format should the app produce?',
      options: [
        { value: 'zip-md-html-json', label: 'ZIP: Markdown + HTML + JSON manifest' },
        { value: 'pdf-plus-json', label: 'PDF-first plus sidecar JSON' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    expect(aliasedExportQuestion).toMatchObject({
      status: 'answered',
      reusedFromQuestionId: exportQuestion.id,
      answer: { resolution: 'selected_option', answeredBy: 'human' },
    });

    const authenticationQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'test',
      decisionKey: 'auth.model_selection',
      question: 'Which authentication model should be implemented?',
      options: [
        { value: 'oidc', label: 'OIDC-based authentication' },
        { value: 'ldap', label: 'LDAP-based authentication' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    await store.answerProjectAgentQuestion(project.id, authenticationQuestion.id, {
      resolution: 'selected_option',
      optionId: authenticationQuestion.options.find((option) => option.value === 'oidc')!.id,
    });
    const aliasedAuthenticationQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'gate',
      decisionKey: 'auth.iteration1_implementation_model',
      question: 'Which authentication model should be used for iteration 1?',
      options: [
        { value: 'oidc', label: 'OIDC authentication' },
        { value: 'local', label: 'Local credential store' },
      ],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    expect(aliasedAuthenticationQuestion).toMatchObject({
      status: 'answered',
      reusedFromQuestionId: authenticationQuestion.id,
      answer: { resolution: 'selected_option', answeredBy: 'human' },
    });

    const restrictedQuestion = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'security',
      question: 'Which explicit control is authorized?',
      options: [{ value: 'approval', label: 'Require approval' }],
      allowCustomAnswer: false,
      allowAgentDecide: false,
    });
    await expect(store.answerProjectAgentQuestion(project.id, restrictedQuestion.id, { resolution: 'agent_decides' }))
      .rejects.toThrow('does not allow the agent to decide');

    await store.addAgentComment({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'builder',
      body: 'Keep this increment small and reversible.',
      authorType: 'human',
    });

    const otherProject = await store.create({
      name: 'Separate studio',
      intent: 'Keep unrelated project feedback isolated from every other delivery organism.',
      audience: 'A different project owner',
      success: 'Cross-project iteration references are rejected before persistence.',
      constraints: [],
    });
    const otherIteration = (await store.detail(otherProject.id))?.iterations[0];
    expect(otherIteration).toBeDefined();
    if (!otherIteration) throw new Error('Expected a separate project iteration.');
    await expect(store.addAgentComment({
      projectId: project.id,
      iterationId: otherIteration.id,
      agentRole: 'builder',
      body: 'This must not cross the project boundary.',
      authorType: 'human',
    })).rejects.toThrow('does not belong to project');

    const agentFeedback = agentRoleSchema.options.map((role) => ({
      role,
      feedback: role === 'builder' ? 'Preserve the rollback path.' : '',
    }));
    await expect(store.reviewIteration(project.id, iteration.number, {
      decision: 'request_changes',
      feedback: '',
      overallDirection: 'Revise only the recovery behavior.',
      agentFeedback,
      artifactFeedback: [{ artifactId: artifact.id, feedback: 'Make the recovery boundary explicit.' }],
      previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: previewTriedAt },
    })).resolves.toBe(true);

    const reviewed = await store.detail(project.id);
    expect(reviewed?.questions).toHaveLength(9);
    expect(reviewed?.agentComments).toEqual([
      expect.objectContaining({ agentRole: 'builder', body: 'Keep this increment small and reversible.' }),
    ]);
    expect(reviewed?.iterationReviews?.[0]).toMatchObject({
      decision: 'request_changes',
      overallDirection: 'Revise only the recovery behavior.',
      previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: previewTriedAt },
    });
    expect(reviewed?.media[0]).toMatchObject({
      sourceRevision: previewRevision,
      imageDigest: previewImageDigest,
      expiresAt: previewExpiresAt,
    });
    expect(reviewed?.iterationReviews?.[0].agentFeedback).toHaveLength(14);
    expect(reviewed?.iterationReviews?.[0].agentFeedback.find((entry) => entry.role === 'manager')?.feedback).toBe('');
    expect(reviewed?.artifactFeedback).toEqual([
      expect.objectContaining({ artifactId: artifact.id, feedback: 'Make the recovery boundary explicit.' }),
    ]);
    expect(reviewed?.artifacts.find((candidate) => candidate.id === preflightRejectedArtifact.id)?.status)
      .toBe('superseded');
    expect(reviewed?.artifactVersions?.find((version) => version.artifactId === preflightRejectedArtifact.id)?.status)
      .toBe('superseded');

    const approvalReview = {
      decision: 'approve',
      feedback: 'Approved once Forgejo confirms the merge.',
      previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: previewTriedAt },
    } as const;
    await expect(store.reviewIteration(
      project.id,
      iteration.number,
      approvalReview,
      'review-operation-approved-1',
    )).resolves.toBe(true);
    await expect(store.reviewIteration(
      project.id,
      iteration.number,
      approvalReview,
      'review-operation-approved-1',
    )).resolves.toBe(true);
    await expect(store.reviewIteration(
      project.id,
      iteration.number,
      {
        ...approvalReview,
        previewAttestation: { revision: 'c'.repeat(40), imageDigest: previewImageDigest, triedAt: previewTriedAt },
      },
      'review-operation-approved-1',
    )).rejects.toThrow('already used with a different payload');
    await expect(store.reviewIteration(
      project.id,
      iteration.number,
      {
        ...approvalReview,
        previewAttestation: {
          revision: previewRevision,
          imageDigest: `sha256:${'d'.repeat(64)}`,
          triedAt: previewTriedAt,
        },
      },
      'review-operation-approved-1',
    )).rejects.toThrow('already used with a different payload');
    const awaitingMerge = await store.detail(project.id);
    expect(awaitingMerge?.iterations[0]).toMatchObject({ status: 'approved', completedAt: null });
    expect(awaitingMerge?.artifacts.find((candidate) => candidate.id === artifact.id))
      .toMatchObject({ status: 'ready_for_review' });
    expect(awaitingMerge?.artifacts.find((candidate) => candidate.id === preflightRejectedArtifact.id)?.status)
      .toBe('superseded');
    expect(awaitingMerge?.iterationReviews).toHaveLength(2);
    expect(awaitingMerge?.iterationReviews?.[0].previewAttestation).toEqual({
      revision: previewRevision,
      imageDigest: previewImageDigest,
      triedAt: previewTriedAt,
    });

    await expect(store.completeMergedIteration(project.id, iteration.number)).resolves.toBe(true);
    const merged = await store.detail(project.id);
    expect(merged?.iterations[0]).toMatchObject({ status: 'completed' });
    expect(merged?.iterations[0].completedAt).not.toBeNull();
    expect(merged?.artifacts.find((candidate) => candidate.id === artifact.id))
      .toMatchObject({ status: 'approved' });
    expect(merged?.artifacts.find((candidate) => candidate.id === preflightRejectedArtifact.id)?.status)
      .toBe('superseded');
    expect(merged?.artifactVersions?.find((version) => version.artifactId === preflightRejectedArtifact.id)?.status)
      .toBe('superseded');

    const connected = await store.connectRepository(project.id, {
      url: 'https://git.example.test/team/human-review-studio',
      owner: 'team',
      name: 'human-review-studio',
    });
    expect(connected.repositoryName).toBe('human-review-studio');
    await expect(store.updatePreviewUrl(project.id, 'https://preview.example.test/human-review-studio'))
      .resolves.toMatchObject({ previewUrl: 'https://preview.example.test/human-review-studio' });
    await expect(store.listRepositoryLifecycle(project.id)).resolves.toEqual([
      expect.objectContaining({ kind: 'repository_connected', status: 'completed' }),
    ]);
  });
});
