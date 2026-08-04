import type {
  AgentAddress,
  AgentInteraction,
  AgentMessage,
  AgentMode,
  AgentOrder,
  AgentResult,
  AgentRole,
  AuthorityGrant,
} from '@orchestra/contracts';

export const DEFAULT_CONTINUE_AS_NEW_EVENT_THRESHOLD = 500;

const roles = [
  'manager', 'requirements', 'product', 'ux', 'architecture', 'data', 'security',
  'planner', 'builder', 'test', 'reviewer', 'gate', 'deployment', 'validation',
] as const satisfies readonly AgentRole[];

const modes = [
  'DORMANT', 'DISCOVERY', 'DEFINITION', 'DESIGN', 'PLANNING', 'IMPLEMENTATION',
  'TESTING', 'REVIEW', 'REMEDIATION', 'GATING', 'DEPLOYMENT', 'VALIDATION',
  'INCIDENT', 'ROLLBACK', 'MAINTENANCE', 'BLOCKED', 'PAUSED',
] as const satisfies readonly AgentMode[];

const priorities = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
const messageKinds = [
  'COMMAND', 'EVENT', 'QUESTION', 'RESPONSE', 'DECISION', 'EVIDENCE', 'FINDING',
  'STATUS', 'ESCALATION', 'CONTROL',
] as const satisfies readonly AgentMessage['kind'][];

const acceptedOrderTypes = {
  manager: ['DEFINE_INCREMENT', 'INVESTIGATE', 'REPLAN'],
  requirements: ['ELABORATE_REQUIREMENTS', 'INVESTIGATE', 'REMEDIATE'],
  product: ['DEFINE_INCREMENT', 'INVESTIGATE', 'REPLAN'],
  ux: ['DESIGN_UX', 'INVESTIGATE', 'REMEDIATE'],
  architecture: ['DESIGN_ARCHITECTURE', 'INVESTIGATE', 'REMEDIATE'],
  data: ['DESIGN_DATA', 'INVESTIGATE', 'REMEDIATE'],
  security: ['THREAT_MODEL', 'INVESTIGATE', 'REMEDIATE'],
  planner: ['PLAN_WORK', 'REPLAN', 'INVESTIGATE'],
  builder: ['IMPLEMENT', 'REMEDIATE', 'INVESTIGATE'],
  test: ['DESIGN_TESTS', 'EXECUTE_TESTS', 'INVESTIGATE'],
  reviewer: ['REVIEW', 'INVESTIGATE'],
  gate: ['EVALUATE_GATE', 'INVESTIGATE'],
  deployment: ['DEPLOY', 'ROLLBACK', 'INVESTIGATE'],
  validation: ['VALIDATE_OUTCOME', 'INVESTIGATE'],
} as const satisfies Record<AgentRole, readonly AgentOrder['type'][]>;

const priorityWeight: Record<AgentMessage['priority'], number> = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export type AgentRuntimeStatus =
  | 'IDLE'
  | 'READY'
  | 'ACTIVE'
  | 'BLOCKED'
  | 'PAUSED'
  | 'CANCELLED';

export type AgentOrderRuntimeStatus =
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | AgentResult['status'];

export type AgentRuntimeErrorCode =
  | 'INVALID_BOOTSTRAP'
  | 'INVALID_MESSAGE'
  | 'INVALID_ORDER'
  | 'INVALID_RESULT'
  | 'WRONG_PROJECT'
  | 'WRONG_RECIPIENT'
  | 'STALE_GRAPH_VERSION'
  | 'FUTURE_GRAPH_VERSION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_ORDER'
  | 'UNSUPPORTED_ORDER'
  | 'UNAUTHORIZED_ACTION'
  | 'UNAUTHORIZED_TARGET'
  | 'UNAUTHORIZED_SCOPE'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_ACTIVE'
  | 'ROLE_MISMATCH'
  | 'STALE_STATE_VERSION'
  | 'INVALID_TRANSITION';

export class AgentRuntimeError extends Error {
  readonly code: AgentRuntimeErrorCode;

  constructor(code: AgentRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.code = code;
  }
}

export interface AgentBootstrap {
  address: AgentAddress;
  role?: AgentRole;
  graphVersion: number;
  projectStateVersion?: number;
  stateVersion?: number;
  mode?: AgentMode;
  continuationSequence?: number;
  eventCount?: number;
  continueAsNewEventThreshold?: number;
  recentMessageIds?: readonly string[];
  recentIdempotencyKeys?: readonly string[];
}

