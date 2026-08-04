import { describe, expect, it } from 'vitest';
import type { AgentArtifactReference, AgentWorkflowResult, Project, ProjectIteration } from '@orchestra/contracts';
import {
  acceptIterationReviewSubmission,
  agentArtifactContextPatterns,
  agentOrderContext,
  createReviewCheckpoint,
  evaluateGateReadiness,
  mergeAgentArtifactContext,
  mergeHumanGuidance,
  reviewAdvancesIteration,
} from './workflows.js';
import { PREVIEW_CONTRACT_VERSION, PREVIEW_RUNTIME_CONTRACT, deliveryAgentGraph, type PreviewDeploymentResult } from '@orchestra/contracts';

const now = '2026-08-03T12:00:00.000Z';
const project: Project = {
  id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
  name: 'Orchestra',
  intent: 'Help a person build software from their intentions.',
  audience: 'Non-technical founders',
  success: 'A reviewed first release is produced safely.',
  constraints: [],
  status: 'building',
  currentIteration: 2,
  previewUrl: null,
  repositoryUrl: 'https://forgejo.example/orchestra/project',
  repositoryOwner: 'orchestra',
  repositoryName: 'project',
  createdAt: now,
  updatedAt: now,
};
const iteration: ProjectIteration = {
  id: 'c67a2fd5-e829-40dc-a6f5-d15e4758515d',
  projectId: project.id,
  number: 2,
  objective: 'Revise the walking skeleton.',
  status: 'changes_requested',
  startedAt: now,
  completedAt: null,
  issueNumber: 8,
  branchName: 'iteration-2-agents',
  pullRequestNumber: 9,
  pullRequestUrl: 'https://forgejo.example/orchestra/project/pulls/9',
};
const previewRevision = '0123456789abcdef0123456789abcdef01234567';
const previewImageDigest = `sha256:${'a'.repeat(64)}`;
const preview: PreviewDeploymentResult = {
  contractVersion: PREVIEW_CONTRACT_VERSION,
  title: 'Iteration 2 preview',
  publicUrl: 'http://localhost:4173/previews/iteration-2',
  internalUrl: 'http://preview-runtime:8080/',
  revision: previewRevision,
  imageDigest: previewImageDigest,
  expiresAt: '2026-08-03T14:00:00.000Z',
  source: 'managed',
  runtime: PREVIEW_RUNTIME_CONTRACT,
};
const artifact = (id: string, content: string): AgentArtifactReference => ({
  id,
  type: 'requirements-baseline',
  name: 'Requirements baseline',
  content,
  mimeType: 'text/markdown',
  producedBy: 'requirements',
  repositoryUrl: `https://forgejo.example/artifacts/${id}`,
});

describe('agent order context', () => {
  it('loads a role\'s previous outputs in addition to its declared inputs', () => {
    const builder = deliveryAgentGraph.find((step) => step.role === 'builder')!;

    expect(agentArtifactContextPatterns(builder)).toEqual(expect.arrayContaining([
      'build-submission', 'source-file:*', 'iteration-plan',
    ]));
  });

  it('keeps current artifacts ahead of prior versions and removes duplicate identities', () => {
    const merged = mergeAgentArtifactContext(
      [artifact('current', 'current'), artifact('shared', 'current shared')],
      [artifact('prior', 'prior'), artifact('shared', 'old shared')],
    );

    expect(merged.map((entry) => entry.id)).toEqual(['current', 'shared', 'prior']);
    expect(merged.find((entry) => entry.id === 'shared')?.content).toBe('current shared');
  });

  it('always includes repository coordinates and role-specific human direction', () => {
    const context = agentOrderContext('Base intent', project, iteration, 'builder', [artifact('prior', 'Prior accepted requirements')], [
      { key: 'all', kind: 'overall_direction', summary: 'Keep the revision narrow.' },
      { key: 'builder', kind: 'agent_comment', role: 'builder', summary: 'Preserve the existing API.' },
      { key: 'ux', kind: 'agent_comment', role: 'ux', summary: 'Change the color palette.' },
    ]);

    expect(context).toContain('https://forgejo.example/orchestra/project');
    expect(context).toContain('Iteration branch: iteration-2-agents');
    expect(context).toContain('Prior accepted requirements');
    expect(context).toContain('Keep the revision narrow.');
    expect(context).toContain('Preserve the existing API.');
    expect(context).not.toContain('Change the color palette.');
  });

  it('merges durable project decisions and feedback without duplicating replayed entries', () => {
    const merged = mergeHumanGuidance(
      [{ key: 'decision:export.format', kind: 'question_answer', summary: 'Old answer' }],
      [
        { key: 'decision:export.format', kind: 'question_answer', summary: 'Latest durable answer' },
        { key: 'comment:builder', kind: 'agent_comment', role: 'builder', summary: 'Keep it small.' },
      ],
    );

    expect(merged).toEqual([
      { key: 'decision:export.format', kind: 'question_answer', summary: 'Latest durable answer' },
      { key: 'comment:builder', kind: 'agent_comment', role: 'builder', summary: 'Keep it small.' },
    ]);
  });
});

