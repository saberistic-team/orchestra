import { expect, test } from '@playwright/test';

const now = '2026-08-03T12:00:00.000Z';
const previewRevision = 'a'.repeat(40);
const previewImageDigest = `sha256:${'b'.repeat(64)}`;
const previewExpiresAt = '2099-08-04T12:00:00.000Z';
const project = {
  id: '15f5f325-dca2-4016-9f1a-127cfdc909a5',
  name: 'Neighborhood helper',
  intent: 'Help neighbors request and offer small favors without complicated group chats.',
  audience: 'People who live in the same neighborhood',
  success: 'A neighbor can post a request and another neighbor can accept it.',
  constraints: [], status: 'awaiting_approval', currentIteration: 1, previewUrl: 'https://preview.example.test', repositoryUrl: 'http://localhost:3001/orchestra-agent/studio', repositoryOwner: 'orchestra-agent', repositoryName: 'studio', createdAt: now, updatedAt: now,
};

const detail = {
  project,
  iterations: [{ id: '25f5f325-dca2-4016-9f1a-127cfdc909a5', projectId: project.id, number: 1, objective: 'First useful increment', status: 'awaiting_review', startedAt: now, completedAt: null, issueNumber: 1, branchName: 'iteration-1-agents', pullRequestNumber: 1, pullRequestUrl: 'http://localhost:3001/orchestra-agent/studio/pulls/1' }],
  events: [
    { id: '35f5f325-dca2-4016-9f1a-127cfdc909a6', projectId: project.id, iterationNumber: 1, kind: 'agent', title: 'UX agent started', description: 'The UX agent is mapping the journey.', agentRole: 'ux', createdAt: now },
    { id: '35f5f325-dca2-4016-9f1a-127cfdc909a5', projectId: project.id, iterationNumber: 1, kind: 'artifact', title: 'Requirements baseline is ready', description: 'Requirements produced version 1 for review.', agentRole: 'requirements', createdAt: now },
  ],
  artifacts: [{ id: '45f5f325-dca2-4016-9f1a-127cfdc909a5', projectId: project.id, iterationId: '25f5f325-dca2-4016-9f1a-127cfdc909a5', type: 'requirements-baseline', name: 'Requirements baseline', version: 1, content: '# Requirements\n\n- A neighbor can request help.', mimeType: 'text/markdown', status: 'ready_for_review', producedBy: 'requirements', model: 'qwen3.5:9b', repositoryPath: 'artifacts/iteration-01/requirements.md', repositoryUrl: 'http://localhost:3001/orchestra-agent/studio/src/branch/iteration-1-agents/artifacts/iteration-01/requirements.md', createdAt: now, reviewedAt: null }],
  media: [
    { id: '55f5f325-dca2-4016-9f1a-127cfdc909a5', projectId: project.id, iterationId: '25f5f325-dca2-4016-9f1a-127cfdc909a5', kind: 'user_flow_video', title: 'Requesting a favor', url: 'https://media.example.test/flow.webm', sourceRevision: previewRevision, createdAt: now },
    { id: '65f5f325-dca2-4016-9f1a-127cfdc909a5', projectId: project.id, iterationId: '25f5f325-dca2-4016-9f1a-127cfdc909a5', kind: 'preview', title: 'Iteration 1 local Docker preview', url: project.previewUrl, sourceRevision: previewRevision, imageDigest: previewImageDigest, expiresAt: previewExpiresAt, createdAt: now },
  ],
};

test('a non-technical founder can save an idea and open its project studio', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== '/api/projects') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    const brief = route.request().postDataJSON();
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...project, ...brief, status: 'discovering', previewUrl: null }) });
  });

  await page.goto('http://127.0.0.1:4173');
  await expect(page.getByRole('heading', { name: 'Projects in motion.' })).toBeVisible();
  await page.getByRole('button', { name: 'Start a project →' }).click();
  await expect(page.getByRole('heading', { name: /Tell us the idea/ })).toBeVisible();
  await page.getByLabel('Give your idea a name').fill(project.name);
  await page.getByLabel('What should it help people do?').fill(project.intent);
  await page.getByLabel('Who is it for?').fill(project.audience);
  await page.getByLabel('How will we know it works?').fill(project.success);
  await page.reload();
  await expect(page.getByLabel('Give your idea a name')).toHaveValue(project.name);
  await page.getByRole('button', { name: 'Start my project →' }).click();
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  await expect(page.getByText('Requirements baseline is ready').first()).toBeVisible();
});