export interface ReceivedMessageIdentity {
  messageId: string;
  idempotencyKey: string;
}

export interface AgentOrderRecord {
  order: AgentOrder;
  status: AgentOrderRuntimeStatus;
  acceptedAtStateVersion: number;
  result?: AgentResult;
}

/** A compact deterministic placeholder until blocker records are persisted in the ledger. */
export interface AgentBlockerView {
  blockerId: string;
  orderId?: string;
  summary: string;
}

export interface AgentCapabilityView {
  role: AgentRole;
  address: AgentAddress;
  acceptedOrderTypes: readonly AgentOrder['type'][];
  acceptedMessageKinds: readonly AgentMessage['kind'][];
  supportsPause: true;
  supportsResume: true;
  supportsCancellation: true;
}

export interface AgentStatusView {
  role: AgentRole;
  address: AgentAddress;
  mode: AgentMode;
  status: AgentRuntimeStatus;
  graphVersion: number;
  projectStateVersion: number;
  stateVersion: number;
  mailboxDepth: number;
  activeOrderCount: number;
  resultCount: number;
  blockerCount: number;
  pendingQuestionCount: number;
  continuationSequence: number;
  eventCount: number;
}

export interface AgentRuntimeState {
  address: AgentAddress;
  role: AgentRole;
  mode: AgentMode;
  status: AgentRuntimeStatus;
  modeBeforePause?: AgentMode;
  graphVersion: number;
  projectStateVersion: number;
  stateVersion: number;
  mailbox: readonly AgentMessage[];
  receivedMessages: readonly ReceivedMessageIdentity[];
  orders: readonly AgentOrderRecord[];
  results: readonly AgentResult[];
  blockers: readonly AgentBlockerView[];
  pendingQuestions: readonly AgentResult['unresolvedQuestions'][number][];
  interactions: readonly AgentInteraction[];
  continuationSequence: number;
  eventCount: number;
  continueAsNewEventThreshold: number;
}

export interface DequeuedMessage {
  state: AgentRuntimeState;
  message?: AgentMessage;
}

function fail(code: AgentRuntimeErrorCode, message: string): never {
  throw new AgentRuntimeError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function assertStringArray(value: unknown, field: string, code: AgentRuntimeErrorCode): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => !isNonBlankString(entry))) {
    fail(code, `${field} must be an array of non-empty strings.`);
  }
}

function validateAddress(address: unknown, field: string, code: AgentRuntimeErrorCode): asserts address is AgentAddress {
  if (!isRecord(address)
    || !isNonBlankString(address.projectId)
    || !roles.includes(address.role as AgentRole)
    || !isNonBlankString(address.workflowId)
    || (address.instanceId !== undefined && !isNonBlankString(address.instanceId))) {
    fail(code, `${field} is not a valid agent address.`);
  }
}

export function validateAuthorityGrant(authority: unknown): asserts authority is AuthorityGrant {
  if (!isRecord(authority)
    || !isNonBlankString(authority.grantId)
    || !(roles.includes(authority.issuerRole as AgentRole) || authority.issuerRole === 'human' || authority.issuerRole === 'system')
    || !['PROJECT', 'ITERATION', 'DOMAIN', 'WORK_PACKAGE', 'REMEDIATION', 'ADVISORY'].includes(String(authority.level))
    || typeof authority.mayDelegate !== 'boolean') {
    fail('INVALID_ORDER', 'The authority grant is malformed.');
  }
  assertStringArray(authority.permittedActions, 'authority.permittedActions', 'INVALID_ORDER');
  if (!Array.isArray(authority.permittedTargets)
    || authority.permittedTargets.some((target) => !roles.includes(target as AgentRole))) {
    fail('INVALID_ORDER', 'authority.permittedTargets contains an unknown role.');
  }
  assertStringArray(authority.scopeRefs, 'authority.scopeRefs', 'INVALID_ORDER');
  for (const field of ['delegatedBy', 'validFrom', 'expiresAt'] as const) {
    if (authority[field] !== undefined && !isNonBlankString(authority[field])) {
      fail('INVALID_ORDER', `authority.${field} must be a non-empty string when provided.`);
    }
  }
}

