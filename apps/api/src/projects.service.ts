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
import { createHash } from 'node:crypto';
import { distinctUntilChanged, exhaustMap, from, map, shareReplay, timer, type Observable } from 'rxjs';
import { TEMPORAL_GATEWAY, type ProjectTemporalGateway } from './temporal-gateway.js';

const PROJECT_SNAPSHOT_POLL_INTERVAL_MS = 2_000;

export interface ProjectSnapshotEvent {
  data: string;
  id: string;
  retry: number;
}

function canonicalSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalSnapshotValue).sort((left, right) => {
      const leftValue = JSON.stringify(left);
      const rightValue = JSON.stringify(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalSnapshotValue(entry)]));
}

export function projectSnapshotEventId(detail: ProjectDetail): string {
  const stateVersions = [...(detail.agentRuntimeSnapshots ?? [])]
    .sort((left, right) => left.role.localeCompare(right.role))
    .map((snapshot) => `${snapshot.role}-${snapshot.stateVersion}`)
    .join('.');
  const contentDigest = createHash('sha256')
    .update(JSON.stringify(canonicalSnapshotValue(detail)))
    .digest('hex')
    .slice(0, 16);
  return [
    detail.project.updatedAt,
    `state-${stateVersions || '0'}`,
    `graph-${detail.executionGraph?.graphVersion ?? 0}`,
    `content-${contentDigest}`,
  ].join('|');
}

@Injectable()
export class ProjectsService {
  private readonly snapshotStreams = new Map<string, Observable<ProjectSnapshotEvent>>();

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

  snapshots(id: string): Observable<ProjectSnapshotEvent> {
    const existing = this.snapshotStreams.get(id);
    if (existing) return existing;
    const stream = timer(0, PROJECT_SNAPSHOT_POLL_INTERVAL_MS).pipe(
      // Temporal-backed projections can take longer than a polling tick. Drop
      // ticks while one is running so each subscription has at most one read
      // in flight and naturally tears the timer down when the client leaves.
      exhaustMap(() => from(this.find(id))),
      map((detail) => ({ detail, serialized: JSON.stringify(detail) })),
      distinctUntilChanged((previous, current) => previous.serialized === current.serialized),
      map(({ detail, serialized }) => ({
        data: serialized,
        id: projectSnapshotEventId(detail),
        retry: PROJECT_SNAPSHOT_POLL_INTERVAL_MS,
      })),
      // One Temporal projection poll serves every viewer of the same project.
      // refCount tears the poller down as soon as the last viewer disconnects.
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.snapshotStreams.set(id, stream);
    return stream;
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
