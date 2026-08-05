import { describe, expect, it } from 'vitest';
import { agentMessageSchema, deliveryAgentGraph, type IterationReviewProposal, type ProjectDetail } from '@orchestra/contracts';
import { buildAgentFailureMessage, buildAgentHandoffMessage, buildExecutionGraph, buildHumanGuidanceMessage, deriveIterationReviewProposal, humanGuidanceFromProjectDetail, paginateStoredHumanGuidance, prepareDiscovery, selectIterationPreview, selectPriorAgentArtifacts, selectRepositoryPreparationArtifacts } from './activities.js';

describe('actor mailbox protocol messages', () => {
  const now = '2026-08-04T12:00:00.000Z';
  const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
  const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
  const project = {
    id: projectId, name: 'Orchestra', intent: 'Deliver safely.', audience: 'Founders', success: 'Reviewed release.',
    constraints: [], status: 'building' as const, currentIteration: 1, previewUrl: null, repositoryUrl: null,
    repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now,
  };
  const iteration = {
    id: iterationId, projectId, number: 1, objective: 'First increment', status: 'active' as const,
    startedAt: now, completedAt: null, issueNumber: 1, branchName: 'iteration-1', pullRequestNumber: null,
    pullRequestUrl: null,
  };
  const artifact = {
    id: 'd67a2fd5-e829-40dc-a6f5-d15e4758515d', projectId, iterationId, type: 'build-submission',
    name: 'Build submission', version: 2, content: '# Build', mimeType: 'text/markdown',
    status: 'ready_for_review' as const, producedBy: 'builder' as const, model: 'model', repositoryPath: null,
    repositoryUrl: null, createdAt: now, reviewedAt: null,
  };

  it('builds one acknowledgement-required handoff envelope for every recipient actor', () => {
    const delivered = buildAgentHandoffMessage(
      project,
      iteration,
      'builder',
      [artifact],
      ['test', 'reviewer'],
      'actor_mailbox',
      now,
    );
    const staticHistory = buildAgentHandoffMessage(
      project,
      iteration,
      'builder',
      [artifact],
      ['test', 'reviewer'],
      'static_history',
      now,
    );

    expect(agentMessageSchema.parse(delivered)).toEqual(delivered);
    expect(delivered).toMatchObject({
      kind: 'EVIDENCE', name: 'artifact.handoff', acknowledgementRequired: true,
      iterationId, payload: { iterationNumber: 1 },
    });
    expect(delivered.recipients.map((recipient) => recipient.role)).toEqual(['test', 'reviewer']);
    expect(delivered.artifactRefs).toEqual([expect.objectContaining({
      artifactId: artifact.id, version: '2', ownerRole: 'builder',
    })]);
    expect(delivered.idempotencyKey).toContain(':mailbox-v1');
    expect(staticHistory.acknowledgementRequired).toBe(false);
    expect(staticHistory.idempotencyKey).not.toBe(delivered.idempotencyKey);
  });

  it('builds a single blocker envelope addressed to Manager and Gate', () => {
    const message = buildAgentFailureMessage(
      projectId,
      3,
      'security',
      'A required threat-model disposition is missing.',
      'actor_mailbox',
      now,
    );

    expect(agentMessageSchema.parse(message)).toEqual(message);
    expect(message).toMatchObject({
      kind: 'ESCALATION', name: 'agent.blocked', acknowledgementRequired: true,
      projectStateVersion: 3, payload: { iterationNumber: 3 },
    });
    expect(message.recipients.map((recipient) => recipient.role)).toEqual(['manager', 'gate']);
  });

  it('builds human guidance as an acknowledgement-required actor mailbox envelope', () => {
    const message = buildHumanGuidanceMessage({
      projectId,
      iterationId,
      iterationNumber: 1,
      recipientRole: 'builder',
      sourceRecordId: 'comment-1',
      sourceKind: 'agent_comment',
      summary: 'Keep the recovery change narrow and reversible.',
      createdAt: now,
    });

    expect(agentMessageSchema.parse(message)).toEqual(message);
    expect(message).toMatchObject({
      kind: 'CONTROL',
      name: 'human.agent_guidance',
      acknowledgementRequired: true,
      authority: { issuerRole: 'human', permittedTargets: ['builder'] },
      payload: { authoredBy: 'human', sourceRecordId: 'comment-1' },
    });
    expect(message.sender.role).toBe('manager');
    expect(message.recipients.map((recipient) => recipient.role)).toEqual(['builder']);
  });
});