export function validateAgentMessage(message: unknown): asserts message is AgentMessage {
  if (!isRecord(message)
    || message.schemaVersion !== '1.0'
    || !isNonBlankString(message.messageId)
    || !isNonBlankString(message.idempotencyKey)
    || !isNonBlankString(message.projectId)
    || !isNonBlankString(message.correlationId)
    || !messageKinds.includes(message.kind as AgentMessage['kind'])
    || !isNonBlankString(message.name)
    || !priorities.includes(message.priority as AgentMessage['priority'])
    || !isNonNegativeInteger(message.graphVersion)
    || !isNonNegativeInteger(message.projectStateVersion)
    || !isNonNegativeInteger(message.senderStateVersion)
    || typeof message.acknowledgementRequired !== 'boolean'
    || !isNonBlankString(message.createdAt)) {
    fail('INVALID_MESSAGE', 'The agent message envelope is malformed.');
  }
  validateAddress(message.sender, 'message.sender', 'INVALID_MESSAGE');
  if (!Array.isArray(message.recipients) || message.recipients.length === 0) {
    fail('INVALID_MESSAGE', 'message.recipients must contain at least one address.');
  }
  message.recipients.forEach((recipient, index) => validateAddress(recipient, `message.recipients[${index}]`, 'INVALID_MESSAGE'));
  validateAuthorityGrant(message.authority);
}

function validateScope(scope: unknown): asserts scope is AgentOrder['scope'] {
  if (!isRecord(scope)) fail('INVALID_ORDER', 'order.scope is malformed.');
  for (const field of ['included', 'excluded', 'affectedComponents', 'workPackageRefs'] as const) {
    assertStringArray(scope[field], `order.scope.${field}`, 'INVALID_ORDER');
  }
  for (const field of ['repositoryPaths', 'environments'] as const) {
    if (scope[field] !== undefined) assertStringArray(scope[field], `order.scope.${field}`, 'INVALID_ORDER');
  }
}

export function validateAgentOrder(order: unknown): asserts order is AgentOrder {
  if (!isRecord(order)
    || !isNonBlankString(order.orderId)
    || !isNonBlankString(order.type)
    || !isNonBlankString(order.objective)
    || !priorities.includes(order.priority as AgentOrder['priority'])
    || !Array.isArray(order.expectedOutputs)
    || !Array.isArray(order.acceptanceCriteria)
    || !Array.isArray(order.requiredEvidence)
    || !Array.isArray(order.dependencies)
    || !Array.isArray(order.sourceArtifactVersions)
    || !isRecord(order.constraints)
    || !isRecord(order.loopPolicy)
    || !modes.includes(order.loopPolicy.mode as AgentMode)) {
    fail('INVALID_ORDER', 'The agent order is malformed.');
  }
  validateScope(order.scope);
  validateAuthorityGrant(order.authority);
}

