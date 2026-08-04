import {
  agentRoleDefinitions,
  type AgentQuestionAnswerInput,
  type AgentRole,
  type ProjectDetail,
} from '@orchestra/contracts';

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestionView {
  id: string;
  role: AgentRole;
  roles: AgentRole[];
  decisionKey: string;
  reusedFromQuestionId?: string;
  prompt: string;
  context?: string;
  options: QuestionOption[];
  allowCustomAnswer: boolean;
  allowAgentDecide: boolean;
  status: 'open' | 'answered' | 'delegated';
}

export interface HumanCommentView {
  id: string;
  role: AgentRole;
  comment: string;
  createdAt: string;
  author: string;
}

export type QuestionAnswerSelection =
  | { option: QuestionOption }
  | { custom: string }
  | { delegate: true };

export type QuestionAnswerResult = {
  label: string;
};

const roleSet = new Set<AgentRole>(agentRoleDefinitions.map((definition) => definition.role));

export function roleDefinition(role: AgentRole) {
  return agentRoleDefinitions.find((definition) => definition.role === role) ?? agentRoleDefinitions[0];
}

export function roleLabel(role: AgentRole) {
  return roleDefinition(role).label;
}

export function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time not recorded';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function normalizeQuestions(detail: ProjectDetail): AgentQuestionView[] {
  const extended = detail as ProjectDetail & { agentQuestions?: unknown; questions?: unknown };
  const raw = Array.isArray(extended.questions) ? extended.questions : Array.isArray(extended.agentQuestions) ? extended.agentQuestions : [];
  const normalized = raw.flatMap((value, index): AgentQuestionView[] => {
    if (!isRecord(value)) return [];
    const askedBy = isRecord(value.askedBy) ? value.askedBy : undefined;
    const role = firstRole(value.agentRole, value.role, askedBy?.role);
    const prompt = firstString(value.prompt, value.question, value.text);
    if (!role || !prompt) return [];
    const optionValues = Array.isArray(value.options) ? value.options : Array.isArray(value.choices) ? value.choices : [];
    const options = optionValues.flatMap((option, optionIndex) => normalizeQuestionOption(option, optionIndex));
    const rawStatus = firstString(value.status)?.toLowerCase();
    const status: AgentQuestionView['status'] = rawStatus === 'answered' ? 'answered' : rawStatus === 'delegated' ? 'delegated' : 'open';
    const id = firstString(value.id, value.questionId) ?? `question-${index}`;
    return [{
      id,
      role,
      roles: [role],
      decisionKey: firstString(value.decisionKey) ?? `question.${id}`,
      reusedFromQuestionId: firstString(value.reusedFromQuestionId),
      prompt,
      context: firstString(value.context, value.description, value.rationale),
      options,
      allowCustomAnswer: typeof value.allowCustomAnswer === 'boolean' ? value.allowCustomAnswer : true,
      allowAgentDecide: typeof value.allowAgentDecide === 'boolean' ? value.allowAgentDecide : typeof value.allowAgentDecision === 'boolean' ? value.allowAgentDecision : true,
      status,
    }];
  });
  const grouped = new Map<string, AgentQuestionView>();
  for (const question of normalized) {
    const existing = grouped.get(question.decisionKey);
    if (!existing) {
      grouped.set(question.decisionKey, question);
      continue;
    }
    const roles = [...new Set([...existing.roles, ...question.roles])];
    // Keep a pending row as the canonical answer target. The backend applies
    // that answer to every equivalent question with the same decision key.
    const canonical = existing.status === 'open' ? existing : question.status === 'open' ? question : existing;
    grouped.set(question.decisionKey, { ...canonical, roles });
  }
  return [...grouped.values()];
}

export function normalizeComments(detail: ProjectDetail): HumanCommentView[] {
  const extended = detail as ProjectDetail & { humanComments?: unknown; agentComments?: unknown };
  const raw = Array.isArray(extended.agentComments) ? extended.agentComments : Array.isArray(extended.humanComments) ? extended.humanComments : [];
  return raw.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const role = firstRole(value.role, value.agentRole, value.targetRole);
    const comment = firstString(value.comment, value.body, value.message);
    if (!role || !comment) return [];
    return [{
      id: firstString(value.id, value.commentId) ?? `comment-${index}`,
      role,
      comment,
      createdAt: firstString(value.createdAt) ?? new Date(0).toISOString(),
      author: firstString(value.author, value.authorName) ?? 'You',
    }];
  });
}

export function rolesNeedingHuman(questions: readonly AgentQuestionView[]): Set<AgentRole> {
  return new Set(questions.filter((question) => question.status === 'open').flatMap((question) => question.roles));
}

export function buildQuestionAnswerPayload(selection: QuestionAnswerSelection): AgentQuestionAnswerInput {
  if ('option' in selection) return { resolution: 'selected_option', optionId: selection.option.id };
  if ('custom' in selection) return { resolution: 'custom', answer: selection.custom.trim() };
  return { resolution: 'agent_decides' };
}

export function questionAnswerSendingLabel(selection: QuestionAnswerSelection): string {
  if ('option' in selection) return selection.option.label;
  if ('custom' in selection) return 'Sending your answer';
  return 'Letting the agent decide';
}

export function questionAnswerSuccessLabel(selection: QuestionAnswerSelection): string {
  if ('option' in selection) return selection.option.label;
  if ('custom' in selection) return 'Your written answer was sent';
  return 'Agent will decide within its authority';
}

export async function submitQuestionAnswer(
  projectId: string,
  questionId: string,
  selection: QuestionAnswerSelection,
): Promise<QuestionAnswerResult> {
  const response = await fetch(`/api/projects/${projectId}/questions/${encodeURIComponent(questionId)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildQuestionAnswerPayload(selection)),
  });
  if (!response.ok) throw new Error('Failed to answer question');
  return { label: questionAnswerSuccessLabel(selection) };
}

export async function submitAgentComment(
  projectId: string,
  role: AgentRole,
  body: string,
  iterationId: string | null,
): Promise<void> {
  const response = await fetch(`/api/projects/${projectId}/agents/${role}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ iterationId, body }),
  });
  if (!response.ok) throw new Error('Failed to send comment');
}

function normalizeQuestionOption(value: unknown, index: number): QuestionOption[] {
  if (typeof value === 'string' && value.trim()) return [{ id: `option-${index}`, label: value.trim() }];
  if (!isRecord(value)) return [];
  const label = firstString(value.label, value.title, value.value, value.text);
  if (!label) return [];
  return [{
    id: firstString(value.id, value.optionId, value.value) ?? `option-${index}`,
    label,
    description: firstString(value.description, value.impact, value.detail),
  }];
}

function firstRole(...values: unknown[]): AgentRole | undefined {
  return values.find((value): value is AgentRole => typeof value === 'string' && roleSet.has(value as AgentRole));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