describe('prepareDiscovery', () => {
  it('turns a project into an approval-oriented discovery plan', async () => {
    const result = await prepareDiscovery({
      id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
      name: 'Orchestra',
      intent: 'Help a person build software from their intentions.',
      audience: 'Non-technical founders',
      success: 'A reviewed first release is produced safely.',
      constraints: [],
      status: 'discovering',
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(result.proposedMilestones).toContain('Approve product brief');
    expect(result.questions).toHaveLength(3);
  });
});

describe('durable human guidance reconstruction', () => {
  it('preserves guidance beyond the former cap and scopes artifact feedback to its owner', () => {
    const now = '2026-08-04T12:00:00.000Z';
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const artifactId = 'd67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const detail: ProjectDetail = {
      project: {
        id: projectId,
        name: 'Orchestra',
        intent: 'Preserve human direction across workflow runs.',
        audience: 'Operators',
        success: 'No accepted guidance is silently dropped.',
        constraints: [],
        status: 'building',
        currentIteration: 1,
        previewUrl: null,
        repositoryUrl: null,
        repositoryOwner: null,
        repositoryName: null,
        createdAt: now,
        updatedAt: now,
      },
      iterations: [{
        id: iterationId,
        projectId,
        number: 1,
        objective: 'First increment',
        status: 'active',
        startedAt: now,
        completedAt: null,
        issueNumber: null,
        branchName: 'iteration-1',
        pullRequestNumber: null,
        pullRequestUrl: null,
      }],
      artifacts: [{
        id: artifactId,
        projectId,
        iterationId,
        type: 'build-submission',
        name: 'Build submission',
        version: 1,
        content: '# Build',
        mimeType: 'text/markdown',
        status: 'ready_for_review',
        producedBy: 'builder',
        model: 'model',
        repositoryPath: null,
        repositoryUrl: null,
        createdAt: now,
        reviewedAt: null,
      }],
      events: [],
      media: [],
      agentComments: Array.from({ length: 101 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        projectId,
        iterationId,
        agentRole: 'builder' as const,
        body: `Direction ${index}`,
        authorType: 'human' as const,
        authorRole: null,
        createdAt: now,
      })),
      artifactFeedback: [{
        id: 'e67a2fd5-e829-40dc-a6f5-d15e4758515d',
        projectId,
        iterationId,
        reviewId: null,
        artifactId,
        feedback: 'Keep the retry path reversible.',
        createdAt: now,
      }],
    };

    const guidance = humanGuidanceFromProjectDetail(detail);

    expect(guidance).toHaveLength(102);
    expect(guidance.at(-1)).toMatchObject({
      kind: 'artifact_feedback',
      role: 'builder',
      summary: expect.stringContaining('Keep the retry path reversible.'),
    });

    const first = paginateStoredHumanGuidance(guidance, { limit: 50 });
    const second = paginateStoredHumanGuidance(guidance, { afterKey: first.nextCursor, limit: 50 });
    const third = paginateStoredHumanGuidance(guidance, { afterKey: second.nextCursor, limit: 50 });
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([50, 50, 2]);
    expect(new Set([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.key)).size).toBe(102);
    expect(third.nextCursor).toBeUndefined();
  });
});

