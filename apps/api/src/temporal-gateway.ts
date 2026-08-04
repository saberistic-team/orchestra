import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import {
  PROJECT_WORKFLOW_TASK_QUEUE,
  type AgentCommentInput,
  type AgentQuestionAnswerInput,
  type ArtifactFeedbackInput,
  type IterationReviewSubmission,
  type Project,
  type ProjectBrief,
  type ProjectDetail,
  type ProjectSummary,
  type ReviewCheckpoint,
} from '@orchestra/contracts';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { randomUUID } from 'node:crypto';

export const TEMPORAL_GATEWAY = Symbol('TEMPORAL_GATEWAY');

export interface ProjectTemporalGateway {
  createProject(brief: ProjectBrief): Promise<Project>;
  listProjects(): Promise<ProjectSummary[]>;
  findProject(id: string): Promise<ProjectDetail>;
  reviewIteration(id: string, review: IterationReviewSubmission): Promise<void>;
  answerAgentQuestion(id: string, questionId: string, answer: AgentQuestionAnswerInput): Promise<void>;
  commentOnAgent(id: string, comment: AgentCommentInput): Promise<void>;
  commentOnArtifact(id: string, feedback: ArtifactFeedbackInput): Promise<void>;
  resumeProject(id: string): Promise<void>;
}

@Injectable()
export class TemporalGateway implements ProjectTemporalGateway, OnModuleDestroy {
  private connection?: Connection;

  async createProject(brief: ProjectBrief): Promise<Project> {
    const client = await this.client();
    return client.workflow.execute('createProjectWorkflow', {
      taskQueue: PROJECT_WORKFLOW_TASK_QUEUE,
      workflowId: `create-project-${randomUUID()}`,
      args: [brief],
    });
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const client = await this.client();
    return client.workflow.execute('listProjectsWorkflow', {
      taskQueue: PROJECT_WORKFLOW_TASK_QUEUE,
      workflowId: `list-projects-${randomUUID()}`,
      args: [],
    });
  }

  async findProject(id: string): Promise<ProjectDetail> {
    const client = await this.client();
    try {
      const detail = await client.workflow.execute('getProjectDetailWorkflow', {
        taskQueue: PROJECT_WORKFLOW_TASK_QUEUE,
        workflowId: `get-project-${id}-${randomUUID()}`,
        args: [id],
      }) as ProjectDetail | undefined;
      if (!detail) throw new NotFoundException('Project not found');
      let reviewCheckpoint: ReviewCheckpoint | null = null;
      try {
        reviewCheckpoint = await client.workflow.getHandle(`project/${id}`).query<ReviewCheckpoint | null>('getReviewCheckpoint');
      } catch {
        // Older workflow histories do not expose review checkpoints. They
        // remain visible, but the UI will not permit an unbound review.
      }
      return { ...detail, reviewCheckpoint };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) throw new NotFoundException('Project not found');
      throw error;
    }
  }

  async reviewIteration(id: string, review: IterationReviewSubmission): Promise<void> {
    const client = await this.client();
    const handle = client.workflow.getHandle(`project/${id}`);
    await handle.signal('enableDurableHumanGuidance');
    await handle.signal('reviewIteration', review);
  }

  async answerAgentQuestion(id: string, questionId: string, answer: AgentQuestionAnswerInput): Promise<void> {
    const client = await this.client();
    const handle = client.workflow.getHandle(`project/${id}`);
    await handle.signal('enableDurableHumanGuidance');
    await handle.executeUpdate('answerAgentQuestionAndWait', {
      args: [{ questionId, answer }],
    });
  }

  async commentOnAgent(id: string, comment: AgentCommentInput): Promise<void> {
    const client = await this.client();
    const handle = client.workflow.getHandle(`project/${id}`);
    await handle.signal('enableDurableHumanGuidance');
    await handle.signal('commentOnAgent', comment);
  }

  async commentOnArtifact(id: string, feedback: ArtifactFeedbackInput): Promise<void> {
    const client = await this.client();
    const handle = client.workflow.getHandle(`project/${id}`);
    await handle.signal('enableDurableHumanGuidance');
    await handle.signal('commentOnArtifact', feedback);
  }

  async resumeProject(id: string): Promise<void> {
    const client = await this.client();
    const handle = client.workflow.getHandle(`project/${id}`);
    await handle.signal('enableDurableHumanGuidance');
    await handle.signal('resumeProject');
  }

  private async client() {
    this.connection ??= await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
    return new Client({ connection: this.connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
  }

  async onModuleDestroy() {
    await this.connection?.close();
  }
}
