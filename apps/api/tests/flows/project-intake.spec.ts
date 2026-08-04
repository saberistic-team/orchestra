import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { NotFoundException } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../dist/app.module.js';
import { TEMPORAL_GATEWAY } from '../../dist/temporal-gateway.js';

test.describe('project intake journeys', () => {
  test.describe.configure({ mode: 'serial' });

  let app: NestFastifyApplication;
  let api: APIRequestContext;
  const startedProjects: string[] = [];
  const projects = new Map<string, Record<string, unknown>>();

  test.beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TEMPORAL_GATEWAY)
      .useValue({
        createProject: async (brief: Record<string, unknown>) => {
          const now = new Date().toISOString();
          const project = { ...brief, id: crypto.randomUUID(), status: 'discovering', currentIteration: 1, previewUrl: null, repositoryUrl: null, repositoryOwner: null, repositoryName: null, createdAt: now, updatedAt: now };
          projects.set(project.id, project);
          startedProjects.push(project.id);
          return project;
        },
        listProjects: async () => [...projects.values()].map((project) => ({ ...project, latestEvent: null, artifactCount: 1 })),
        findProject: async (id: string) => {
          const project = projects.get(id) ?? (() => { throw new NotFoundException('Project not found'); })();
          return { project, iterations: [], events: [], artifacts: [], media: [] };
        },
        reviewIteration: async () => undefined,
        answerAgentQuestion: async () => undefined,
        commentOnAgent: async () => undefined,
        commentOnArtifact: async () => undefined,
        resumeProject: async () => undefined,
      })
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.listen(0, '127.0.0.1');
    api = await request.newContext({ baseURL: await app.getUrl() });
  });

  test.afterAll(async () => {
    await api?.dispose();
    await app?.close();
  });

  test('a founder submits an intention and returns to the saved project', async () => {
    const submission = await api.post('/projects', {
      data: {
        name: 'Neighborhood helper',
        intent: 'Help neighbors request and offer small practical favors safely.',
        audience: 'People living in the same neighborhood',
        success: 'One neighbor can publish a request and another can accept it.',
        constraints: ['Must be understandable without software knowledge'],
      },
    });

    expect(submission.status()).toBe(201);
    const project = await submission.json();
    expect(project).toMatchObject({ name: 'Neighborhood helper', status: 'discovering' });
    expect(startedProjects).toContain(project.id);

    const revisit = await api.get(`/projects/${project.id}`);
    expect(revisit.status()).toBe(200);
    expect((await revisit.json()).project).toEqual(project);
  });

  test('an incomplete idea can be refined and resubmitted', async () => {
    const incomplete = await api.post('/projects', { data: { name: 'X', intent: 'Build it' } });
    expect(incomplete.status()).toBe(400);

    const refined = await api.post('/projects', {
      data: {
        name: 'Invoice companion',
        intent: 'Help independent workers understand which invoices still need attention.',
        audience: 'Independent consultants with limited accounting experience',
        success: 'A consultant can see overdue invoices and choose the next follow-up.',
      },
    });
    expect(refined.status()).toBe(201);
    expect((await refined.json()).constraints).toEqual([]);
  });

  test('a missing project produces a clear not-found outcome', async () => {
    const response = await api.get('/projects/00000000-0000-4000-8000-000000000000');
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ message: 'Project not found' });
  });
});
