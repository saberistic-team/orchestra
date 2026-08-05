import type {
  AgentInteraction,
  AgentInteractionKind,
  AgentInteractionParty,
  AgentInteractionStatus,
  AgentRole,
  OrganismEvent,
  ProjectDetail,
} from '@orchestra/contracts';

type OrganismEventDraft = Omit<OrganismEvent, 'sequence'>;

/**
 * Projects the current durable organism ledger into the canonical event
 * vocabulary consumed by API snapshots and the graph UI. Event identity is
 * stable across polls; sequence is deterministic for the projected snapshot.
 */
export function projectOrganismEvents(detail: ProjectDetail): OrganismEvent[] {
  const drafts: OrganismEventDraft[] = [];
  const currentIteration = detail.iterations.find((iteration) =>
    iteration.number === detail.project.currentIteration);
  const iterationById = new Map(detail.iterations.map((iteration) => [iteration.id, iteration]));
  const iterationByNumber = new Map(detail.iterations.map((iteration) => [iteration.number, iteration]));
  const projectId = detail.project.id;

  const add = (event: OrganismEventDraft) => drafts.push(event);

  for (const snapshot of detail.agentRuntimeSnapshots ?? []) {
    if (snapshot.stateChangedAt) {
      add({
        schemaVersion: '1.0',
        eventId: `runtime:${snapshot.role}:state:${snapshot.stateVersion}`,
        projectId,
        ...(currentIteration ? { iterationId: currentIteration.id } : {}),
        type: 'agent.state.changed',
        correlationId: `iteration:${detail.project.currentIteration}:${snapshot.role}:runtime`,
        actor: agentActor(projectId, snapshot.role),
        subjectRole: snapshot.role,
        summary: `${roleLabel(snapshot.role)} is ${humanizeState(snapshot.state)}.`,
        payload: {
          state: snapshot.state,
          stateVersion: snapshot.stateVersion,
          graphVersion: snapshot.graphVersion,
          mailboxDepth: snapshot.mailboxDepth,
          activeOrderCount: snapshot.activeOrderCount,
          blockerCount: snapshot.blockerCount,
          pendingQuestionCount: snapshot.pendingQuestionCount,
          activity: snapshot.activity,
        },
        createdAt: snapshot.stateChangedAt,
      });
    }
    if (snapshot.activity?.startedAt) {
      add({
        schemaVersion: '1.0',
        eventId: `runtime:${snapshot.role}:activity:${snapshot.stateVersion}`,
        projectId,
        ...(currentIteration ? { iterationId: currentIteration.id } : {}),
        type: 'agent.activity.started',
        correlationId: `iteration:${detail.project.currentIteration}:${snapshot.role}:runtime`,
        actor: agentActor(projectId, snapshot.role),
        subjectRole: snapshot.role,
        summary: snapshot.activity.summary,
        payload: {
          activityType: snapshot.activity.type,
          state: snapshot.state,
          stateVersion: snapshot.stateVersion,
        },
        createdAt: snapshot.activity.startedAt,
      });
    }
  }

  for (const message of detail.agentMessages ?? []) {
    const iteration = iterationByNumber.get(message.iterationNumber);
    const payload = {
      messageId: message.messageId ?? message.id,
      interactionId: message.id,
      from: message.from,
      to: message.to,
      kind: message.kind,
      name: message.name,
      status: message.status,
      priority: message.priority,
      requiresAcknowledgement: message.requiresAcknowledgement,
      deliveredAt: message.deliveredAt,
      live: message.live ?? false,
      artifactRefs: message.artifactRefs,
      dimensions: message.dimensions,
    };
    add({
      schemaVersion: '1.0',
      eventId: `message:${message.id}:sent`,
      projectId,
      ...(iteration ? { iterationId: iteration.id } : {}),
      type: 'message.sent',
      correlationId: message.correlationId ?? `message:${message.messageId ?? message.id}`,
      actor: partyActor(projectId, message.from, message.id),
      ...(messageSubjectRole(message.from, message.to) ? { subjectRole: messageSubjectRole(message.from, message.to) } : {}),
      summary: message.summary,
      payload,
      createdAt: message.createdAt,
    });
    if (message.deliveredAt) {
      add({
        schemaVersion: '1.0',
        eventId: `message:${message.id}:delivered`,
        projectId,
        ...(iteration ? { iterationId: iteration.id } : {}),
        type: 'message.delivered',
        correlationId: message.correlationId ?? `message:${message.messageId ?? message.id}`,
        actor: systemActor('message_delivery', message.id),
        ...(messageSubjectRole(message.from, message.to) ? { subjectRole: messageSubjectRole(message.from, message.to) } : {}),
        summary: `${message.name} was delivered.`,
        payload,
        createdAt: message.deliveredAt,
      });
    }
  }

  const projectedArtifactVersions = new Set<string>();
  for (const artifact of detail.artifactVersions ?? []) {
    projectedArtifactVersions.add(`${artifact.artifactId}:${artifact.version}`);
    const role = artifact.producedByRole ?? undefined;
    add({
      schemaVersion: '1.0',
      eventId: `artifact-version:${artifact.id}`,
      projectId,
      ...(artifact.iterationId ? { iterationId: artifact.iterationId } : {}),
      type: artifact.version > 1 || artifact.supersedesVersionId ? 'artifact.revised' : 'artifact.created',
      correlationId: `artifact:${artifact.artifactId}`,
      actor: role ? agentActor(projectId, role) : systemActor('artifact_ledger', artifact.id),
      ...(role ? { subjectRole: role } : {}),
      summary: `${artifact.artifactName || artifact.artifactType} version ${artifact.version} was recorded.`,
      payload: {
        artifactId: artifact.artifactId,
        artifactVersionId: artifact.id,
        artifactType: artifact.artifactType,
        artifactName: artifact.artifactName,
        version: artifact.version,
        status: artifact.status,
        producedByRole: artifact.producedByRole,
        sourceRevision: artifact.sourceRevision,
        storageUri: artifact.storageUri,
      },
      createdAt: artifact.createdAt,
    });
  }

  // Older projects may predate the canonical artifact-version ledger. Keep
  // their real artifact records visible without duplicating projected versions.
  for (const artifact of detail.artifacts) {
    if (projectedArtifactVersions.has(`${artifact.id}:${artifact.version}`)) continue;
    add({
      schemaVersion: '1.0',
      eventId: `artifact:${artifact.id}:version:${artifact.version}`,
      projectId,
      iterationId: artifact.iterationId,
      type: artifact.version > 1 ? 'artifact.revised' : 'artifact.created',
      correlationId: `artifact:${artifact.id}`,
      actor: agentActor(projectId, artifact.producedBy),
      subjectRole: artifact.producedBy,
      summary: `${artifact.name || artifact.type} version ${artifact.version} was recorded.`,
      payload: {
        artifactId: artifact.id,
        artifactType: artifact.type,
        artifactName: artifact.name,
        version: artifact.version,
        status: artifact.status,
        producedByRole: artifact.producedBy,
        storageUri: artifact.repositoryUrl,
      },
      createdAt: artifact.createdAt,
    });
  }

  for (const finding of detail.findings ?? []) {
    const role = finding.raisedByRole ?? finding.ownerRole ?? undefined;
    const common = {
      findingId: finding.id,
      title: finding.title,
      description: finding.description,
      severity: finding.severity,
      status: finding.status,
      disposition: finding.disposition,
      ownerRole: finding.ownerRole,
      raisedByRole: finding.raisedByRole,
      subjectReferences: finding.subjectReferences,
      evidenceReferences: finding.evidenceReferences,
      sourceRevision: finding.sourceRevision,
    };
    add({
      schemaVersion: '1.0',
      eventId: `finding:${finding.id}:opened`,
      projectId,
      ...(finding.iterationId ? { iterationId: finding.iterationId } : {}),
      type: 'finding.opened',
      correlationId: finding.correlationId ?? `finding:${finding.id}`,
      actor: role ? agentActor(projectId, role) : systemActor('finding_ledger', finding.id),
      ...(finding.ownerRole || role ? { subjectRole: finding.ownerRole ?? role } : {}),
      summary: finding.title || 'A finding was recorded.',
      payload: common,
      createdAt: finding.createdAt,
    });
    if (['resolved', 'accepted_risk', 'dismissed'].includes(finding.status)) {
      add({
        schemaVersion: '1.0',
        eventId: `finding:${finding.id}:resolved`,
        projectId,
        ...(finding.iterationId ? { iterationId: finding.iterationId } : {}),
        type: 'finding.resolved',
        correlationId: finding.correlationId ?? `finding:${finding.id}`,
        actor: role ? agentActor(projectId, role) : systemActor('finding_ledger', finding.id),
        ...(finding.ownerRole || role ? { subjectRole: finding.ownerRole ?? role } : {}),
        summary: `${finding.title || 'Finding'} was ${humanizeState(finding.status)}.`,
        payload: common,
        createdAt: finding.resolvedAt ?? finding.updatedAt,
      });
    }
  }

  for (const proposal of detail.iterationReviewProposals ?? []) {
    add({
      schemaVersion: '1.0',
      eventId: `iteration-review-proposal:${proposal.id}`,
      projectId,
      iterationId: proposal.iterationId,
      type: 'iteration.review.proposed',
      correlationId: `iteration:${proposal.iterationNumber}:review`,
      actor: agentActor(projectId, 'manager'),
      subjectRole: 'gate',
      summary: proposal.managerRationale,
      payload: {
        proposalId: proposal.id,
        proposalVersion: proposal.proposalVersion,
        status: proposal.status,
        objectiveStatus: proposal.objectiveStatus,
        includedRevision: proposal.includedRevision,
        gateStatus: proposal.gateStatus,
        gateRationale: proposal.gateRationale,
        recommendation: proposal.recommendation,
      },
      createdAt: proposal.createdAt,
    });
  }

  for (const operation of detail.repositoryOperations ?? []) {
    if (!operation.resultingRevision || operation.status !== 'completed') continue;
    const role = operation.role ?? undefined;
    add({
      schemaVersion: '1.0',
      eventId: `repository-operation:${operation.id}:revision`,
      projectId,
      ...(operation.iterationId ? { iterationId: operation.iterationId } : {}),
      type: 'repository.revision.changed',
      correlationId: operation.correlationId ?? `repository-operation:${operation.id}`,
      actor: role ? agentActor(projectId, role) : systemActor('repository_operation', operation.id),
      ...(role ? { subjectRole: role } : {}),
      summary: operation.summary || `Repository revision changed to ${operation.resultingRevision}.`,
      payload: {
        repositoryOperationId: operation.id,
        operationType: operation.type,
        branchName: operation.branchName,
        paths: operation.paths,
        expectedBaseRevision: operation.expectedBaseRevision,
        resultingRevision: operation.resultingRevision,
        repositoryUrl: operation.repositoryUrl,
      },
      createdAt: operation.completedAt ?? operation.createdAt,
    });
  }

  for (const invocation of detail.modelInvocations ?? []) {
    const role = invocation.role ?? undefined;
    const actor = role ? agentActor(projectId, role) : systemActor('model_invocation', invocation.id);
    const correlationId = invocation.correlationId ?? `model-invocation:${invocation.id}`;
    const payload = {
      dimension: 'model',
      modelInvocationId: invocation.id,
      provider: invocation.provider,
      model: invocation.model,
      purpose: invocation.purpose,
      status: invocation.status,
      totalTokens: invocation.totalTokens,
      costUsd: invocation.costUsd,
      actionId: invocation.actionId,
      error: invocation.error,
    };
    if (invocation.startedAt) {
      add({
        schemaVersion: '1.0',
        eventId: `model-invocation:${invocation.id}:started`,
        projectId,
        ...(invocation.iterationId ? { iterationId: invocation.iterationId } : {}),
        type: 'agent.activity.started',
        correlationId,
        actor,
        ...(role ? { subjectRole: role } : {}),
        summary: `${role ? `${roleLabel(role)} started` : 'Started'} ${invocation.purpose.replaceAll('_', ' ')} with ${invocation.model}.`,
        payload: { ...payload, status: 'running' },
        createdAt: invocation.startedAt,
      });
    }
    if (invocation.completedAt) {
      add({
        schemaVersion: '1.0',
        eventId: `model-invocation:${invocation.id}:completed`,
        projectId,
        ...(invocation.iterationId ? { iterationId: invocation.iterationId } : {}),
        type: 'agent.activity.completed',
        correlationId,
        actor,
        ...(role ? { subjectRole: role } : {}),
        summary: `${invocation.purpose.replaceAll('_', ' ')} ${humanizeState(invocation.status)} for ${invocation.model}.`,
        payload,
        createdAt: invocation.completedAt,
      });
    }
  }

  for (const action of detail.agentActions ?? []) {
    if (action.role !== 'test' || action.status !== 'completed' || !action.completedAt) continue;
    add({
      schemaVersion: '1.0',
      eventId: `agent-action:${action.id}:test-completed`,
      projectId,
      ...(action.iterationId ? { iterationId: action.iterationId } : {}),
      type: 'test.completed',
      correlationId: action.correlationId ?? `agent-action:${action.id}`,
      actor: agentActor(projectId, 'test'),
      subjectRole: 'test',
      summary: action.summary || 'Test activity completed.',
      payload: {
        actionId: action.id,
        actionKind: action.kind,
        blocking: action.blocking,
        output: action.output,
      },
      createdAt: action.completedAt,
    });
  }

  for (const media of detail.media) {
    if (media.kind !== 'preview') continue;
    add({
      schemaVersion: '1.0',
      eventId: `preview:${media.id}:deployed`,
      projectId,
      ...(media.iterationId ? { iterationId: media.iterationId } : {}),
      type: 'preview.deployed',
      correlationId: media.iterationId ? `iteration:${iterationById.get(media.iterationId)?.number ?? detail.project.currentIteration}:preview` : 'project:preview',
      actor: agentActor(projectId, 'deployment'),
      subjectRole: 'deployment',
      summary: `${media.title || 'Preview'} was deployed.`,
      payload: {
        mediaId: media.id,
        previewUrl: media.url,
        sourceRevision: media.sourceRevision,
        imageDigest: media.imageDigest,
        expiresAt: media.expiresAt,
      },
      createdAt: media.createdAt,
    });
  }

  for (const review of detail.iterationReviews ?? []) {
    add({
      schemaVersion: '1.0',
      eventId: `iteration-review:${review.id}:decision`,
      projectId,
      iterationId: review.iterationId,
      type: 'decision.recorded',
      correlationId: `iteration:${review.iterationNumber}:review`,
      actor: humanActor(),
      subjectRole: 'manager',
      summary: review.overallDirection || review.feedback || `The human review decision was ${humanizeState(review.decision)}.`,
      payload: {
        reviewId: review.id,
        decision: review.decision,
        previewAttestation: review.previewAttestation,
      },
      createdAt: review.createdAt,
    });
  }

  for (const comment of detail.agentComments ?? []) {
    const iteration = comment.iterationId ? iterationById.get(comment.iterationId) : currentIteration;
    add({
      schemaVersion: '1.0',
      eventId: `agent-comment:${comment.id}`,
      projectId,
      ...(comment.iterationId ? { iterationId: comment.iterationId } : {}),
      type: 'human.feedback.received',
      correlationId: `iteration:${iteration?.number ?? detail.project.currentIteration}:${comment.agentRole}:human-feedback`,
      actor: comment.authorType === 'human'
        ? humanActor()
        : comment.authorRole
          ? agentActor(projectId, comment.authorRole)
          : systemActor('agent_comment', comment.id),
      subjectRole: comment.agentRole,
      summary: comment.body,
      payload: {
        commentId: comment.id,
        targetRole: comment.agentRole,
        authorType: comment.authorType,
        authorRole: comment.authorRole,
      },
      createdAt: comment.createdAt,
    });
  }

  const artifactById = new Map(detail.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const feedback of detail.artifactFeedback ?? []) {
    const artifact = artifactById.get(feedback.artifactId);
    add({
      schemaVersion: '1.0',
      eventId: `artifact-feedback:${feedback.id}`,
      projectId,
      iterationId: feedback.iterationId,
      type: 'human.feedback.received',
      correlationId: `artifact:${feedback.artifactId}`,
      actor: humanActor(),
      ...(artifact ? { subjectRole: artifact.producedBy } : {}),
      summary: feedback.feedback || 'The artifact was reviewed with no additional written feedback.',
      payload: {
        feedbackId: feedback.id,
        artifactId: feedback.artifactId,
        artifactName: artifact?.name,
        targetRole: artifact?.producedBy,
        reviewId: feedback.reviewId,
      },
      createdAt: feedback.createdAt,
    });
  }

  for (const question of detail.questions ?? []) {
    if (!question.answer) continue;
    const answerSummary = question.answer.resolution === 'custom'
      ? question.answer.answer
      : question.answer.resolution === 'agent_decides'
        ? 'The responsible agent may decide within its declared authority.'
        : 'The human selected one of the supplied options.';
    add({
      schemaVersion: '1.0',
      eventId: `question:${question.id}:answered:${question.answer.id}`,
      projectId,
      ...(question.iterationId ? { iterationId: question.iterationId } : {}),
      type: 'question.answered',
      correlationId: `question:${question.decisionKey}`,
      actor: question.answer.answeredBy === 'human' ? humanActor() : agentActor(projectId, question.agentRole),
      subjectRole: question.agentRole,
      summary: answerSummary,
      payload: {
        questionId: question.id,
        answerId: question.answer.id,
        decisionKey: question.decisionKey,
        resolution: question.answer.resolution,
      },
      createdAt: question.answer.createdAt,
    });
  }

  return drafts
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.eventId.localeCompare(right.eventId))
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

