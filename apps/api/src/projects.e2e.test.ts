import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module.js';
import { TEMPORAL_GATEWAY } from './temporal-gateway.js';

describe('projects API e2e', () => {
  let app: NestFastifyApplication;
  const projects = new Map<string, Record<string, unknown>>();
  const createProject = vi.fn(async (brief: Record<string, unknown>) => {
    const now = new Date().toISOString();
    const project = { ...brief, id: crypto.randomUUID(), status: 'discovering', currentIteration: 1, previewUrl: null, repositoryUrl: null, repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now };
    projects.set(project.id, project);
    return project;
  });
  const findProject = vi.fn(async (id: string) => ({ project: projects.get(id), iterations: [], events: [], artifacts: [], media: [] }));
  const listProjects = vi.fn(async () => [...projects.values()].map((project) => ({ ...project, latestEvent: null, artifactCount: 1 })));
  const reviewIteration = vi.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TEMPORAL_GATEWAY)
      .useValue({
        createProject,
        findProject,
        listProjects,
        reviewIteration,
        answerAgentQuestion: vi.fn(),
        commentOnAgent: vi.fn(),
        commentOnArtifact: vi.fn(),
        resumeProject: vi.fn(),
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates and retrieves a project over HTTP', async () => {
    const response = await request(app.getHttpServer()).post('/projects').send({
      name: 'Orchestra',
      intent: 'Help a person build software from their intentions.',
      audience: 'Non-technical founders',
      success: 'A reviewed first release is produced safely.',
    }).expect(201);
    expect(response.body.id).toMatch(/[0-9a-f-]{36}/);
    const detail = await request(app.getHttpServer()).get(`/projects/${response.body.id}`).expect(200);
    expect(detail.body.project).toEqual(response.body);
    const list = await request(app.getHttpServer()).get('/projects').expect(200);
    expect(list.body).toHaveLength(1);
    expect(createProject).toHaveBeenCalledOnce();
    expect(findProject).toHaveBeenCalledWith(response.body.id);
  });

  it('returns a useful validation response', async () => {
    await request(app.getHttpServer()).post('/projects').send({ name: 'x' }).expect(400);
  });

  it('accepts only an iteration-bound, idempotent review submission', async () => {
    const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const iterationId = 'a67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const idempotencyKey = 'f67a2fd5-e829-40dc-a6f5-d15e4758515d';
    const submission = {
      iterationId,
      reviewToken: `${iterationId}:pr:2:review:1`,
      idempotencyKey,
      review: { decision: 'changes_requested', feedback: 'Keep the path short.' },
    };

    await request(app.getHttpServer()).post(`/projects/${projectId}/review`).send(submission).expect(201);
    expect(reviewIteration).toHaveBeenCalledWith(projectId, submission);
    await request(app.getHttpServer()).post(`/projects/${projectId}/review`).send({ decision: 'approved' }).expect(400);
  });
});
