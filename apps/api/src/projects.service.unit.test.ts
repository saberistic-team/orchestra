import { BadRequestException } from '@nestjs/common';
import type { ProjectDetail } from '@orchestra/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectsService, projectSnapshotEventId } from './projects.service.js';
import type { ProjectTemporalGateway } from './temporal-gateway.js';

const snapshotTime = '2026-08-04T20:00:00.000Z';

function projectDetail(updatedAt = snapshotTime, managerStateVersion = 7): ProjectDetail {
  return {
    project: {
      id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
      name: 'Orchestra',
      intent: 'Help a person build software from their intentions.',
      audience: 'Non-technical founders',
      success: 'A reviewed first release is produced safely.',
      constraints: [],
      status: 'building',
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: snapshotTime,
      updatedAt,
    },
    iterations: [],
    events: [],
    artifacts: [],
    media: [],
    executionGraph: {
      iterationNumber: 1,
      graphVersion: 3,
      nodes: [],
      edges: [],
      modelConcurrency: 1,
    },
    agentRuntimeSnapshots: [
      {
        role: 'test', state: 'observing', activity: null, stateChangedAt: null,
        mailboxDepth: 0, activeOrderCount: 0, blockerCount: 0, pendingQuestionCount: 0,
        graphVersion: 3, stateVersion: 2,
      },
      {
        role: 'manager', state: 'working', activity: null, stateChangedAt: snapshotTime,
        mailboxDepth: 1, activeOrderCount: 1, blockerCount: 0, pendingQuestionCount: 0,
        graphVersion: 3, stateVersion: managerStateVersion,
      },
    ],
  };
}

afterEach(() => vi.useRealTimers());