/** Converts a canonical event to the compact graph/activity view model. */
export function interactionFromOrganismEvent(
  event: OrganismEvent,
  detail: Pick<ProjectDetail, 'project' | 'iterations'>,
): AgentInteraction | undefined {
  // Delivery and acknowledgement are lifecycle transitions on the original
  // message, not additional messages travelling across the graph.
  if (event.type === 'message.delivered' || event.type === 'message.acknowledged') return undefined;

  const iterationNumber = event.iterationId
    ? detail.iterations.find((iteration) => iteration.id === event.iterationId)?.number ?? detail.project.currentIteration
    : detail.project.currentIteration;
  const actor = interactionPartyFromActor(event);
  const targetRole = payloadRole(event.payload.targetRole)
    ?? payloadRole(event.payload.ownerRole)
    ?? event.subjectRole;
  const common = {
    iterationNumber,
    correlationId: event.correlationId,
    createdAt: event.createdAt,
    summary: event.summary,
  };

  if (event.type === 'message.sent') {
    const from = payloadParty(event.payload.from) ?? actor;
    const to = Array.isArray(event.payload.to)
      ? event.payload.to.map(payloadParty).filter((party): party is AgentInteractionParty => Boolean(party))
      : [];
    const kind = payloadInteractionKind(event.payload.kind) ?? 'status';
    const status = payloadInteractionStatus(event.payload.status) ?? 'completed';
    return {
      id: payloadString(event.payload.interactionId) ?? `event:${event.eventId}`,
      messageId: payloadString(event.payload.messageId) ?? event.eventId,
      ...common,
      from,
      to: to.length > 0 ? to : ['project'],
      kind,
      name: payloadString(event.payload.name) ?? event.summary,
      status,
      ...(payloadPriority(event.payload.priority) ? { priority: payloadPriority(event.payload.priority) } : {}),
      ...(typeof event.payload.requiresAcknowledgement === 'boolean'
        ? { requiresAcknowledgement: event.payload.requiresAcknowledgement }
        : {}),
      ...(payloadString(event.payload.deliveredAt) ? { deliveredAt: payloadString(event.payload.deliveredAt) } : {}),
      ...(Array.isArray(event.payload.artifactRefs)
        ? { artifactRefs: event.payload.artifactRefs as NonNullable<AgentInteraction['artifactRefs']> }
        : {}),
      ...(payloadDimensions(event.payload.dimensions).length > 0
        ? { dimensions: payloadDimensions(event.payload.dimensions) }
        : {}),
      live: event.payload.live === true,
    };
  }

  if (event.type === 'agent.state.changed' || event.type === 'agent.activity.started' || event.type === 'agent.activity.completed') {
    const state = payloadString(event.payload.state);
    const recordedStatus = payloadString(event.payload.status);
    const status: AgentInteractionStatus = recordedStatus === 'failed' || recordedStatus === 'cancelled' || state === 'blocked'
      ? 'blocked'
      : event.type === 'agent.activity.started' && event.payload.dimension === 'model' && recordedStatus === 'running'
        ? 'in_progress'
      : state === 'waiting_on_agent' || state === 'waiting_on_human'
        ? 'pending'
        : ['planning', 'working', 'reviewing', 'communicating'].includes(state ?? '')
          ? 'in_progress'
          : 'completed';
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: ['project'],
      kind: state === 'blocked' ? 'blocker' : 'status',
      name: event.type === 'agent.state.changed'
        ? 'Agent state changed'
        : event.type === 'agent.activity.started'
          ? 'Agent activity started'
          : 'Agent activity completed',
      status,
      ...(event.payload.dimension === 'model' ? { dimensions: ['model' as const] } : {}),
      live: false,
    };
  }

  if (event.type === 'artifact.created' || event.type === 'artifact.revised') {
    const artifactId = payloadString(event.payload.artifactId);
    const artifactType = payloadString(event.payload.artifactType);
    const artifactName = payloadString(event.payload.artifactName) ?? event.summary;
    const version = event.payload.version;
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: ['project'],
      kind: 'evidence',
      name: artifactName,
      status: 'completed',
      dimensions: ['artifact'],
      ...(artifactId && artifactType && (typeof version === 'number' || typeof version === 'string')
        ? {
            artifactRefs: [{
              artifactId,
              artifactType,
              version: String(version),
              name: artifactName,
              ...(event.subjectRole ? { ownerRole: event.subjectRole } : {}),
              ...(payloadString(event.payload.storageUri) ? { storageUri: payloadString(event.payload.storageUri) } : {}),
            }],
          }
        : {}),
      live: false,
    };
  }

  if (event.type === 'finding.opened' || event.type === 'finding.resolved' || event.type === 'policy.violation.detected') {
    const disposition = payloadString(event.payload.disposition);
    const severity = payloadString(event.payload.severity);
    const blocked = event.type !== 'finding.resolved' && (disposition === 'block_iteration' || severity === 'critical');
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: targetRole && targetRole !== actor ? [targetRole] : ['project'],
      kind: blocked || event.type === 'policy.violation.detected' ? 'blocker' : 'finding',
      name: payloadString(event.payload.title) ?? (event.type === 'finding.resolved' ? 'Finding resolved' : 'Finding opened'),
      status: event.type === 'finding.resolved' ? 'completed' : blocked ? 'blocked' : 'pending',
      ...(severity === 'critical' ? { priority: 'critical' as const }
        : severity === 'high' ? { priority: 'high' as const }
          : severity === 'low' || severity === 'info' ? { priority: 'low' as const }
            : {}),
      dimensions: ['finding'],
      live: false,
    };
  }

  if (event.type === 'iteration.review.proposed') {
    const status = payloadString(event.payload.status);
    const recommendation = payloadString(event.payload.recommendation);
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: recommendation === 'send_for_human_review' ? ['human'] : targetRole ? [targetRole] : ['project'],
      kind: 'review_proposal',
      name: 'Iteration review proposal',
      status: status === 'gate_blocked' ? 'blocked'
        : status === 'rejected' ? 'rejected'
          : status === 'draft' || status === 'proposed' ? 'pending'
            : 'completed',
      live: false,
    };
  }

  if (event.type === 'human.feedback.received') {
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: 'human',
      to: targetRole ? [targetRole] : ['project'],
      kind: payloadString(event.payload.artifactId) ? 'revision_request' : 'request',
      name: payloadString(event.payload.artifactName) ?? 'Human feedback received',
      status: 'completed',
      dimensions: ['human'],
      live: false,
    };
  }

  if (event.type === 'question.answered') {
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: targetRole ? [targetRole] : ['project'],
      kind: 'answer',
      name: 'Question answered',
      status: 'completed',
      live: false,
    };
  }

  const structuralKind: Partial<Record<OrganismEvent['type'], AgentInteractionKind>> = {
    'decision.recorded': 'decision',
    'repository.revision.changed': 'status',
    'test.completed': 'evidence',
    'preview.deployed': 'handoff',
    'agent.registered': 'status',
  };
  const kind = structuralKind[event.type];
  if (!kind) return undefined;
  return {
    id: `event:${event.eventId}`,
    ...common,
    from: actor,
    to: targetRole && targetRole !== actor ? [targetRole] : ['project'],
    kind,
    name: humanizeEventType(event.type),
    status: 'completed',
    ...(event.type === 'repository.revision.changed' ? { dimensions: ['repository' as const] }
      : event.payload.dimension === 'model' ? { dimensions: ['model' as const] }
        : {}),
    live: false,
  };
}

