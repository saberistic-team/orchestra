import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { agentRoleSchema } from '@orchestra/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStore } from './index.js';

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
    })).resolves.toMatchObject({
      modelProvider: 'openrouter',
      modelInvocations: [expect.objectContaining({ requestId: 'generation-123', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.002 } })],
    });
    const projects = await store.list();
    expect(projects[0]).toMatchObject({ id: created.id, artifactCount: 2 });
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

    const previewRevision = 'a'.repeat(40);
    const previewImageDigest = `sha256:${'b'.repeat(64)}`;
    const previewTriedAt = '2026-08-03T13:00:00.000Z';
    const previewExpiresAt = '2026-08-03T14:00:00.000Z';
    await expect(store.addMedia({
      projectId: project.id,
      iterationId: iteration.id,
      kind: 'preview',
      title: 'Iteration 1 preview',
      url: 'https://preview.example.test/human-review-studio/iteration-1',
      sourceRevision: previewRevision,
      imageDigest: previewImageDigest,
      expiresAt: previewExpiresAt,
    })).resolves.toMatchObject({
      sourceRevision: previewRevision,
      imageDigest: previewImageDigest,
      expiresAt: previewExpiresAt,
    });

    const question = await store.addAgentQuestion({
      projectId: project.id,
      iterationId: iteration.id,
      agentRole: 'requirements',
      decisionKey: 'recovery.behavior',
      question: 'Which recovery behavior should be the default?',
      context: 'The requirement baseline contains two safe choices.',
      options: [
        { value: 'retry', label: 'Retry safely' },
        { value: 'return', label: 'Return to the previous step' },
      ],
      allowCustomAnswer: true,
      allowAgentDecide: true,
    });
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
    expect(awaitingMerge?.artifacts[0]).toMatchObject({ status: 'ready_for_review' });
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
    expect(merged?.artifacts[0]).toMatchObject({ status: 'approved' });

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