describe('ProjectsService', () => {
  it('persists a validated brief and starts its workflow', async () => {
    const project = {
      id: 'b67a2fd5-e829-40dc-a6f5-d15e4758515d',
      name: 'Orchestra',
      intent: 'Help a person build software from their intentions.',
      audience: 'Non-technical founders',
      success: 'A reviewed first release is produced safely.',
      constraints: [],
      status: 'discovering' as const,
      currentIteration: 1,
      previewUrl: null,
      repositoryUrl: null,
      repositoryOwner: null,
      repositoryName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const temporal = {
      createProject: vi.fn().mockResolvedValue(project),
      listProjects: vi.fn(),
      findProject: vi.fn(),
      reviewIteration: vi.fn(),
      answerAgentQuestion: vi.fn(),
      commentOnAgent: vi.fn(),
      commentOnArtifact: vi.fn(),
      resumeProject: vi.fn(),
    };
    const service = new ProjectsService(temporal as ProjectTemporalGateway);

    await expect(service.create(project)).resolves.toEqual(project);
    expect(temporal.createProject).toHaveBeenCalledWith({
      name: project.name,
      intent: project.intent,
      audience: project.audience,
      success: project.success,
      constraints: project.constraints,
    });
  });

  it('rejects invalid input before persistence', async () => {
    const temporal = { createProject: vi.fn(), listProjects: vi.fn(), findProject: vi.fn(), reviewIteration: vi.fn(), answerAgentQuestion: vi.fn(), commentOnAgent: vi.fn(), commentOnArtifact: vi.fn(), resumeProject: vi.fn() };
    const service = new ProjectsService(temporal as ProjectTemporalGateway);
    await expect(service.create({ name: 'x' } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(temporal.createProject).not.toHaveBeenCalled();
  });

  it('routes project reads through the Temporal workflow gateway', async () => {
    const temporal = { createProject: vi.fn(), listProjects: vi.fn(), findProject: vi.fn().mockResolvedValue({ project: { id: 'project-id' } }), reviewIteration: vi.fn(), answerAgentQuestion: vi.fn(), commentOnAgent: vi.fn(), commentOnArtifact: vi.fn(), resumeProject: vi.fn() };
    const service = new ProjectsService(temporal as unknown as ProjectTemporalGateway);
    await service.find('project-id');
    expect(temporal.findProject).toHaveBeenCalledWith('project-id');
  });

  it('streams only changed Temporal projections and stops polling after unsubscribe', async () => {
    vi.useFakeTimers();
    const initial = projectDetail();
    const changed = projectDetail('2026-08-04T20:00:01.000Z', 8);
    const temporal = {
      createProject: vi.fn(), listProjects: vi.fn(),
      findProject: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial).mockResolvedValueOnce(changed),
      reviewIteration: vi.fn(), answerAgentQuestion: vi.fn(), commentOnAgent: vi.fn(),
      commentOnArtifact: vi.fn(), resumeProject: vi.fn(),
    };
    const service = new ProjectsService(temporal as unknown as ProjectTemporalGateway);
    const events: Array<{ data: string; id: string }> = [];
    const subscription = service.snapshots(initial.project.id).subscribe((event) => events.push(event));

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data)).toEqual(initial);
    expect(events[0].id).toMatch(new RegExp(`^${snapshotTime.replaceAll('.', '\\.')}\\|state-manager-7\\.test-2\\|graph-3\\|content-[a-f0-9]{16}$`));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toHaveLength(2);
    expect(events[1].id).toMatch(/^2026-08-04T20:00:01\.000Z\|state-manager-8\.test-2\|graph-3\|content-[a-f0-9]{16}$/u);

    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(temporal.findProject).toHaveBeenCalledTimes(3);
  });

  it('shares one Temporal poller across concurrent viewers of a project', async () => {
    vi.useFakeTimers();
    const detail = projectDetail();
    const temporal = {
      createProject: vi.fn(), listProjects: vi.fn(), findProject: vi.fn().mockResolvedValue(detail),
      reviewIteration: vi.fn(), answerAgentQuestion: vi.fn(), commentOnAgent: vi.fn(),
      commentOnArtifact: vi.fn(), resumeProject: vi.fn(),
    };
    const service = new ProjectsService(temporal as unknown as ProjectTemporalGateway);
    const first = service.snapshots(detail.project.id).subscribe();
    const second = service.snapshots(detail.project.id).subscribe();

    await vi.advanceTimersByTimeAsync(0);
    expect(temporal.findProject).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(temporal.findProject).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    second.unsubscribe();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(temporal.findProject).toHaveBeenCalledTimes(2);
  });

  it('derives snapshot ids independently of runtime snapshot ordering', () => {
    const detail = projectDetail();
    const reversed = { ...detail, agentRuntimeSnapshots: [...(detail.agentRuntimeSnapshots ?? [])].reverse() };
    expect(projectSnapshotEventId(reversed)).toBe(projectSnapshotEventId(detail));
  });

  it('routes project lists and iteration reviews through Temporal', async () => {
    const temporal = { createProject: vi.fn(), listProjects: vi.fn().mockResolvedValue([]), findProject: vi.fn(), reviewIteration: vi.fn(), answerAgentQuestion: vi.fn(), commentOnAgent: vi.fn(), commentOnArtifact: vi.fn(), resumeProject: vi.fn() };
    const service = new ProjectsService(temporal as unknown as ProjectTemporalGateway);
    const iterationId = 'a67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const idempotencyKey = 'f67a2fd5-e829-40dc-a6f5-d15e4758515d';
    await service.list();
    await service.review('project-id', {
      iterationId,
      reviewToken: 'review-checkpoint-1',
      idempotencyKey,
      review: { decision: 'approved' },
    });
    expect(temporal.listProjects).toHaveBeenCalledOnce();
    expect(temporal.reviewIteration).toHaveBeenCalledWith('project-id', {
      iterationId,
      reviewToken: 'review-checkpoint-1',
      idempotencyKey,
      review: { decision: 'approved', feedback: '' },
    });
  });

  it('validates and routes human answers and feedback through the project workflow', async () => {
    const temporal = {
      createProject: vi.fn(), listProjects: vi.fn(), findProject: vi.fn(), reviewIteration: vi.fn(),
      answerAgentQuestion: vi.fn(), commentOnAgent: vi.fn(), commentOnArtifact: vi.fn(), resumeProject: vi.fn(),
    };
    const service = new ProjectsService(temporal as unknown as ProjectTemporalGateway);
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const questionId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const optionId = 'd67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const artifactId = 'e67a2fd5-e829-40dc-a6f5-d15e4758515d';

    await service.answerQuestion(projectId, questionId, { resolution: 'selected_option', optionId });
    await service.commentOnAgent(projectId, 'ux', { comment: 'Keep the first journey understandable without training.' });
    await service.commentOnArtifact(projectId, artifactId, { feedback: 'Show the empty state in this artifact.' });

    expect(temporal.answerAgentQuestion).toHaveBeenCalledWith(projectId, questionId, { resolution: 'selected_option', optionId });
    expect(temporal.commentOnAgent).toHaveBeenCalledWith(projectId, expect.objectContaining({
      projectId, agentRole: 'ux', body: 'Keep the first journey understandable without training.', authorType: 'human',
    }));
    expect(temporal.commentOnArtifact).toHaveBeenCalledWith(projectId, {
      artifactId, feedback: 'Show the empty state in this artifact.',
    });
  });
});
