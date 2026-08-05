import type { ProjectDetail } from '@orchestra/contracts';
import { describe, expect, it } from 'vitest';
import { buildInteractionLedger, filterActivityInteractions } from './AgentOrganism.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const iterationId = '22222222-2222-4222-8222-222222222222';

function detail(): ProjectDetail {
  return {
    project: {
      id: projectId,
      name: 'Typed organism',
      intent: 'Show only durable, explicitly typed coordination activity.',
      audience: 'Delivery teams',
      success: 'No text inference is needed for current snapshots.',
      constraints: [],
      status: 'building',
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:10:00.000Z',
    },
    iterations: [{
      id: iterationId,
      projectId,
      number: 1,
      objective: 'Consume typed organism events.',
      status: 'active',
      startedAt: '2026-08-04T12:00:00.000Z',
      completedAt: null,
      issueNumber: null,
      branchName: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
    }],
    events: [{
      id: '33333333-3333-4333-8333-333333333333',
      projectId,
      iterationNumber: 1,
      kind: 'system',
      title: 'Legacy text says failed and blocked',
      description: 'This must not be classified when a typed stream exists.',
      agentRole: 'builder',
      createdAt: '2026-08-04T12:01:00.000Z',
    }],
    artifacts: [],
    media: [],
    organismEvents: [
      {
        schemaVersion: '1.0',
        eventId: 'message:handoff:sent',
        projectId,
        iterationId,
        sequence: 1,
        type: 'message.sent',
        correlationId: 'iteration:1:builder:test',
        actor: { projectId, role: 'builder', workflowId: `project/${projectId}/agent/builder` },
        subjectRole: 'builder',
        summary: 'The candidate was sent to Test.',
        payload: {
          interactionId: 'handoff-1',
          messageId: 'protocol-handoff-1',
          from: 'builder',
          to: ['test'],
          kind: 'handoff',
          name: 'Candidate handoff',
          status: 'in_progress',
          live: true,
        },
        createdAt: '2026-08-04T12:02:00.000Z',
      },
      {
        schemaVersion: '1.0',
        eventId: 'repository:revision',
        projectId,
        iterationId,
        sequence: 2,
        type: 'repository.revision.changed',
        correlationId: 'repository:commit',
        actor: { projectId, role: 'builder', workflowId: `project/${projectId}/agent/builder` },
        subjectRole: 'builder',
        summary: 'The candidate revision was committed.',
        payload: { resultingRevision: 'a'.repeat(40) },
        createdAt: '2026-08-04T12:03:00.000Z',
      },
    ],
  };
}

describe('typed organism activity in the UI', () => {
  it('uses structured payload fields and never classifies legacy text when the typed stream exists', () => {
    const interactions = buildInteractionLedger(detail());

    expect(interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'handoff-1', from: 'builder', to: ['test'], kind: 'handoff', status: 'in_progress', live: true }),
      expect.objectContaining({ id: 'event:repository:revision', kind: 'status', dimensions: ['repository'], live: false }),
    ]));
    expect(interactions.some((interaction) => interaction.id.startsWith('event:33333333'))).toBe(false);
    expect(filterActivityInteractions(interactions, { dimension: 'repository' }).map((interaction) => interaction.id))
      .toEqual(['event:repository:revision']);
  });
});