describe('buildExecutionGraph', () => {
  it('exposes parallel readiness, blocking dependencies, and supervision separately', () => {
    const now = new Date().toISOString();
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const detail: ProjectDetail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Help people build software from intentions.', audience: 'Founders',
        success: 'A safe release is reviewed.', constraints: [], status: 'defining', currentIteration: 1,
        previewUrl: null, repositoryUrl: null, repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now,
      },
      iterations: [{ id: iterationId, projectId, number: 1, objective: 'First increment', status: 'active', startedAt: now, completedAt: null, issueNumber: 1, branchName: 'iteration-1-agents', pullRequestNumber: null, pullRequestUrl: null }],
      artifacts: [
        { id: crypto.randomUUID(), projectId, iterationId, type: 'project-charter', name: 'Project charter', version: 1, content: '# Charter', mimeType: 'text/markdown', status: 'ready_for_review', producedBy: 'manager', model: 'qwen3.5:9b', repositoryPath: 'charter.md', repositoryUrl: null, createdAt: now, reviewedAt: null },
        { id: crypto.randomUUID(), projectId, iterationId, type: 'requirements-baseline', name: 'Staged requirements', version: 1, content: '# Incomplete', mimeType: 'text/markdown', status: 'draft', producedBy: 'requirements', model: 'qwen3.5:9b', repositoryPath: null, repositoryUrl: null, createdAt: now, reviewedAt: null },
        { id: crypto.randomUUID(), projectId, iterationId, type: 'assurance-ledger', name: 'Ledger evidence', version: 1, content: '# Evidence', mimeType: 'text/markdown', status: 'ready_for_review', producedBy: 'test', model: 'qwen3.5:9b', storageMode: 'ledger', repositoryPath: null, repositoryUrl: null, createdAt: now, reviewedAt: null },
      ],
      events: [
        { id: crypto.randomUUID(), projectId, iterationNumber: 1, kind: 'agent', title: 'Requirements agent started', description: 'Working', agentRole: 'requirements', createdAt: now },
        { id: crypto.randomUUID(), projectId, iterationNumber: 1, kind: 'agent', title: 'Product agent started', description: 'Working', agentRole: 'product', createdAt: now },
      ],
      media: [],
    };
    const graph = buildExecutionGraph(detail);
    expect(graph.nodes.filter((node) => node.state === 'planning').map((node) => node.role)).toEqual(['requirements', 'product']);
    expect(graph.nodes.find((node) => node.role === 'manager')).toMatchObject({
      state: 'monitoring',
      activity: { type: 'obligation_monitoring' },
    });
    expect(graph.nodes.find((node) => node.role === 'ux')).toMatchObject({ state: 'waiting_on_agent', dependsOn: ['requirements', 'product'], supervisedBy: ['product'] });
    expect(graph.nodes).toHaveLength(14);
    expect(graph.nodes.find((node) => node.role === 'deployment')).toMatchObject({ state: 'monitoring', dependsOn: ['gate'] });
    expect(graph.nodes.find((node) => node.role === 'validation')).toMatchObject({ state: 'monitoring', dependsOn: ['deployment'] });
    expect(graph.graphVersion).toBe(1);
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'requirements', to: 'ux', kind: 'blocks', artifacts: ['requirements-baseline'] }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'product', to: 'ux', kind: 'supervises', artifacts: [] }));
    expect(graph.interactions).toContainEqual(expect.objectContaining({
      from: 'product', to: ['project'], kind: 'status', status: 'in_progress',
    }));
    expect(graph.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ correlationId: 'iteration:1:product', participantRoles: ['product'] }),
    ]));
    expect(graph.readiness).toMatchObject({
      objectiveStatus: 'unsatisfied',
      gateStatus: 'waiting',
      managerRecommendation: 'continue_iteration',
    });
    expect(selectRepositoryPreparationArtifacts(detail, iterationId).map((artifact) => artifact.name))
      .toEqual(['Project charter']);
  });

  it('projects durable actor snapshots ahead of inferred event and artifact state', () => {
    const now = '2026-08-04T12:00:00.000Z';
    const stateChangedAt = '2026-08-04T12:01:00.000Z';
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const detail: ProjectDetail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Expose the real actor state.', audience: 'Operators',
        success: 'The graph reflects durable runtime snapshots.', constraints: [], status: 'building', currentIteration: 1,
        previewUrl: null, repositoryUrl: null, repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now,
      },
      iterations: [{ id: iterationId, projectId, number: 1, objective: 'First increment', status: 'active', startedAt: now, completedAt: null, issueNumber: 1, branchName: 'iteration-1-agents', pullRequestNumber: null, pullRequestUrl: null }],
      artifacts: [],
      events: [],
      media: [],
      agentRuntimeSnapshots: [{
        role: 'security',
        state: 'communicating',
        activity: { type: 'finding_handoff', summary: 'Sending finding F-104 to Builder and Test.', startedAt: stateChangedAt },
        stateChangedAt,
        mailboxDepth: 2,
        activeOrderCount: 1,
        blockerCount: 1,
        pendingQuestionCount: 0,
        graphVersion: 4,
        stateVersion: 9,
      }],
    };

    expect(buildExecutionGraph(detail).nodes.find((node) => node.role === 'security')).toMatchObject({
      state: 'communicating',
      activity: { type: 'finding_handoff', summary: 'Sending finding F-104 to Builder and Test.', startedAt: stateChangedAt },
      stateChangedAt,
      startedAt: stateChangedAt,
      openMessageCount: 2,
      blockingDependencyCount: 1,
    });
  });

  it('requires a fresh, non-rejected, revision-bound proposal before reporting Gate pass', () => {
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const artifactId = 'd67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const revision = 'a'.repeat(40);
    const evidenceAt = '2026-08-04T12:00:00.000Z';
    const positions = Object.fromEntries(deliveryAgentGraph.map((definition) => [
      definition.role,
      'activation' in definition && definition.activation === 'authorized_release' ? 'not_required' : 'ready',
    ])) as IterationReviewProposal['agentPositions'];
    const detail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Help people build software from intentions.', audience: 'Founders',
        success: 'A safe release is reviewed.', constraints: [], status: 'awaiting_approval' as const, currentIteration: 1,
        previewUrl: 'https://preview.example/current', repositoryUrl: null, repositoryOwner: null, repositoryName: null,
        createdAt: evidenceAt, updatedAt: evidenceAt,
      },
      iterations: [{
        id: iterationId, projectId, number: 1, objective: 'First increment', status: 'awaiting_review' as const,
        startedAt: evidenceAt, completedAt: null, issueNumber: 1, branchName: 'iteration-1', pullRequestNumber: 1,
        pullRequestUrl: 'https://forgejo.example/pulls/1',
      }],
      artifacts: [{
        id: artifactId, projectId, iterationId, type: 'gate-decision', name: 'Gate decision', version: 1,
        content: 'Structured Gate evidence exists in workflow history.', mimeType: 'text/markdown', status: 'ready_for_review' as const,
        producedBy: 'gate' as const, model: 'model', repositoryPath: 'gate.md', repositoryUrl: null,
        createdAt: evidenceAt, reviewedAt: null,
      }],
      events: [],
      media: [{
        id: crypto.randomUUID(), projectId, iterationId, kind: 'preview' as const, title: 'Current preview',
        url: 'https://preview.example/current', sourceRevision: revision, imageDigest: null, expiresAt: '2027-08-04T12:00:00.000Z',
        createdAt: evidenceAt,
      }],
    } satisfies ProjectDetail;
    expect(buildExecutionGraph(detail).readiness?.gateStatus).toBe('waiting');

    const proposal = {
      id: 'proposal-1', projectId, iterationId, iterationNumber: 1, type: 'iteration_review_proposal' as const,
      proposalVersion: 1, status: 'rejected' as const, objectiveStatus: 'satisfied' as const, includedRevision: revision,
      completedOutcomes: [], openFindings: [], agentPositions: positions, gateStatus: 'pass' as const,
      gateRationale: 'Structured Gate passed.', managerRationale: 'Manager recorded the evidence.',
      recommendation: 'send_for_human_review' as const, knownLimitations: [],
      budgetSnapshot: { modelInvocationCount: 0, totalTokens: 0, openRouterCostUsd: 0, repositoryOperationCount: 0, activeMutationCount: 0 },
      createdAt: '2026-08-04T13:00:00.000Z',
    };
    const rejected = buildExecutionGraph({ ...detail, iterationReviewProposals: [proposal] });
    expect(rejected.readiness?.gateStatus).toBe('waiting');

    const superseded = buildExecutionGraph({
      ...detail,
      iterationReviewProposals: [{ ...proposal, status: 'superseded' }],
    });
    expect(superseded.readiness).toMatchObject({
      gateStatus: 'waiting',
      managerRecommendation: 'continue_iteration',
    });

    const acceptedEvidence = buildExecutionGraph({
      ...detail,
      iterationReviewProposals: [{ ...proposal, status: 'proposed' }],
    });
    expect(acceptedEvidence.readiness).toMatchObject({
      gateStatus: 'pass',
      managerRecommendation: 'continue_iteration',
      includedRevision: revision,
    });

    const pendingDecisionOverridesProposal = buildExecutionGraph({
      ...detail,
      iterationReviewProposals: [{ ...proposal, status: 'proposed' }],
      questions: [{
        id: crypto.randomUUID(), projectId, iterationId, agentRole: 'manager' as const,
        decisionKey: 'manager.cutoff_safety_budget', reusedFromQuestionId: null,
        question: 'How should the remaining safety budget be handled?', context: null,
        status: 'pending' as const, allowCustomAnswer: true, allowAgentDecide: false,
        options: [], answer: null,
        createdAt: '2026-08-04T12:30:00.000Z', updatedAt: '2026-08-04T12:30:00.000Z',
      }],
    });
    expect(pendingDecisionOverridesProposal.readiness).toMatchObject({
      gateStatus: 'pass',
      managerRecommendation: 'request_human_decision',
    });
    expect(pendingDecisionOverridesProposal.readiness?.managerRationale).toContain('1 human decision is still required');
  });
});

