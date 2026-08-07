import { z } from 'zod';
import { organismAgentRoles } from './agent-organism.js';

const agentRoleSchema = z.enum(organismAgentRoles);

/** Roles Manager/Planner may assign on Forgejo work packages (release roles stay dormant). */
export const forgejoAssignableAgentRoles = organismAgentRoles.filter(
  (role) => role !== 'deployment' && role !== 'validation',
) as readonly Exclude<z.infer<typeof agentRoleSchema>, 'deployment' | 'validation'>[];

const forgejoAssignableAgentRoleSchema = z.enum(
  forgejoAssignableAgentRoles as unknown as [typeof forgejoAssignableAgentRoles[number], ...typeof forgejoAssignableAgentRoles[number][]],
);

export const ITEM_STATUS_LABELS = [
  'item/backlog',
  'item/ready',
  'item/in-progress',
  'item/blocked',
  'item/done',
  'item/split',
] as const;
export type ItemStatusLabel = (typeof ITEM_STATUS_LABELS)[number];

export function agentAssignmentLabel(role: z.infer<typeof agentRoleSchema>): string {
  return `agent/${role}`;
}

export const FORGEJO_AGENT_LABELS = organismAgentRoles.map(agentAssignmentLabel) as readonly string[];
export const FORGEJO_ISSUE_ACTION_LABELS = [
  ...FORGEJO_AGENT_LABELS,
  ...ITEM_STATUS_LABELS,
] as const;
const forgejoIssueActionLabelSchema = z.enum(
  FORGEJO_ISSUE_ACTION_LABELS as unknown as [typeof FORGEJO_ISSUE_ACTION_LABELS[number], ...typeof FORGEJO_ISSUE_ACTION_LABELS[number][]],
);

export const forgejoWorkPackageSchema = z.object({
  key: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u),
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20).max(20_000),
  assigneeRoles: z.array(forgejoAssignableAgentRoleSchema).min(1).max(8),
  parentKey: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u).optional(),
}).strict();
export type ForgejoWorkPackage = z.infer<typeof forgejoWorkPackageSchema>;

export const forgejoWorkPackagesDocumentSchema = z.object({
  packages: z.array(forgejoWorkPackageSchema).min(1).max(40),
}).strict();
export type ForgejoWorkPackagesDocument = z.infer<typeof forgejoWorkPackagesDocumentSchema>;

export const forgejoIssueRefSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string().default(''),
  labels: z.array(z.string()),
  state: z.enum(['open', 'closed']),
}).strict();
export type ForgejoIssueRef = z.infer<typeof forgejoIssueRefSchema>;

export const forgejoIssueActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('comment'),
    issueNumber: z.number().int().positive(),
    body: z.string().trim().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal('edit'),
    issueNumber: z.number().int().positive(),
    title: z.string().trim().min(3).max(200).optional(),
    body: z.string().trim().min(20).max(20_000).optional(),
  }).strict(),
  z.object({
    type: z.literal('addLabels'),
    issueNumber: z.number().int().positive(),
    labels: z.array(forgejoIssueActionLabelSchema).min(1).max(20),
  }).strict(),
  z.object({
    type: z.literal('removeLabels'),
    issueNumber: z.number().int().positive(),
    labels: z.array(forgejoIssueActionLabelSchema).min(1).max(20),
  }).strict(),
  z.object({
    type: z.literal('createIssue'),
    key: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/u),
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(20).max(20_000),
    assigneeRoles: z.array(forgejoAssignableAgentRoleSchema).min(1).max(8),
    parentIssueNumber: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    type: z.literal('completeIssue'),
    issueNumber: z.number().int().positive(),
    comment: z.string().trim().min(1).max(20_000).optional(),
  }).strict(),
]);
export type ForgejoIssueAction = z.infer<typeof forgejoIssueActionSchema>;

/** Local Forgejo username created by forgejo-bootstrap for a delivery agent. */
export function forgejoAgentUsername(role: z.infer<typeof agentRoleSchema>): string {
  return `orchestra-${role}`;
}

export function parseAgentAssignmentLabel(label: string): z.infer<typeof agentRoleSchema> | undefined {
  if (!label.startsWith('agent/')) return undefined;
  const role = label.slice('agent/'.length);
  return agentRoleSchema.safeParse(role).success ? role as z.infer<typeof agentRoleSchema> : undefined;
}

export function formatForgejoIssuesContext(issues: readonly ForgejoIssueRef[]): string {
  if (issues.length === 0) {
    return '## Forgejo work issues\nNo open Forgejo issues are currently labeled for this agent.';
  }
  const blocks = issues.map((issue) => [
    `### #${issue.number}: ${issue.title}`,
    `URL: ${issue.url}`,
    `Labels: ${issue.labels.join(', ') || '(none)'}`,
    issue.body.trim() ? `Body:\n${issue.body.trim().slice(0, 4_000)}` : 'Body: (empty)',
  ].join('\n'));
  return `## Forgejo work issues\nConsider these open issues labeled for you. Comment, edit, add/remove labels, create issues when required, and call collaborators by adding their agent/* labels.\n\n${blocks.join('\n\n')}`;
}
