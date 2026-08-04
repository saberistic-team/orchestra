import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProjectsService } from './projects.service.js';
import type { ProjectTemporalGateway } from './temporal-gateway.js';

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