function agentActor(projectId: string, role: AgentRole): OrganismEvent['actor'] {
  return {
    projectId,
    role,
    workflowId: `project/${projectId}/agent/${role}`,
  };
}

function humanActor(): OrganismEvent['actor'] {
  return { humanId: 'human-collaborator', displayName: 'Human collaborator' };
}

function systemActor(activityType: string, activityId: string): OrganismEvent['actor'] {
  return { activityType, activityId };
}

function partyActor(projectId: string, party: AgentInteractionParty, id: string): OrganismEvent['actor'] {
  if (isAgentRole(party)) return agentActor(projectId, party);
  if (party === 'human') return humanActor();
  return systemActor('organism_message', id);
}

function interactionPartyFromActor(event: OrganismEvent): AgentInteractionParty {
  if ('role' in event.actor) return event.actor.role;
  if ('humanId' in event.actor) return 'human';
  return 'system';
}

function payloadString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function payloadRole(value: unknown): AgentRole | undefined {
  return typeof value === 'string' && isAgentRoleValue(value) ? value : undefined;
}

function payloadParty(value: unknown): AgentInteractionParty | undefined {
  if (value === 'human' || value === 'system' || value === 'project') return value;
  return payloadRole(value);
}

function payloadInteractionKind(value: unknown): AgentInteractionKind | undefined {
  return typeof value === 'string' && interactionKinds.includes(value as AgentInteractionKind)
    ? value as AgentInteractionKind
    : undefined;
}