describe('deriveIterationReviewProposal', () => {
  it('binds the exact preview and derives findings, positions, outcomes, and budget from durable records', () => {
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const revision = 'b'.repeat(40);
    const now = '2026-08-04T12:00:00.000Z';
    const requiredDefinitions = deliveryAgentGraph.filter((definition) =>
      !('activation' in definition) || definition.activation !== 'authorized_release');
    const artifacts = requiredDefinitions.map((definition, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      projectId,
      iterationId,
      type: definition.artifactType,
      name: definition.artifactName,
      version: 1,
      content: `# ${definition.artifactName}`,
      mimeType: 'text/markdown',
      status: 'ready_for_review' as const,
      producedBy: definition.role,
      model: 'model',
      repositoryPath: null,
      repositoryUrl: null,
      createdAt: now,
      reviewedAt: null,
    }));
    const detail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Help people build software from intentions.', audience: 'Founders',
        success: 'A safe release is reviewed.', constraints: [], status: 'reviewing' as const, currentIteration: 1,
        previewUrl: 'https://preview.example/current', repositoryUrl: null, repositoryOwner: null, repositoryName: null,
        createdAt: now, updatedAt: now,
      },
      iterations: [{
        id: iterationId, projectId, number: 1, objective: 'First increment', status: 'awaiting_review' as const,
        startedAt: now, completedAt: null, issueNumber: 1, branchName: 'iteration-1', pullRequestNumber: 1,
        pullRequestUrl: 'https://forgejo.example/pulls/1',
      }],
      artifacts,
      events: [],
      media: [{
        id: crypto.randomUUID(), projectId, iterationId, kind: 'preview' as const, title: 'Current preview',
        url: 'https://preview.example/current', sourceRevision: revision, imageDigest: null, expiresAt: '2027-08-04T12:00:00.000Z',
        createdAt: now,
      }],
      artifactVersions: artifacts.map((artifact, index) => ({
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        projectId,
        iterationId,
        artifactId: artifact.id,
        artifactType: artifact.type,
        artifactName: artifact.name,
        producedByRole: artifact.producedBy,
        version: artifact.version,
        status: artifact.status,
        content: artifact.content,
        mimeType: artifact.mimeType,
        contentHash: null,
        storageUri: null,
        repositoryPath: null,
        sourceRevision: ['test-evidence', 'review-decision', 'gate-decision'].includes(artifact.type) ? revision : null,
        supersedesVersionId: null,
        metadata: {},
        createdAt: now,
      })),
      agentGoals: [{
        id: crypto.randomUUID(), projectId, iterationId, role: 'manager' as const, objective: 'Deliver the first increment',
        status: 'satisfied' as const, priority: 'high' as const, successCriteria: ['Gate passes'], correlationId: 'iteration:1',
        createdAt: now, updatedAt: now, completedAt: now,
      }],
      findings: [{
        id: crypto.randomUUID(), projectId, iterationId, raisedByRole: 'security' as const, ownerRole: 'security' as const,
        obligationId: null, actionId: null, artifactVersionId: null, category: 'privacy', title: 'Residual telemetry risk',
        description: 'Telemetry retention remains intentionally limited.', severity: 'medium' as const, status: 'accepted_risk' as const,
        disposition: 'accepted_risk' as const, subjectReferences: [], evidenceReferences: [], sourceRevision: revision,
        correlationId: 'finding:telemetry', createdAt: now, updatedAt: now, resolvedAt: null,
      }],
      modelInvocations: [{
        id: crypto.randomUUID(), projectId, iterationId, role: 'builder' as const, actionId: null, provider: 'openrouter' as const,
        model: 'openai/model', purpose: 'generate', status: 'succeeded' as const, externalRequestId: 'req-1',
        inputTokens: 600, outputTokens: 400, cachedTokens: 0, totalTokens: 1000, costUsd: 0.25,
        requestMetadata: {}, responseMetadata: {}, error: null, correlationId: 'artifact:build', createdAt: now,
        startedAt: now, completedAt: now,
      }],
      repositoryOperations: [{
        id: crypto.randomUUID(), projectId, iterationId, role: 'builder' as const, actionId: null, lifecycleRecordId: null,
        type: 'pull_request_updated', status: 'completed' as const, mutating: true, repositoryUrl: 'https://forgejo.example/repo',
        branchName: 'iteration-1', paths: ['src/app.ts'], expectedBaseRevision: null, resultingRevision: revision,
        externalId: '1', summary: 'Updated pull request.', metadata: {}, correlationId: 'iteration:1', createdAt: now,
        startedAt: now, completedAt: now,
      }],
    } satisfies ProjectDetail;

    const proposal = deriveIterationReviewProposal(
      detail,
      1,
      revision,
      'All required evidence is present and every deterministic control passed.',
    );

    expect(proposal).toMatchObject({
      gateStatus: 'pass',
      objectiveStatus: 'satisfied_with_known_gaps',
      recommendation: 'send_for_human_review',
      gateRationale: 'All required evidence is present and every deterministic control passed.',
      budgetSnapshot: { modelInvocationCount: 1, totalTokens: 1000, openRouterCostUsd: 0.25, repositoryOperationCount: 1, activeMutationCount: 0 },
    });
    expect(proposal.openFindings).toContainEqual(expect.objectContaining({
      severity: 'medium', disposition: 'accepted_risk', summary: expect.stringContaining('Residual telemetry risk'),
    }));
    expect(proposal.agentPositions.security).toBe('ready_with_accepted_risk');
    expect(proposal.agentPositions.deployment).toBe('not_required');
    expect(proposal.completedOutcomes).toEqual(expect.arrayContaining([
      'Goal satisfied: Deliver the first increment',
      'Builder produced Build submission v1',
    ]));
    expect(proposal.knownLimitations).toContainEqual(expect.stringContaining('Residual telemetry risk'));
    const staleAssurance = deriveIterationReviewProposal({
      ...detail,
      artifactVersions: detail.artifactVersions?.map((version) => version.artifactType === 'gate-decision'
        ? { ...version, sourceRevision: 'c'.repeat(40) }
        : version),
      agentGoals: [...(detail.agentGoals ?? []), {
        id: crypto.randomUUID(), projectId, iterationId, role: 'gate' as const, objective: 'Evaluate readiness',
        status: 'satisfied' as const, priority: 'high' as const, successCriteria: ['Gate checks pass'],
        correlationId: 'iteration:1:gate', createdAt: now, updatedAt: now, completedAt: now,
      }],
    }, 1, revision);
    expect(staleAssurance.recommendation).toBe('continue_iteration');
    expect(staleAssurance.agentPositions.gate).toBe('not_ready');
    expect(() => deriveIterationReviewProposal(detail, 1, 'c'.repeat(40))).toThrow(/no unexpired preview/i);
  });
});