test('a project dashboard opens review artifacts, recordings, and preview link', async ({ page }) => {
  await page.route('**/api/projects/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }));
  await page.route('**/api/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...project, latestEvent: detail.events[0], artifactCount: 1 }]) }));
  await page.goto('http://127.0.0.1:4173/projects');
  await expect(page.getByRole('heading', { name: project.name })).toBeVisible();
  await page.getByRole('link', { name: project.name }).click();
  await expect(page.getByRole('heading', { name: 'Evidence by iteration' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'UX is working now.' })).toBeVisible();
  const organism = page.locator('section.organism');
  await expect(organism).toBeVisible();
  await expect(organism.locator('.organism-agent')).toHaveCount(14);
  await expect(organism.locator('.organism-agent').filter({ hasText: 'Deployment' })).toContainText('Dormant');
  await expect(organism.locator('.organism-agent').filter({ hasText: 'Validation' })).toContainText('Dormant');
  await expect(organism.getByRole('region', { name: /execution path/i })).toHaveCount(0);
  await expect(organism.getByRole('heading', { name: 'Recent agent exchanges' })).toBeVisible();
  await expect(organism.getByRole('tab', { name: /^Open/ })).toBeVisible();
  await expect(organism.getByRole('tab', { name: /^Answered/ })).toBeVisible();
  await expect(organism.getByRole('tab', { name: /^Comments/ })).toBeVisible();
  await organism.getByRole('tab', { name: 'Relationships' }).click();
  await organism.getByRole('button', { name: /Gate/ }).first().click();
  await expect(organism.getByRole('heading', { name: 'Gate in context' })).toBeVisible();
  await expect(organism.getByText('Authorizes an immutable release')).toBeVisible();
  await expect(page.getByText('Requesting a favor')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try the latest version ↗' })).toHaveAttribute('href', project.previewUrl);
  await expect(page.getByRole('link', { name: 'Open project repository ↗' })).toHaveAttribute('href', project.repositoryUrl);
  await page.getByRole('button', { name: 'Open Requirements baseline, version 1' }).click();
  const artifactDialog = page.getByRole('dialog', { name: 'Requirements baseline' });
  await expect(artifactDialog.locator('.markdown-viewer').getByRole('heading', { name: 'Requirements', exact: true })).toBeVisible();
  await artifactDialog.getByRole('button', { name: 'Close Requirements baseline' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const organismOverflow = await organism.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(organismOverflow.scrollWidth).toBeLessThanOrEqual(organismOverflow.clientWidth);
});

test('a newer iteration never falls back to an older preview', async ({ page }) => {
  const staleDetail = {
    ...detail,
    project: { ...project, status: 'building', currentIteration: 2 },
    iterations: [
      ...detail.iterations,
      { ...detail.iterations[0], id: '25f5f325-dca2-4016-9f1a-127cfdc909c7', number: 2, status: 'active' },
    ],
  };
  await page.route('**/api/projects/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleDetail) }));
  await page.goto(`http://127.0.0.1:4173/projects/${project.id}`);

  await expect(page.getByRole('button', { name: 'Preview coming soon' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try the latest version ↗' })).toHaveCount(0);
});

test('approval opens only the newest preview bound to the active checkpoint revision and image digest', async ({ page }) => {
  const exactPreviewUrl = 'http://localhost:49152/';
  const olderExactPreviewUrl = 'http://localhost:49150/';
  const reviewBodies: Array<Record<string, unknown>> = [];
  const revisionBoundDetail = {
    ...detail,
    media: [
      {
        ...detail.media[1],
        id: '65f5f325-dca2-4016-9f1a-127cfdc909c6',
        url: 'http://localhost:49151/',
        sourceRevision: previewRevision,
        imageDigest: `sha256:${'c'.repeat(64)}`,
        createdAt: '2026-08-03T12:10:00.000Z',
      },
      {
        ...detail.media[1],
        id: '65f5f325-dca2-4016-9f1a-127cfdc909c7',
        url: olderExactPreviewUrl,
        sourceRevision: previewRevision,
        imageDigest: previewImageDigest,
        createdAt: '2026-08-03T12:05:00.000Z',
      },
      {
        ...detail.media[1],
        id: '65f5f325-dca2-4016-9f1a-127cfdc909c8',
        url: exactPreviewUrl,
        sourceRevision: previewRevision,
        imageDigest: previewImageDigest,
        createdAt: '2026-08-03T12:15:00.000Z',
      },
    ],
    reviewCheckpoint: {
      iterationId: detail.iterations[0].id,
      iterationNumber: 1,
      pullRequestNumber: 1,
      reviewToken: 'revision-bound-review-token',
      previewRevision,
      previewImageDigest,
      previewExpiresAt,
      previewUrl: exactPreviewUrl,
    },
  };
  await page.route('**/api/projects/**', (route) => {
    if (route.request().method() !== 'GET') reviewBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(revisionBoundDetail) });
  });
  await page.goto(`http://127.0.0.1:4173/projects/${project.id}`);

  await expect(page.getByRole('link', { name: 'Try the latest version ↗' })).toHaveAttribute('href', exactPreviewUrl);
  await expect(page.getByRole('link', { name: /Launch deployed preview/ })).toHaveAttribute('href', exactPreviewUrl);
  await expect(page.getByText(`Local Docker revision ${previewRevision.slice(0, 12)}`)).toBeVisible();
  const decision = page.locator('.iteration-decision:not(.iteration-decision--waiting)');
  await decision.getByRole('checkbox', { name: /I opened and tried this deployed revision/ }).check();
  await decision.getByRole('radio', { name: /Approve iteration/ }).check();
  await decision.getByRole('button', { name: 'Approve, merge & continue →' }).click();
  const submitted = await expect.poll(() => reviewBodies[0]).toBeTruthy().then(() => reviewBodies[0]);
  expect(submitted.review).toMatchObject({
    decision: 'approved',
    previewAttestation: { revision: previewRevision, imageDigest: previewImageDigest },
  });
});

test('an expired checkpoint cannot be tried or approved', async ({ page }) => {
  const expiredAt = '2000-01-01T00:00:00.000Z';
  const expiredDetail = {
    ...detail,
    media: [{ ...detail.media[1], expiresAt: expiredAt }],
    reviewCheckpoint: {
      iterationId: detail.iterations[0].id,
      iterationNumber: 1,
      pullRequestNumber: 1,
      reviewToken: 'expired-preview-review-token',
      previewRevision,
      previewImageDigest,
      previewExpiresAt: expiredAt,
      previewUrl: project.previewUrl,
    },
  };
  await page.route('**/api/projects/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(expiredDetail) }));
  await page.goto(`http://127.0.0.1:4173/projects/${project.id}`);

  await expect(page.getByRole('button', { name: /Preview expired/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /I opened and tried this deployed revision/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /Approve iteration/ })).toBeDisabled();
});

test('a human can answer agents, comment, review exact evidence, and submit structured changes', async ({ page }) => {
  const iterationTwoId = '25f5f325-dca2-4016-9f1a-127cfdc909b6';
  const currentArtifact = {
    ...detail.artifacts[0],
    id: '45f5f325-dca2-4016-9f1a-127cfdc909b6',
    iterationId: iterationTwoId,
    type: 'review-decision',
    name: 'Review decision',
    producedBy: 'reviewer',
    content: '# Review decision\n\nThe primary journey is ready for human review.',
    repositoryPath: 'artifacts/iteration-02/review.md',
  };
  const reviewDetail = {
    ...detail,
    project: { ...project, currentIteration: 2 },
    iterations: [
      { ...detail.iterations[0], status: 'completed', completedAt: now },
      { ...detail.iterations[0], id: iterationTwoId, number: 2, objective: 'Make the first journey trustworthy', status: 'awaiting_review', completedAt: null },
    ],
    artifacts: [detail.artifacts[0], currentArtifact],
    media: [
      detail.media[0],
      { ...detail.media[0], id: '55f5f325-dca2-4016-9f1a-127cfdc909b6', iterationId: iterationTwoId, title: 'Completing the trusted journey' },
      { ...detail.media[1], id: '65f5f325-dca2-4016-9f1a-127cfdc909b6', iterationId: iterationTwoId, title: 'Iteration 2 local Docker preview' },
    ],
    reviewCheckpoint: {
      iterationId: iterationTwoId,
      iterationNumber: 2,
      pullRequestNumber: 2,
      reviewToken: 'iteration-2-review-token',
      previewRevision,
      previewImageDigest,
      previewExpiresAt,
      previewUrl: project.previewUrl,
    },
    agentQuestions: [
      {
        id: 'question-speed',
        agentRole: 'product',
        prompt: 'Which outcome should the next increment optimize for?',
        context: 'This choice changes the smallest useful increment.',
        options: [
          { id: '65f5f325-dca2-4016-9f1a-127cfdc909b6', label: 'Faster completion', description: 'Keep the surface narrow.' },
          { id: '65f5f325-dca2-4016-9f1a-127cfdc909b7', label: 'More confidence', description: 'Add one more confirmation step.' },
        ],
        allowAgentDecide: true,
        status: 'open',
      },
      {
        id: 'question-retention',
        agentRole: 'security',
        prompt: 'How long may sensitive records be retained?',
        options: [{ id: '65f5f325-dca2-4016-9f1a-127cfdc909b8', label: 'Thirty days' }],
        allowCustomAnswer: true,
        allowAgentDecide: false,
        status: 'open',
      },
    ],
    humanComments: [{ id: 'comment-1', role: 'manager', comment: 'Keep the first release intentionally small.', author: 'You', createdAt: now }],
  };
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

  await page.route('**/api/projects/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reviewDetail) });
    posts.push({ path, body: request.postDataJSON() as Record<string, unknown> });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
  });

  await page.goto(`http://127.0.0.1:4173/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Questions and direction' })).toHaveCount(0);

  const organism = page.locator('section.organism');
  const productCard = organism.getByRole('button', { name: /Product.*needs human answer/i });
  const securityCard = organism.getByRole('button', { name: /Security.*needs human answer/i });
  await expect(productCard).toBeVisible();
  await expect(securityCard).toBeVisible();
  await expect(organism.locator('.organism-agent--needs-human')).toHaveCount(2);

  await productCard.click();
  await expect(organism.getByRole('heading', { name: 'Product', exact: true })).toBeVisible();
  await expect(organism.getByRole('tab', { name: /^Open/ })).toHaveAttribute('aria-selected', 'true');
  await expect(organism.getByRole('button', { name: /Let the agent decide/ })).toHaveCount(1);
  await organism.getByRole('button', { name: /Faster completion/ }).click();
  await expect.poll(() => posts.find((call) => call.path.endsWith('/questions/question-speed/answer'))?.body).toMatchObject({
    resolution: 'selected_option',
    optionId: '65f5f325-dca2-4016-9f1a-127cfdc909b6',
  });
  await expect(organism.getByRole('button', { name: /Faster completion/ })).toHaveCount(0);
  await organism.getByRole('tab', { name: /^Answered/ }).click();
  await expect(organism.locator('article.agent-question.is-resolved').filter({ hasText: 'Which outcome should the next increment optimize for?' })).toBeVisible();

  await securityCard.click();
  const retentionQuestion = organism.locator('article.agent-question').filter({ hasText: 'How long may sensitive records be retained?' });
  await retentionQuestion.getByLabel(/Answer in your own words/).fill('Keep them only until the request is completed, with a 30-day maximum.');
  await retentionQuestion.getByRole('button', { name: 'Send written answer →' }).click();
  await expect.poll(() => posts.find((call) => call.path.endsWith('/questions/question-retention/answer'))?.body).toMatchObject({
    resolution: 'custom',
    answer: 'Keep them only until the request is completed, with a 30-day maximum.',
  });

  await productCard.click();
  await organism.getByRole('tab', { name: /^Comments/ }).click();
  await organism.getByLabel(/Your comment/).fill('Preserve the shortest useful path in the next pass.');
  await organism.getByRole('button', { name: 'Send to Product →' }).click();
  await expect.poll(() => posts.find((call) => call.path.endsWith('/agents/product/comments'))?.body).toMatchObject({
    iterationId: iterationTwoId,
    body: 'Preserve the shortest useful path in the next pass.',
  });

  await expect(page.getByRole('heading', { name: 'Iteration 2 review evidence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Iteration 1 review evidence' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Review decision, version 1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review decision' });
  await dialog.getByLabel(/Your note/).fill('Clarify the evidence behind the readiness conclusion.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Open Requirements baseline, version 1' }).click();
  const historicalDialog = page.getByRole('dialog', { name: 'Requirements baseline' });
  await historicalDialog.getByLabel(/Your note/).fill('Carry this privacy requirement into the current iteration.');
  await historicalDialog.getByRole('button', { name: 'Save feedback to artifact →' }).click();
  await expect.poll(() => posts.find((call) => call.path.endsWith(`/artifacts/${detail.artifacts[0].id}/feedback`))?.body).toMatchObject({
    feedback: 'Carry this privacy requirement into the current iteration.',
  });
  await historicalDialog.getByRole('button', { name: 'Close Requirements baseline' }).click();

  const decision = page.locator('.iteration-decision:not(.iteration-decision--waiting)');
  await expect(decision.getByRole('link', { name: /Launch deployed preview/ })).toHaveAttribute('href', project.previewUrl);
  const approve = decision.getByRole('radio', { name: /Approve iteration/ });
  await expect(approve).toBeDisabled();
  await decision.getByRole('checkbox', { name: /I opened and tried this deployed revision/ }).check();
  await expect(approve).toBeEnabled();
  await decision.getByLabel(/Direction for the whole team/).fill('Keep the happy path, but make the evidence traceable.');
  const productNote = decision.locator('details').filter({ hasText: 'Product' });
  await productNote.locator('summary').click();
  await productNote.getByLabel('Feedback for Product').fill('Protect the smallest useful increment.');
  await decision.getByRole('radio', { name: /Request changes/ }).check();
  await decision.getByRole('button', { name: 'Send change request →' }).click();

  const reviewCall = await expect.poll(() => posts.find((call) => call.path.endsWith('/review'))).toBeTruthy().then(() => posts.find((call) => call.path.endsWith('/review'))!);
  expect(reviewCall.body).toMatchObject({
    iterationId: iterationTwoId,
    reviewToken: 'iteration-2-review-token',
    review: {
      decision: 'changes_requested',
      overallDirection: 'Keep the happy path, but make the evidence traceable.',
    },
  });
  expect(reviewCall.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  const submittedReview = reviewCall.body.review as Record<string, unknown>;
  expect(submittedReview.agentFeedback).toHaveLength(14);
  expect(submittedReview.agentFeedback).toContainEqual({ role: 'product', feedback: 'Protect the smallest useful increment.' });
  expect(submittedReview.artifactFeedback).toContainEqual({ artifactId: currentArtifact.id, feedback: 'Clarify the evidence behind the readiness conclusion.' });
  expect(submittedReview.artifactFeedback).not.toContainEqual({ artifactId: detail.artifacts[0].id, feedback: 'Carry this privacy requirement into the current iteration.' });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the PWA dashboard is mobile friendly and installable', async ({ page, request }) => {
  await page.route('**/api/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:4173/projects');
  await expect(page.locator('main')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestLink).toBeTruthy();
  const manifestResponse = await request.get(new URL(manifestLink!, 'http://127.0.0.1:4173').toString());
  expect(manifestResponse.ok()).toBe(true);
  expect((await manifestResponse.json()).display).toBe('standalone');
});