describe('iteration review advancement', () => {
  it('requires a structured Gate pass and every declared upstream evidence artifact', () => {
    const gateResult: AgentWorkflowResult = {
      draft: {
        type: 'gate-decision',
        name: 'Gate decision',
        content: 'All required evidence is traceable.',
        mimeType: 'text/markdown',
        producedBy: 'gate',
        model: 'test-model',
        gateDecision: { status: 'pass', rationale: 'Evidence is complete.', missingEvidence: [] },
      },
      artifacts: [],
    };
    const inputs = [
      { ...artifact('threat', 'Threat model'), type: 'threat-model', producedBy: 'security' as const },
      { ...artifact('test', 'Test evidence'), type: 'test-evidence', producedBy: 'test' as const },
      { ...artifact('review', 'Review decision'), type: 'review-decision', producedBy: 'reviewer' as const },
    ];

    expect(evaluateGateReadiness(gateResult, inputs, [
      'threat-model', 'test-evidence', 'review-decision',
    ])).toEqual({ ready: true, reasons: [] });

    const missing = evaluateGateReadiness(gateResult, inputs.slice(0, 2), [
      'threat-model', 'test-evidence', 'review-decision',
    ]);
    expect(missing.ready).toBe(false);
    expect(missing.reasons).toContain('Required upstream artifact is absent: review-decision');
  });

  it('does not let a prose-only or explicitly blocked Gate open human review', () => {
    const proseOnly: AgentWorkflowResult = {
      draft: {
        type: 'gate-decision', name: 'Gate decision', content: 'Looks good.',
        mimeType: 'text/markdown', producedBy: 'gate', model: 'test-model',
      },
      artifacts: [],
    };
    expect(evaluateGateReadiness(proseOnly, [], []).ready).toBe(false);

    const blocked: AgentWorkflowResult = {
      ...proseOnly,
      draft: {
        ...proseOnly.draft,
        gateDecision: {
          status: 'blocked',
          rationale: 'Executable validation is incomplete.',
          missingEvidence: ['browser assertion results'],
        },
      },
    };
    const assessment = evaluateGateReadiness(blocked, [], []);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toEqual(expect.arrayContaining([
      'Gate blocked review: Executable validation is incomplete.',
      'Gate reported missing evidence: browser assertion results',
    ]));
  });

  it('advances only after approval and a confirmed merge', () => {
    expect(reviewAdvancesIteration('approve', true)).toBe(true);
    expect(reviewAdvancesIteration('approved', true)).toBe(true);
    expect(reviewAdvancesIteration('approve', false)).toBe(false);
    expect(reviewAdvancesIteration('request_changes', false)).toBe(false);
    expect(reviewAdvancesIteration('changes_requested', false)).toBe(false);
  });

  it('rejects early, stale, wrong-token, and duplicate checkpointed reviews', () => {
    const checkpoint = {
      iterationId: iteration.id,
      iterationNumber: iteration.number,
      pullRequestNumber: iteration.pullRequestNumber!,
      reviewToken: `${iteration.id}:pr:${iteration.pullRequestNumber}:review:2`,
    };
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'review-submission-2',
      review: { decision: 'approve' as const, feedback: 'Approved.' },
    };

    expect(acceptIterationReviewSubmission(undefined, submission, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, { ...submission, iterationId: 'stale-iteration' }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, { ...submission, reviewToken: 'stale-token' }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set(['review-submission-2']))).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set())).toEqual({
      review: submission.review,
      idempotencyKey: 'review-submission-2',
    });
  });

  it('binds the review token to the deployed revision and image digest and requires matching unexpired approval attestation', () => {
    const checkpoint = createReviewCheckpoint(iteration, 3, preview);
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'revision-bound-review',
      review: { decision: 'approve' as const, feedback: '' },
    };

    expect(checkpoint).toMatchObject({
      previewRevision,
      previewImageDigest,
      previewExpiresAt: preview.expiresAt,
      previewUrl: preview.publicUrl,
    });
    expect(checkpoint.reviewToken).toContain(`:revision:${previewRevision}:`);
    expect(checkpoint.reviewToken).toContain(`:image:${previewImageDigest}:`);
    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      decision: 'approve',
      feedback: '',
      previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: now },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: 'f'.repeat(40), imageDigest: previewImageDigest, triedAt: now },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: `sha256:${'f'.repeat(64)}`, triedAt: now },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: 'not-a-date' },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: '2026-08-03T14:00:00.001Z' },
      },
    }, new Set())).toBeUndefined();
    expect(acceptIterationReviewSubmission(checkpoint, {
      ...submission,
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: now },
      },
    }, new Set())).toEqual({
      review: {
        ...submission.review,
        previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest, triedAt: now },
      },
      idempotencyKey: submission.idempotencyKey,
    });
  });

  it('preserves a revision-only checkpoint shape for pre-digest Temporal histories', () => {
    const checkpoint = createReviewCheckpoint(iteration, 5, preview, false);
    const legacyReview = {
      decision: 'approve',
      feedback: '',
      previewAttestation: { revision: previewRevision, triedAt: now },
    } as unknown as import('@orchestra/contracts').IterationReview;

    expect(checkpoint).toMatchObject({ previewRevision, previewUrl: preview.publicUrl });
    expect(checkpoint).not.toHaveProperty('previewImageDigest');
    expect(checkpoint).not.toHaveProperty('previewExpiresAt');
    expect(checkpoint.reviewToken).not.toContain(':image:');
    expect(acceptIterationReviewSubmission(checkpoint, {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'legacy-digest-rollout-review',
      review: legacyReview,
    }, new Set())).toBeDefined();
  });

  it('allows changes to be requested without preview attestation', () => {
    const checkpoint = createReviewCheckpoint(iteration, 4, preview);
    const submission = {
      iterationId: iteration.id,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey: 'revision-bound-changes',
      review: { decision: 'request_changes' as const, feedback: 'Please revise the empty state.' },
    };

    expect(acceptIterationReviewSubmission(checkpoint, submission, new Set())).toEqual({
      review: submission.review,
      idempotencyKey: submission.idempotencyKey,
    });
  });

  it('prevents an exact legacy review replay from approving a later checkpoint', () => {
    const legacyReview = { decision: 'approve' as const, feedback: 'Approved.' };
    const checkpoint = {
      iterationId: iteration.id,
      iterationNumber: iteration.number,
      pullRequestNumber: iteration.pullRequestNumber!,
      reviewToken: 'checkpoint-1',
    };
    const first = acceptIterationReviewSubmission(checkpoint, legacyReview, new Set());

    expect(first).toBeDefined();
    expect(acceptIterationReviewSubmission(
      { ...checkpoint, iterationId: 'later-iteration', reviewToken: 'checkpoint-2' },
      { feedback: 'Approved.', decision: 'approve' },
      new Set([first!.idempotencyKey]),
    )).toBeUndefined();
  });
});