describe('selectPriorAgentArtifacts', () => {
  it('returns the newest matching artifact from earlier iterations', () => {
    const now = new Date().toISOString();
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const firstIterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const secondIterationId = 'd67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const detail: ProjectDetail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Help people build software from intentions.', audience: 'Founders',
        success: 'A safe release is reviewed.', constraints: [], status: 'building', currentIteration: 2,
        previewUrl: null, repositoryUrl: 'https://forgejo.example/orchestra', repositoryOwner: 'agent', repositoryName: 'orchestra', createdAt: now, updatedAt: now,
      },
      iterations: [
        { id: secondIterationId, projectId, number: 2, objective: 'Second', status: 'active', startedAt: now, completedAt: null, issueNumber: 2, branchName: 'iteration-2-agents', pullRequestNumber: null, pullRequestUrl: null },
        { id: firstIterationId, projectId, number: 1, objective: 'First', status: 'completed', startedAt: now, completedAt: now, issueNumber: 1, branchName: 'iteration-1-agents', pullRequestNumber: 1, pullRequestUrl: 'https://forgejo.example/pulls/1' },
      ],
      artifacts: [
        { id: crypto.randomUUID(), projectId, iterationId: firstIterationId, type: 'requirements-baseline', name: 'Requirements v1', version: 1, content: 'old', mimeType: 'text/markdown', status: 'approved', producedBy: 'requirements', model: 'model', repositoryPath: 'v1.md', repositoryUrl: 'https://forgejo.example/v1', createdAt: now, reviewedAt: now },
        { id: crypto.randomUUID(), projectId, iterationId: firstIterationId, type: 'requirements-baseline', name: 'Requirements v2', version: 2, content: 'newest', mimeType: 'text/markdown', status: 'approved', producedBy: 'requirements', model: 'model', repositoryPath: 'v2.md', repositoryUrl: 'https://forgejo.example/v2', createdAt: now, reviewedAt: now },
        { id: crypto.randomUUID(), projectId, iterationId: firstIterationId, type: 'threat-model', name: 'Threat model', version: 1, content: 'unrequested', mimeType: 'text/markdown', status: 'approved', producedBy: 'security', model: 'model', repositoryPath: 'threat.md', repositoryUrl: null, createdAt: now, reviewedAt: now },
      ],
      events: [],
      media: [],
    };

    const artifacts = selectPriorAgentArtifacts(detail, 2, ['requirements-baseline']);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      name: 'Requirements v2',
      byteLength: 6,
      repositoryPath: 'v2.md',
    });
    expect(artifacts[0]?.content).toBeUndefined();
    expect(artifacts[0]?.contentAddress).toContain(`/${projectId}/${detail.artifacts[1].id}?version=2`);
  });

  it('includes current-iteration artifacts when revising a changes-requested pull request', () => {
    const now = new Date().toISOString();
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const detail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Help people build software from intentions.', audience: 'Founders',
        success: 'A safe release is reviewed.', constraints: [], status: 'building' as const, currentIteration: 1,
        previewUrl: null, repositoryUrl: null, repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now,
      },
      iterations: [{ id: iterationId, projectId, number: 1, objective: 'First', status: 'changes_requested' as const, startedAt: now, completedAt: null, issueNumber: 1, branchName: 'iteration-1-agents', pullRequestNumber: 1, pullRequestUrl: 'https://forgejo.example/pulls/1' }],
      artifacts: [{ id: crypto.randomUUID(), projectId, iterationId, type: 'build-submission', name: 'Build submission', version: 1, content: 'revise me', mimeType: 'text/markdown', status: 'changes_requested' as const, producedBy: 'builder' as const, model: 'model', repositoryPath: 'build.md', repositoryUrl: null, createdAt: now, reviewedAt: now }],
      events: [],
      media: [],
    } satisfies ProjectDetail;

    expect(selectPriorAgentArtifacts(detail, 1, ['build-submission'])).toHaveLength(1);
    expect(selectPriorAgentArtifacts({
      ...detail,
      iterations: [{ ...detail.iterations[0], status: 'blocked' }],
    }, 1, ['build-submission'])).toHaveLength(1);

    const activeReactiveRound = {
      ...detail,
      iterations: [{ ...detail.iterations[0], status: 'active' as const }],
      artifacts: [{ ...detail.artifacts[0], status: 'ready_for_review' as const }],
    } satisfies ProjectDetail;
    expect(selectPriorAgentArtifacts(activeReactiveRound, 1, ['build-submission'])).toEqual([]);
    expect(selectPriorAgentArtifacts(
      activeReactiveRound,
      1,
      ['build-submission'],
      { includeCurrentIteration: true },
    )).toEqual([expect.objectContaining({
      id: activeReactiveRound.artifacts[0].id,
      byteLength: 9,
    })]);
  });
});

describe('selectIterationPreview', () => {
  it('selects only preview media bound to the exact iteration', () => {
    const now = new Date().toISOString();
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const previousIterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const currentIterationId = 'd67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const detail = {
      project: {
        id: projectId, name: 'Orchestra', intent: 'Help people build software from intentions.', audience: 'Founders',
        success: 'A safe release is reviewed.', constraints: [], status: 'reviewing' as const, currentIteration: 2,
        previewUrl: 'https://preview.example/old', repositoryUrl: null, repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now,
      },
      iterations: [], events: [], artifacts: [],
      media: [
        { id: crypto.randomUUID(), projectId, iterationId: previousIterationId, kind: 'preview' as const, title: 'Old preview', url: 'https://preview.example/old', createdAt: now },
        { id: crypto.randomUUID(), projectId, iterationId: currentIterationId, kind: 'preview' as const, title: 'Current preview', url: 'https://preview.example/current', createdAt: now },
      ],
    } satisfies ProjectDetail;

    expect(selectIterationPreview(detail, currentIterationId)).toEqual({
      iterationId: currentIterationId,
      title: 'Current preview',
      url: 'https://preview.example/current',
    });
    expect(selectIterationPreview(detail, 'missing-iteration')).toBeUndefined();
  });
});
