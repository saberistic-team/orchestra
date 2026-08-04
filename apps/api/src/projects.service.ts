import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  agentCommentInputSchema,
  agentQuestionAnswerInputSchema,
  agentRoleSchema,
  artifactFeedbackInputSchema,
  iterationReviewSubmissionSchema,
  projectBriefSchema,
  type Project,
  type ProjectDetail,
  type ProjectSummary,
} from '@orchestra/contracts';
import { TEMPORAL_GATEWAY, type ProjectTemporalGateway } from './temporal-gateway.js';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(TEMPORAL_GATEWAY) private readonly temporal: ProjectTemporalGateway,
  ) {}

  async create(input: unknown): Promise<Project> {
    const parsed = projectBriefSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    return this.temporal.createProject(parsed.data);
  }

  async list(): Promise<ProjectSummary[]> {
    return this.temporal.listProjects();
  }

  async find(id: string): Promise<ProjectDetail> {
    return this.temporal.findProject(id);
  }

  async review(id: string, input: unknown): Promise<void> {
    const parsed = iterationReviewSubmissionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.temporal.reviewIteration(id, parsed.data);
  }

  async answerQuestion(id: string, questionId: string, input: unknown): Promise<void> {
    const parsed = agentQuestionAnswerInputSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.temporal.answerAgentQuestion(id, questionId, parsed.data);
  }

  async commentOnAgent(id: string, role: string, input: unknown): Promise<void> {
    const parsedRole = agentRoleSchema.safeParse(role);
    if (!parsedRole.success) throw new BadRequestException(parsedRole.error.flatten());
    const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const parsed = agentCommentInputSchema.safeParse({
      projectId: id,
      iterationId: source.iterationId,
      agentRole: parsedRole.data,
      body: source.body ?? source.comment,
      authorType: 'human',
    });
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.temporal.commentOnAgent(id, parsed.data);
  }

  async commentOnArtifact(id: string, artifactId: string, input: unknown): Promise<void> {
    const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const parsed = artifactFeedbackInputSchema.safeParse({ artifactId, feedback: source.feedback ?? source.comment });
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.temporal.commentOnArtifact(id, parsed.data);
  }

  async resume(id: string): Promise<void> {
    await this.temporal.resumeProject(id);
  }
}
