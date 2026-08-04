import { describe, expect, it } from 'vitest';
import type { ProjectDetail } from '@orchestra/contracts';
import { buildExecutionGraph, prepareDiscovery, selectIterationPreview, selectPriorAgentArtifacts } from './activities.js';

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
      artifacts: [{ id: crypto.randomUUID(), projectId, iterationId, type: 'project-charter', name: 'Project charter', version: 1, content: '# Charter', mimeType: 'text/markdown', status: 'ready_for_review', producedBy: 'manager', model: 'qwen3.5:9b', repositoryPath: 'charter.md', repositoryUrl: null, createdAt: now, reviewedAt: null }],
      events: [
        { id: crypto.randomUUID(), projectId, iterationNumber: 1, kind: 'agent', title: 'Requirements agent started', description: 'Working', agentRole: 'requirements', createdAt: now },
        { id: crypto.randomUUID(), projectId, iterationNumber: 1, kind: 'agent', title: 'Product agent started', description: 'Working', agentRole: 'product', createdAt: now },
      ],
      media: [],
    };
    const graph = buildExecutionGraph(detail);
    expect(graph.nodes.filter((node) => node.state === 'active').map((node) => node.role)).toEqual(['requirements', 'product']);
    expect(graph.nodes.find((node) => node.role === 'ux')).toMatchObject({ state: 'waiting', dependsOn: ['requirements', 'product'], supervisedBy: ['product'] });
    expect(graph.nodes).toHaveLength(14);
    expect(graph.nodes.find((node) => node.role === 'deployment')).toMatchObject({ state: 'dormant', dependsOn: ['gate'] });
    expect(graph.nodes.find((node) => node.role === 'validation')).toMatchObject({ state: 'dormant', dependsOn: ['deployment'] });
    expect(graph.graphVersion).toBe(1);
    expect(graph.edges).toContainEqual({ from: 'requirements', to: 'ux', kind: 'blocks', artifacts: ['requirements-baseline'] });
    expect(graph.edges).toContainEqual({ from: 'product', to: 'ux', kind: 'supervises', artifacts: [] });
    expect(graph.interactions).toContainEqual(expect.objectContaining({
      from: 'product', to: ['project'], kind: 'status', status: 'in_progress',
    }));
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
    expect(artifacts[0]).toMatchObject({ name: 'Requirements v2', content: 'newest' });
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