function validateAgentResult(result: unknown): asserts result is AgentResult {
  if (!isRecord(result)
    || !isNonBlankString(result.orderId)
    || !roles.includes(result.role as AgentRole)
    || !['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(String(result.status))
    || !isNonBlankString(result.summary)
    || !isNonNegativeInteger(result.stateVersion)) {
    fail('INVALID_RESULT', 'The agent result is malformed.');
  }
  for (const field of [
    'outputs', 'evidence', 'findings', 'decisions', 'assumptionsCreated',
    'assumptionsInvalidated', 'unresolvedQuestions', 'limitations',
    'recommendedActions', 'sourceVersions',
  ] as const) {
    if (!Array.isArray(result[field])) fail('INVALID_RESULT', `result.${field} must be an array.`);
  }
  if (result.requestedGraphChanges !== undefined && !Array.isArray(result.requestedGraphChanges)) {
    fail('INVALID_RESULT', 'result.requestedGraphChanges must be an array when provided.');
  }
}

function addressesMatch(left: AgentAddress, right: AgentAddress): boolean {
  return left.projectId === right.projectId
    && left.role === right.role
    && left.workflowId === right.workflowId
    && left.instanceId === right.instanceId;
}

type RuntimePatch = Omit<Partial<AgentRuntimeState>, 'stateVersion' | 'eventCount'>;

function transition(state: AgentRuntimeState, patch: RuntimePatch): AgentRuntimeState {
  return {
    ...state,
    ...patch,
    stateVersion: state.stateVersion + 1,
    eventCount: state.eventCount + 1,
  };
}

export function bootstrapAgentState(bootstrap: AgentBootstrap): AgentRuntimeState {
  validateAddress(bootstrap.address, 'bootstrap.address', 'INVALID_BOOTSTRAP');
  const role = bootstrap.role ?? bootstrap.address.role;
  if (role !== bootstrap.address.role) fail('ROLE_MISMATCH', 'Bootstrap role does not match the address role.');
  if (!isNonNegativeInteger(bootstrap.graphVersion)
    || !isNonNegativeInteger(bootstrap.projectStateVersion ?? 0)
    || !isNonNegativeInteger(bootstrap.stateVersion ?? 0)
    || !isNonNegativeInteger(bootstrap.eventCount ?? 0)
    || !isNonNegativeInteger(bootstrap.continuationSequence ?? 0)
    || !isPositiveInteger(bootstrap.continueAsNewEventThreshold ?? DEFAULT_CONTINUE_AS_NEW_EVENT_THRESHOLD)
    || !modes.includes((bootstrap.mode ?? 'DORMANT') as AgentMode)) {
    fail('INVALID_BOOTSTRAP', 'Bootstrap versions, mode, or continuation threshold are invalid.');
  }
  const recentMessageIds = [...(bootstrap.recentMessageIds ?? [])];
  const recentIdempotencyKeys = [...(bootstrap.recentIdempotencyKeys ?? [])];
  assertStringArray(recentMessageIds, 'bootstrap.recentMessageIds', 'INVALID_BOOTSTRAP');
  assertStringArray(recentIdempotencyKeys, 'bootstrap.recentIdempotencyKeys', 'INVALID_BOOTSTRAP');
  if (recentMessageIds.length !== recentIdempotencyKeys.length) {
    fail('INVALID_BOOTSTRAP', 'Recent message IDs and idempotency keys must have equal lengths.');
  }

  return {
    address: { ...bootstrap.address },
    role,
    mode: bootstrap.mode ?? 'DORMANT',
    status: bootstrap.mode === 'PAUSED' ? 'PAUSED' : 'IDLE',
    graphVersion: bootstrap.graphVersion,
    projectStateVersion: bootstrap.projectStateVersion ?? 0,
    stateVersion: bootstrap.stateVersion ?? 0,
    mailbox: [],
    receivedMessages: recentMessageIds.map((messageId, index) => ({
      messageId,
      idempotencyKey: recentIdempotencyKeys[index]!,
    })),
    orders: [],
    results: [],
    blockers: [],
    pendingQuestions: [],
    interactions: [],
    continuationSequence: bootstrap.continuationSequence ?? 0,
    eventCount: bootstrap.eventCount ?? 0,
    continueAsNewEventThreshold: bootstrap.continueAsNewEventThreshold ?? DEFAULT_CONTINUE_AS_NEW_EVENT_THRESHOLD,
  };
}

export function enqueueMessage(state: AgentRuntimeState, message: AgentMessage): AgentRuntimeState {
  validateAgentMessage(message);
  if (message.projectId !== state.address.projectId || message.sender.projectId !== state.address.projectId) {
    fail('WRONG_PROJECT', 'Message and sender must belong to the recipient project.');
  }
  if (!message.recipients.some((recipient) => addressesMatch(recipient, state.address))) {
    fail('WRONG_RECIPIENT', `Message is not addressed to ${state.address.workflowId}.`);
  }

  const sameMessage = state.receivedMessages.find((identity) => identity.messageId === message.messageId);
  if (sameMessage && sameMessage.idempotencyKey !== message.idempotencyKey) {
    fail('IDEMPOTENCY_CONFLICT', `Message ${message.messageId} was already received with another idempotency key.`);
  }
  if (sameMessage || state.receivedMessages.some((identity) => identity.idempotencyKey === message.idempotencyKey)) {
    return state;
  }
  if (message.graphVersion < state.graphVersion) {
    fail('STALE_GRAPH_VERSION', `Message graph version ${message.graphVersion} is older than ${state.graphVersion}.`);
  }
  if (message.graphVersion > state.graphVersion) {
    fail('FUTURE_GRAPH_VERSION', `Message graph version ${message.graphVersion} is newer than ${state.graphVersion}.`);
  }

  return transition(state, {
    mailbox: [...state.mailbox, message],
    receivedMessages: [...state.receivedMessages, {
      messageId: message.messageId,
      idempotencyKey: message.idempotencyKey,
    }],
    status: state.status === 'IDLE' ? 'READY' : state.status,
  });
}

export function selectNextMessage(state: AgentRuntimeState): AgentMessage | undefined {
  if (state.status === 'PAUSED' || state.status === 'CANCELLED') return undefined;
  let selected: AgentMessage | undefined;
  for (const message of state.mailbox) {
    if (!selected || priorityWeight[message.priority] > priorityWeight[selected.priority]) selected = message;
  }
  return selected;
}

export function dequeueNextMessage(state: AgentRuntimeState): DequeuedMessage {
  const message = selectNextMessage(state);
  if (!message) return { state };
  const index = state.mailbox.indexOf(message);
  const mailbox = [...state.mailbox.slice(0, index), ...state.mailbox.slice(index + 1)];
  return {
    message,
    state: transition(state, {
      mailbox,
      status: mailbox.length === 0 && activeOrders(state).length === 0 ? 'IDLE' : state.status,
    }),
  };
}

export function orderScopeRefs(order: AgentOrder): readonly string[] {
  return [
    ...order.scope.included,
    ...order.scope.affectedComponents,
    ...order.scope.workPackageRefs,
    ...(order.scope.repositoryPaths ?? []),
    ...(order.scope.environments ?? []),
  ];
}

export function validateAuthorityForAction(
  authority: AuthorityGrant,
  target: AgentRole,
  action: string,
  scopeRefs: readonly string[] = [],
): void {
  validateAuthorityGrant(authority);
  if (!authority.permittedTargets.includes(target)) {
    fail('UNAUTHORIZED_TARGET', `Authority ${authority.grantId} does not permit target ${target}.`);
  }
  if (!authority.permittedActions.includes(action)) {
    fail('UNAUTHORIZED_ACTION', `Authority ${authority.grantId} does not permit action ${action}.`);
  }
  const unauthorized = scopeRefs.find((scopeRef) =>
    !authority.scopeRefs.includes('*') && !authority.scopeRefs.includes(scopeRef));
  if (unauthorized) {
    fail('UNAUTHORIZED_SCOPE', `Authority ${authority.grantId} does not cover scope ${unauthorized}.`);
  }
}

export function submitOrder(state: AgentRuntimeState, order: AgentOrder): AgentRuntimeState {
  validateAgentOrder(order);
  validateAuthorityForAction(order.authority, state.role, order.type, orderScopeRefs(order));
  if (!acceptedOrderTypes[state.role].includes(order.type as never)) {
    fail('UNSUPPORTED_ORDER', `${state.role} does not accept ${order.type} orders.`);
  }
  const existing = state.orders.find((record) => record.order.orderId === order.orderId);
  if (existing) {
    if (existing.order === order) return state;
    fail('DUPLICATE_ORDER', `Order ${order.orderId} already exists.`);
  }

  let orders = state.orders;
  if (order.supersedesOrderId) {
    const superseded = orders.find((record) => record.order.orderId === order.supersedesOrderId);
    if (!superseded) fail('ORDER_NOT_FOUND', `Superseded order ${order.supersedesOrderId} was not found.`);
    orders = orders.map((record) => record === superseded ? { ...record, status: 'SUPERSEDED' } : record);
  }
  const nextVersion = state.stateVersion + 1;
  return transition(state, {
    orders: [...orders, { order, status: 'ACCEPTED', acceptedAtStateVersion: nextVersion }],
    mode: order.loopPolicy.mode,
    status: state.status === 'PAUSED' ? 'PAUSED' : 'READY',
  });
}

export function selectNextOrder(state: AgentRuntimeState): AgentOrderRecord | undefined {
  if (state.status === 'PAUSED' || state.status === 'CANCELLED') return undefined;
  let selected: AgentOrderRecord | undefined;
  for (const record of activeOrders(state)) {
    if (!selected || priorityWeight[record.order.priority] > priorityWeight[selected.order.priority]) selected = record;
  }
  return selected;
}

export function startOrder(state: AgentRuntimeState, orderId: string): AgentRuntimeState {
  if (state.status === 'PAUSED' || state.status === 'CANCELLED') {
    fail('INVALID_TRANSITION', `Cannot start an order while the agent is ${state.status.toLowerCase()}.`);
  }
  const record = state.orders.find((candidate) => candidate.order.orderId === orderId);
  if (!record) fail('ORDER_NOT_FOUND', `Order ${orderId} was not found.`);
  if (record.status !== 'ACCEPTED' && record.status !== 'BLOCKED') {
    fail('ORDER_NOT_ACTIVE', `Order ${orderId} cannot be started from ${record.status}.`);
  }
  return transition(state, {
    orders: state.orders.map((candidate) => candidate === record ? { ...candidate, status: 'IN_PROGRESS' } : candidate),
    mode: record.order.loopPolicy.mode,
    status: 'ACTIVE',
    blockers: state.blockers.filter((blocker) => blocker.orderId !== orderId),
  });
}

export function pauseAgent(state: AgentRuntimeState, authority: AuthorityGrant): AgentRuntimeState {
  validateAuthorityForAction(authority, state.role, 'PAUSE');
  if (state.status === 'CANCELLED') fail('INVALID_TRANSITION', 'A cancelled agent cannot be paused.');
  if (state.status === 'PAUSED') return state;
  return transition(state, { modeBeforePause: state.mode, mode: 'PAUSED', status: 'PAUSED' });
}

export function resumeAgent(state: AgentRuntimeState, authority: AuthorityGrant): AgentRuntimeState {
  validateAuthorityForAction(authority, state.role, 'RESUME');
  if (state.status === 'CANCELLED') fail('INVALID_TRANSITION', 'A cancelled agent cannot be resumed.');
  if (state.status !== 'PAUSED') return state;
  const hasInProgress = state.orders.some((record) => record.status === 'IN_PROGRESS');
  const hasReadyWork = activeOrders(state).length > 0 || state.mailbox.length > 0;
  return transition(state, {
    mode: state.modeBeforePause ?? 'DORMANT',
    modeBeforePause: undefined,
    status: hasInProgress ? 'ACTIVE' : hasReadyWork ? 'READY' : 'IDLE',
  });
}

export function cancelOrder(
  state: AgentRuntimeState,
  orderId: string,
  authority: AuthorityGrant,
): AgentRuntimeState {
  validateAuthorityForAction(authority, state.role, 'CANCEL');
  const record = state.orders.find((candidate) => candidate.order.orderId === orderId);
  if (!record) fail('ORDER_NOT_FOUND', `Order ${orderId} was not found.`);
  if (!isActiveOrder(record)) return state;
  const remaining = state.orders.filter((candidate) => candidate !== record && isActiveOrder(candidate));
  return transition(state, {
    orders: state.orders.map((candidate) => candidate === record ? { ...candidate, status: 'CANCELLED' } : candidate),
    mode: remaining.length === 0 ? 'DORMANT' : state.mode,
    status: state.status === 'PAUSED' ? 'PAUSED' : remaining.length === 0 ? 'IDLE' : 'READY',
    blockers: state.blockers.filter((blocker) => blocker.orderId !== orderId),
  });
}

export function cancelAgent(state: AgentRuntimeState, authority: AuthorityGrant): AgentRuntimeState {
  validateAuthorityForAction(authority, state.role, 'CANCEL');
  if (state.status === 'CANCELLED') return state;
  return transition(state, {
    orders: state.orders.map((record) => isActiveOrder(record) ? { ...record, status: 'CANCELLED' } : record),
    mode: 'DORMANT',
    status: 'CANCELLED',
    blockers: [],
  });
}

function isActiveOrder(record: AgentOrderRecord): boolean {
  return record.status === 'ACCEPTED' || record.status === 'IN_PROGRESS' || record.status === 'BLOCKED';
}

export function activeOrders(state: AgentRuntimeState): readonly AgentOrderRecord[] {
  return state.orders.filter(isActiveOrder);
}

export function recordResult(state: AgentRuntimeState, result: AgentResult): AgentRuntimeState {
  validateAgentResult(result);
  if (result.role !== state.role) fail('ROLE_MISMATCH', `Result role ${result.role} does not match ${state.role}.`);
  if (result.stateVersion !== state.stateVersion) {
    fail('STALE_STATE_VERSION', `Result state version ${result.stateVersion} does not match ${state.stateVersion}.`);
  }
  const record = state.orders.find((candidate) => candidate.order.orderId === result.orderId);
  if (!record) fail('ORDER_NOT_FOUND', `Order ${result.orderId} was not found.`);
  if (!isActiveOrder(record)) fail('ORDER_NOT_ACTIVE', `Order ${result.orderId} is already ${record.status}.`);

  const orders = state.orders.map((candidate) => candidate === record
    ? { ...candidate, status: result.status, result }
    : candidate);
  const remaining = orders.filter(isActiveOrder);
  const blockers = result.status === 'BLOCKED'
    ? [
        ...state.blockers.filter((blocker) => blocker.orderId !== result.orderId),
        { blockerId: `order:${result.orderId}`, orderId: result.orderId, summary: result.summary },
      ]
    : state.blockers.filter((blocker) => blocker.orderId !== result.orderId);
  const nextMode: AgentMode = result.status === 'BLOCKED'
    ? 'BLOCKED'
    : remaining.length === 0 ? 'DORMANT' : remaining[0]!.order.loopPolicy.mode;
  const nextStatus: AgentRuntimeStatus = result.status === 'BLOCKED'
    ? 'BLOCKED'
    : remaining.length === 0 ? (state.mailbox.length > 0 ? 'READY' : 'IDLE') : 'READY';

  return transition(state, {
    orders,
    results: [...state.results, result],
    blockers,
    pendingQuestions: [...state.pendingQuestions, ...result.unresolvedQuestions],
    mode: nextMode,
    status: state.status === 'PAUSED' ? 'PAUSED' : nextStatus,
  });
}

export function recordInteraction(state: AgentRuntimeState, interaction: AgentInteraction): AgentRuntimeState {
  if (!isRecord(interaction)
    || !isNonBlankString(interaction.id)
    || !isNonBlankString(interaction.name)
    || !isNonBlankString(interaction.summary)
    || !isNonBlankString(interaction.createdAt)
    || !isNonNegativeInteger(interaction.iterationNumber)) {
    fail('INVALID_TRANSITION', 'The agent interaction is malformed.');
  }
  if (state.interactions.some((existing) => existing.id === interaction.id)) return state;
  return transition(state, { interactions: [...state.interactions, interaction] });
}

export function updateGraphVersion(state: AgentRuntimeState, graphVersion: number): AgentRuntimeState {
  if (!isNonNegativeInteger(graphVersion) || graphVersion <= state.graphVersion) {
    fail('INVALID_TRANSITION', 'A graph version update must increase the current graph version.');
  }
  return transition(state, { graphVersion });
}

export function updateProjectStateVersion(state: AgentRuntimeState, projectStateVersion: number): AgentRuntimeState {
  if (!isNonNegativeInteger(projectStateVersion) || projectStateVersion <= state.projectStateVersion) {
    fail('INVALID_TRANSITION', 'A project state version update must increase the current version.');
  }
  return transition(state, { projectStateVersion });
}

export function getAgentCapabilities(state: AgentRuntimeState): AgentCapabilityView {
  return {
    role: state.role,
    address: state.address,
    acceptedOrderTypes: acceptedOrderTypes[state.role],
    acceptedMessageKinds: messageKinds,
    supportsPause: true,
    supportsResume: true,
    supportsCancellation: true,
  };
}

export function getAgentStatus(state: AgentRuntimeState): AgentStatusView {
  return {
    role: state.role,
    address: state.address,
    mode: state.mode,
    status: state.status,
    graphVersion: state.graphVersion,
    projectStateVersion: state.projectStateVersion,
    stateVersion: state.stateVersion,
    mailboxDepth: state.mailbox.length,
    activeOrderCount: activeOrders(state).length,
    resultCount: state.results.length,
    blockerCount: state.blockers.length,
    pendingQuestionCount: state.pendingQuestions.length,
    continuationSequence: state.continuationSequence,
    eventCount: state.eventCount,
  };
}

export function getBlockers(state: AgentRuntimeState): readonly AgentBlockerView[] {
  return state.blockers;
}

export function getPendingQuestions(state: AgentRuntimeState): AgentRuntimeState['pendingQuestions'] {
  return state.pendingQuestions;
}

export function shouldContinueAsNew(
  state: AgentRuntimeState,
  eventThreshold = state.continueAsNewEventThreshold,
): boolean {
  if (!isPositiveInteger(eventThreshold)) {
    fail('INVALID_TRANSITION', 'Continue-As-New event threshold must be a positive integer.');
  }
  return state.eventCount >= eventThreshold;
}