function payloadInteractionStatus(value: unknown): AgentInteractionStatus | undefined {
  return typeof value === 'string' && interactionStatuses.includes(value as AgentInteractionStatus)
    ? value as AgentInteractionStatus
    : undefined;
}

function payloadPriority(value: unknown): AgentInteraction['priority'] | undefined {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'critical' ? value : undefined;
}

function payloadDimensions(value: unknown): NonNullable<AgentInteraction['dimensions']> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is NonNullable<AgentInteraction['dimensions']>[number] =>
    entry === 'artifact' || entry === 'finding' || entry === 'human' || entry === 'model' || entry === 'repository');
}

function messageSubjectRole(from: AgentInteractionParty, recipients: AgentInteractionParty[]): AgentRole | undefined {
  if (isAgentRole(from)) return from;
  return recipients.find(isAgentRole);
}

function isAgentRole(value: AgentInteractionParty): value is AgentRole {
  return !['human', 'system', 'project'].includes(value);
}

function isAgentRoleValue(value: string): value is AgentRole {
  return agentRoles.includes(value as AgentRole);
}

function roleLabel(role: AgentRole): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

function humanizeState(value: string): string {
  return value.replaceAll('_', ' ');
}

function humanizeEventType(value: string): string {
  const words = value.replaceAll('.', ' ');
  return words[0]!.toUpperCase() + words.slice(1);
}

const agentRoles: readonly AgentRole[] = [
  'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
  'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation',
];

const interactionKinds: readonly AgentInteractionKind[] = [
  'order', 'request', 'question', 'answer', 'status', 'handoff', 'evidence',
  'finding', 'decision', 'review', 'acknowledgement', 'blocker',
  'revision_request', 'review_proposal', 'control',
];

const interactionStatuses: readonly AgentInteractionStatus[] = [
  'pending', 'acknowledged', 'in_progress', 'completed', 'blocked', 'rejected',
];
