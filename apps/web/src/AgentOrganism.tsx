import { useEffect, useId, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  agentRelationshipCatalog,
  agentRoleDefinitions,
  deliveryAgentGraph,
  type AgentExecutionNode,
  type AgentExecutionState,
  type AgentActionPlanRecord,
  type AgentActionRecord,
  type AgentGoalRecord,
  type AgentInteraction,
  type AgentObligationRecord,
  type AgentRelationship,
  type AgentRole,
  type ArtifactVersionRecord,
  type FindingRecord,
  type IterationReviewProposal,
  type MessageThread,
  type ModelInvocationRecord,
  type OrganismEvent,
  type ProjectDetail,
  type ProjectArtifact,
  type ProjectEvent,
  type RepositoryOperationRecord,
} from '@orchestra/contracts';
import {
  formatTimestamp,
  normalizeComments,
  normalizeQuestions,
  questionAnswerSendingLabel,
  rolesNeedingHuman,
  submitAgentComment,
  submitQuestionAnswer,
  type AgentQuestionView,
  type HumanCommentView,
  type QuestionAnswerSelection,
} from './human-loop.js';
import './agent-organism.css';

type OrganismView = 'graph' | 'relationships';
type DetailHitlTab = 'open' | 'answered' | 'comments';
type AgentDefinition = (typeof agentRoleDefinitions)[number];
type AgentPhase = AgentDefinition['phase'];
type Relationship = AgentRelationship;
type InteractionParty = AgentInteraction['from'];
type AnswerState = { state: 'sending' | 'answered' | 'error'; label?: string };
type LegacyAgentExecutionState = 'dormant' | 'waiting' | 'active' | 'completed';
type ActivityAgentFilter = 'all' | AgentRole;
type ActivityKindFilter = 'all' | AgentInteraction['kind'];
type ActivityIterationFilter = 'all' | number;
export type ActivityDimensionFilter = 'all' | 'artifact' | 'finding' | 'human' | 'model' | 'repository';

interface EffectiveAgent {
  definition: AgentDefinition;
  node?: AgentExecutionNode;
  state: AgentExecutionState;
  dependsOn: readonly AgentRole[];
  supervisedBy: readonly AgentRole[];
  artifactName: string;
  assignedModel?: string;
  assignedProvider?: 'ollama' | 'openrouter';
}

interface FlowItem {
  id: string;
  from?: AgentRole;
  to: AgentRole;
  label: string;
  detail: string;
}

export interface OrganismThreadView {
  id: string;
  correlationId: string;
  title: string;
  participantRoles: AgentRole[];
  messageIds: string[];
  status: 'active' | 'waiting' | 'resolved' | 'blocked';
  updatedAt: string;
}

export interface OrganismReadinessItemView {
  id: string;
  label: string;
  status: 'ready' | 'waiting' | 'blocked' | 'not_required';
  summary: string;
  current?: number;
  target?: number;
}

export interface OrganismReadinessView {
  source: 'proposal' | 'recorded' | 'fallback';
  objectiveStatus: string;
  items: OrganismReadinessItemView[];
  gateStatus: string;
  managerRecommendation: string;
  managerRationale: string;
  openCriticalFindings: number;
  openHighFindings: number;
  pendingHumanDecisions: number;
  includedRevision?: string;
  proposedAt?: string;
}

export interface CanonicalAgentSpotlightView {
  available: boolean;
  iterationNumber: number;
  currentGoal?: AgentGoalRecord;
  currentPlan?: AgentActionPlanRecord;
  actions: AgentActionRecord[];
  obligations: AgentObligationRecord[];
  findings: FindingRecord[];
  artifactVersions: ArtifactVersionRecord[];
  modelInvocations: ModelInvocationRecord[];
  repositoryOperations: RepositoryOperationRecord[];
}

export interface GraphEdgeView {
  id: string;
  from: AgentRole;
  to: AgentRole;
  label: string;
  kind: 'dependency' | 'message';
  interactions: AgentInteraction[];
  activeInteraction?: AgentInteraction;
  threadIds: string[];
}

const graphPositions: Record<AgentRole, { x: number; y: number }> = {
  manager: { x: 20, y: 265 },
  requirements: { x: 220, y: 55 },
  product: { x: 220, y: 475 },
  ux: { x: 420, y: 45 },
  architecture: { x: 420, y: 285 },
  data: { x: 620, y: 115 },
  security: { x: 620, y: 500 },
  planner: { x: 820, y: 285 },
  builder: { x: 1020, y: 285 },
  test: { x: 1220, y: 35 },
  reviewer: { x: 1220, y: 515 },
  gate: { x: 1420, y: 285 },
  deployment: { x: 1620, y: 35 },
  validation: { x: 1620, y: 515 },
};

const graphNodeWidth = 178;
const graphNodeHeight = 188;

const phaseOrder = ['shape', 'design', 'plan', 'build', 'assure'] as const satisfies readonly AgentPhase[];

const phaseCopy: Record<AgentPhase, { index: string; label: string; description: string }> = {
  shape: { index: '01', label: 'Shape', description: 'Intent, scope and value' },
  design: { index: '02', label: 'Design', description: 'Experience, system and controls' },
  plan: { index: '03', label: 'Plan', description: 'Bounded work and evidence' },
  build: { index: '04', label: 'Build', description: 'Implementation and proof' },
  assure: { index: '05', label: 'Assure', description: 'Review, release and outcome' },
};

const stateCopy: Record<AgentExecutionState, { icon: string; label: string; shortLabel: string }> = {
  observing: { icon: '◌', label: 'Observing relevant changes', shortLabel: 'Observing' },
  ready: { icon: '◇', label: 'Ready for useful work', shortLabel: 'Ready' },
  planning: { icon: '⋯', label: 'Planning the next actions', shortLabel: 'Planning' },
  working: { icon: '↻', label: 'Executing bounded work', shortLabel: 'Working' },
  reviewing: { icon: '◉', label: 'Reviewing evidence or a candidate', shortLabel: 'Reviewing' },
  communicating: { icon: '→', label: 'Sending or receiving a message', shortLabel: 'Messaging' },
  waiting_on_agent: { icon: '○', label: 'Waiting for another agent', shortLabel: 'Agent wait' },
  waiting_on_human: { icon: '?', label: 'Waiting for a human decision', shortLabel: 'Needs you' },
  monitoring: { icon: '◎', label: 'Monitoring satisfied obligations', shortLabel: 'Monitoring' },
  blocked: { icon: '!', label: 'Blocked by a failure or unmet condition', shortLabel: 'Blocked' },
  completed_for_iteration: { icon: '✓', label: 'Current iteration obligation complete', shortLabel: 'Complete' },
};
const agentExecutionStates = Object.keys(stateCopy) as AgentExecutionState[];

const interactionKindCopy: Record<AgentInteraction['kind'], string> = {
  order: 'Order',
  request: 'Request',
  question: 'Question',
  answer: 'Answer',
  status: 'Status update',
  handoff: 'Handoff',
  evidence: 'Evidence',
  finding: 'Finding',
  decision: 'Decision',
  review: 'Review',
  acknowledgement: 'Acknowledgement',
  blocker: 'Blocker',
  revision_request: 'Revision request',
  review_proposal: 'Review proposal',
  control: 'Control',
};
const interactionKindValues = Object.keys(interactionKindCopy) as AgentInteraction['kind'][];

const interactionKindIcon: Record<AgentInteraction['kind'], string> = {
  order: '⌁', request: '↗', question: '?', answer: '↳', status: '•', handoff: '⇢', evidence: '▣',
  finding: '!', decision: '◆', review: '◉', acknowledgement: '✓', blocker: '⊘', revision_request: '↶',
  review_proposal: '◇', control: '⌘',
};

const interactionStatusCopy: Record<AgentInteraction['status'], { icon: string; label: string }> = {
  pending: { icon: '○', label: 'Pending' },
  acknowledged: { icon: '✓', label: 'Acknowledged' },
  in_progress: { icon: '↻', label: 'In progress' },
  completed: { icon: '✓', label: 'Completed' },
  blocked: { icon: '!', label: 'Blocked' },
  rejected: { icon: '×', label: 'Rejected' },
};
const interactionStatusValues = Object.keys(interactionStatusCopy) as AgentInteraction['status'][];

const managerRecommendationCopy = {
  continue_iteration: 'Manager recommends continuing the iteration',
  send_for_human_review: 'Manager recommends human review',
  request_human_decision: 'Manager requests a human decision',
  reduce_scope: 'Manager recommends reducing scope',
} as const;

const activityDimensionCopy: Record<Exclude<ActivityDimensionFilter, 'all'>, string> = {
  artifact: 'Artifact-linked',
  finding: 'Findings',
  human: 'Human interactions',
  model: 'Model-backed',
  repository: 'Repository-linked',
};

const relationshipKindCopy: Record<Relationship['kind'], string> = {
  directs: 'Directs',
  collaborates: 'Collaborates',
  requests: 'Requests',
  hands_off: 'Hands off',
  remediates: 'Remediates',
  authorizes: 'Authorizes',
  reports: 'Reports',
};

export function AgentOrganism({
  detail,
  selectedRole: selectedRoleProp,
  onSelectedRoleChange,
  onReload,
}: {
  detail: ProjectDetail;
  selectedRole?: AgentRole;
  onSelectedRoleChange?: (role: AgentRole) => void;
  onReload?: () => Promise<void>;
}) {
  const [view, setView] = useState<OrganismView>('graph');
  const [internalSelectedRole, setInternalSelectedRole] = useState<AgentRole>('manager');
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const selectedRole = selectedRoleProp ?? internalSelectedRole;
  const selectRole = (role: AgentRole) => {
    setInternalSelectedRole(role);
    setSelectedThreadId(undefined);
    setSelectedEdgeId(undefined);
    onSelectedRoleChange?.(role);
  };
  const id = useId();
  const elapsedNow = useElapsedTicker();
  const agents = useMemo(() => buildEffectiveAgents(detail), [detail]);
  const interactions = useMemo(() => buildInteractionLedger(detail), [detail]);
  const threads = useMemo(
    () => selectInteractionThreads(interactions, detail.executionGraph?.threads ?? []),
    [detail.executionGraph?.threads, interactions],
  );
  const readiness = useMemo(() => deriveIterationReadiness(detail), [detail]);
  const questions = useMemo(() => normalizeQuestions(detail), [detail]);
  const needingHuman = useMemo(() => rolesNeedingHuman(questions), [questions]);
  const agentByRole = useMemo(() => new Map(agents.map((agent) => [agent.definition.role, agent])), [agents]);
  const selectedAgent = agentByRole.get(selectedRole) ?? agents[0];

  useEffect(() => {
    if (selectedThreadId && !threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(undefined);
      setSelectedEdgeId(undefined);
    }
  }, [selectedThreadId, threads]);

  if (!selectedAgent) return null;

  const counts = countStates(agents);
  const activeAgents = agents.filter((agent) => isComputationallyActive(agent.state));
  const selectedRelationships = connectedRelationships(selectedRole);
  const selectedInteractions = interactions.filter((interaction) => involvesRole(interaction, selectedRole));
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
  const humanAttentionCount = new Set([
    ...needingHuman,
    ...agents.filter((agent) => agent.state === 'waiting_on_human' || agent.node?.humanAttention).map((agent) => agent.definition.role),
  ]).size;
  const focus = activeAgents.length > 0
    ? `${joinNames(activeAgents.slice(0, 3).map((agent) => agent.definition.label))} ${activeAgents.length === 1 ? 'is' : 'are'} active now.`
    : humanAttentionCount > 0
      ? `${humanAttentionCount} agent${humanAttentionCount === 1 ? ' needs' : 's need'} a human decision.`
    : counts.ready > 0
      ? `${counts.ready} agent${counts.ready === 1 ? ' is' : 's are'} ready for the next safe move.`
      : counts.completed_for_iteration === agents.length
        ? 'Every agent obligation is complete for this iteration.'
        : 'The organization is observing and monitoring the project.';

  const focusThread = (threadId: string | undefined, edgeId?: string, role?: AgentRole) => {
    setSelectedThreadId(threadId);
    setSelectedEdgeId(edgeId);
    if (role) {
      setInternalSelectedRole(role);
      onSelectedRoleChange?.(role);
    }
  };

  return <section className="organism" aria-labelledby={`${id}-title`}>
    <div className="organism__heading">
      <div className="organism__intro">
        <div className={`organism__pulse${activeAgents.length > 0 ? ' is-live' : ''}`} aria-hidden="true"><span>{activeAgents[0]?.definition.icon ?? '✦'}</span></div>
        <div>
          <p className="organism__eyebrow">Living delivery organism · iteration {detail.project.currentIteration}</p>
          <h2 id={`${id}-title`}>{focus}</h2>
          <p>Every role has a durable responsibility. Work moves through explicit orders, evidence, findings and handoffs. Select an agent to answer questions or leave comments.</p>
        </div>
      </div>
      <div className="organism__stats" aria-label="Agent status summary">
        <span><strong>{activeAgents.length}</strong> active</span>
        <span><strong>{counts.ready}</strong> ready</span>
        <span><strong>{counts.blocked}</strong> blocked</span>
        <span><strong>{humanAttentionCount}</strong> need you</span>
        <span><strong>{counts.completed_for_iteration}/{agents.length}</strong> complete</span>
      </div>
    </div>

    <div className="organism__toolbar">
      <div className="organism__tabs" role="tablist" aria-label="Agent organism views">
        <button id={`${id}-graph-tab`} role="tab" aria-selected={view === 'graph'} aria-controls={`${id}-graph-panel`} onClick={() => setView('graph')}>
          <span aria-hidden="true">◎</span> Live graph
        </button>
        <button id={`${id}-relationships-tab`} role="tab" aria-selected={view === 'relationships'} aria-controls={`${id}-relationships-panel`} onClick={() => setView('relationships')}>
          <span aria-hidden="true">↔</span> Relationships
        </button>
      </div>
      <p><span aria-hidden="true">●</span> Select any agent for questions, answers, and comments.</p>
    </div>

    <div className="organism__layout">
      <div className="organism__workspace">
        {view === 'graph'
          ? <div id={`${id}-graph-panel`} role="tabpanel" aria-labelledby={`${id}-graph-tab`}>
              <LiveGraphView
                idPrefix={id}
                agents={agents}
                interactions={interactions}
                threads={threads}
                selectedRole={selectedRole}
                selectedThread={selectedThread}
                selectedEdgeId={selectedEdgeId}
                selectRole={selectRole}
                focusThread={focusThread}
                needingHuman={needingHuman}
                elapsedNow={elapsedNow}
              />
            </div>
          : <div id={`${id}-relationships-panel`} role="tabpanel" aria-labelledby={`${id}-relationships-tab`}>
              <RelationshipsView agent={selectedAgent} relationships={selectedRelationships} agentByRole={agentByRole} selectRole={selectRole} needingHuman={needingHuman} />
            </div>}
      </div>

      <AgentDetail
        agent={selectedAgent}
        relationships={selectedRelationships}
        interactions={selectedInteractions}
        agentByRole={agentByRole}
        detail={detail}
        questions={questions}
        onReload={onReload}
        elapsedNow={elapsedNow}
      />
    </div>

    <ReadinessPanel readiness={readiness} iterationNumber={detail.project.currentIteration} />

    <ActivityStream
      idPrefix={id}
      interactions={interactions}
      threads={threads}
      agents={agents}
      artifacts={detail.artifacts}
      iterationNumbers={detail.iterations.map((iteration) => iteration.number)}
      selectedThreadId={selectedThreadId}
      onFocusThread={(threadId, role) => focusThread(threadId, undefined, role)}
      onSelectRole={selectRole}
    />
  </section>;
}

function LiveGraphView({
  idPrefix,
  agents,
  interactions,
  threads,
  selectedRole,
  selectedThread,
  selectedEdgeId,
  selectRole,
  focusThread,
  needingHuman,
  elapsedNow,
}: {
  idPrefix: string;
  agents: EffectiveAgent[];
  interactions: AgentInteraction[];
  threads: OrganismThreadView[];
  selectedRole: AgentRole;
  selectedThread?: OrganismThreadView;
  selectedEdgeId?: string;
  selectRole: (role: AgentRole) => void;
  focusThread: (threadId: string | undefined, edgeId?: string, role?: AgentRole) => void;
  needingHuman: ReadonlySet<AgentRole>;
  elapsedNow: number;
}) {
  const edges = useMemo(() => buildGraphEdges(interactions, threads), [interactions, threads]);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const selectedParticipants = new Set(selectedThread?.participantRoles ?? []);
  const liveMessages = interactions.filter((interaction) => interaction.live);
  const markerPrefix = idPrefix.replaceAll(':', '');

  return <>
    <div className="organism-graph__heading">
      <div>
        <p className="organism__eyebrow">Concurrent coordination graph</p>
        <h3>Every role remains present.</h3>
        <p>Solid paths are required handoffs. A moving marker appears only while a durable message is live.</p>
      </div>
      <span className={`organism-graph__live-count${liveMessages.length > 0 ? ' is-live' : ''}`}>
        <i aria-hidden="true">{liveMessages.length > 0 ? '↗' : '○'}</i>
        <strong>{liveMessages.length}</strong> live message{liveMessages.length === 1 ? '' : 's'}
      </span>
    </div>

    <div className="organism__legend" aria-label="Agent runtime state legend">
      {(Object.entries(stateCopy) as [AgentExecutionState, (typeof stateCopy)[AgentExecutionState]][]).map(([state, copy]) =>
        <span className={`organism__legend-item organism__legend-item--${state}`} key={state}><i aria-hidden="true">{copy.icon}</i>{copy.shortLabel}</span>)}
    </div>

    <div className="organism-graph__viewport" tabIndex={0} aria-label="Scrollable live agent coordination graph">
      <div className="organism-graph__board">
        <div className="organism-graph__phase-labels" aria-hidden="true">
          <span style={{ left: 20 }}>Shape</span><span style={{ left: 420 }}>Design</span><span style={{ left: 820 }}>Plan</span><span style={{ left: 1020 }}>Build</span><span style={{ left: 1220 }}>Assure</span>
        </div>
        <svg className="organism-graph__edges" viewBox="0 0 1820 735" aria-label="Agent handoff and message paths">
          <defs>
            <marker id={`${markerPrefix}-edge-arrow`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" /></marker>
            <marker id={`${markerPrefix}-edge-arrow-live`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker>
          </defs>
          {edges.map((edge) => {
            const path = graphEdgePath(edge.from, edge.to);
            const live = edge.activeInteraction;
            const interactionKind = live?.kind ?? edge.interactions[0]?.kind;
            const selected = selectedEdgeId === edge.id;
            const connectedToThread = selectedThread
              ? edge.threadIds.includes(selectedThread.id) || (selectedParticipants.has(edge.from) && selectedParticipants.has(edge.to))
              : false;
            const threadId = edge.threadIds[0];
            const edgeLabel = live
              ? `${roleLabel(edge.from)} to ${roleLabel(edge.to)}: live ${interactionKindCopy[live.kind]}`
              : `${roleLabel(edge.from)} to ${roleLabel(edge.to)}: ${edge.label}${edge.interactions.length > 0 ? `, ${edge.interactions.length} recorded messages` : ''}`;
            const activate = () => focusThread(threadId, edge.id, edge.to);
            return <g
              className={`organism-edge organism-edge--${interactionKind ?? edge.kind}${live ? ' is-live' : edge.interactions.length > 0 ? ' has-history' : ''}${selected ? ' is-selected' : ''}${connectedToThread ? ' is-thread-connected' : ''}`}
              key={edge.id}
            >
              <title>{edgeLabel}</title>
              <path className="organism-edge__line" d={path} markerEnd={`url(#${live ? `${markerPrefix}-edge-arrow-live` : `${markerPrefix}-edge-arrow`})`} />
              <path className="organism-edge__hit" d={path} role="button" tabIndex={0} aria-label={edgeLabel} onClick={activate} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
              }} />
              {live ? <circle className={`organism-edge__message organism-edge__message--${live.kind}`} r="5" aria-hidden="true">
                <animateMotion path={path} dur="1.8s" repeatCount="indefinite" />
              </circle> : null}
            </g>;
          })}
        </svg>

        {agents.map((agent) => <GraphAgentNode
          key={agent.definition.role}
          agent={agent}
          selected={selectedRole === agent.definition.role}
          needsHuman={needingHuman.has(agent.definition.role) || agent.state === 'waiting_on_human' || Boolean(agent.node?.humanAttention)}
          threadFocused={Boolean(selectedThread)}
          threadParticipant={selectedParticipants.has(agent.definition.role)}
          onSelect={selectRole}
          elapsedNow={elapsedNow}
        />)}
      </div>
    </div>

    <ThreadFocus
      edge={selectedEdge}
      thread={selectedThread}
      interactions={interactions}
      onClose={() => focusThread(undefined, undefined)}
    />
  </>;
}

function GraphAgentNode({
  agent,
  selected,
  needsHuman,
  threadFocused,
  threadParticipant,
  onSelect,
  elapsedNow,
}: {
  agent: EffectiveAgent;
  selected: boolean;
  needsHuman: boolean;
  threadFocused: boolean;
  threadParticipant: boolean;
  onSelect: (role: AgentRole) => void;
  elapsedNow: number;
}) {
  const { definition, state, node, assignedModel, assignedProvider, artifactName } = agent;
  const position = graphPositions[definition.role];
  const stateText = stateCopy[state];
  const activity = node?.activity;
  const summary = activity?.summary ?? stateText.label;
  const stateSince = node?.stateChangedAt ?? activity?.startedAt ?? node?.startedAt;
  const latest = node?.latestFinding ?? node?.latestArtifact ?? `Produces ${artifactName}`;
  const tokenUse = node?.tokenUse ?? 0;
  const openMessages = node?.openMessageCount ?? 0;
  const blockers = node?.blockingDependencyCount ?? 0;
  const model = assignedModel && assignedModel !== 'resolved when agent starts' ? assignedModel : undefined;
  const label = `${definition.label}, ${stateText.shortLabel}. ${summary}${needsHuman ? '. Needs human attention' : ''}`;

  return <button
    type="button"
    className={`organism-graph-agent organism-graph-agent--${state}${selected ? ' is-selected' : ''}${needsHuman ? ' needs-human' : ''}${threadFocused && !threadParticipant ? ' is-deemphasized' : ''}${threadParticipant ? ' is-thread-participant' : ''}`}
    style={{ left: position.x, top: position.y }}
    aria-pressed={selected}
    aria-label={label}
    onClick={() => onSelect(definition.role)}
  >
    <span className="organism-graph-agent__top">
      <i aria-hidden="true">{definition.icon}</i>
      <span className="organism-graph-agent__state"><b aria-hidden="true">{stateText.icon}</b>{stateText.shortLabel}</span>
    </span>
    <strong>{definition.label}</strong>
    <span className="organism-graph-agent__activity">{summary}</span>
    <span className="organism-graph-agent__meta">
      {model ? `${assignedProvider ? `${assignedProvider} · ` : ''}${model}` : 'No active model call'}
      {stateSince ? ` · ${formatElapsed(stateSince, elapsedNow)}` : ''}
    </span>
    <span className="organism-graph-agent__metrics" aria-label={`${tokenUse} tokens, ${openMessages} open messages, ${blockers} blockers`}>
      {tokenUse > 0 ? <em><b>{compactNumber(tokenUse)}</b> tokens</em> : null}
      {typeof node?.openRouterCost === 'number' ? <em><b>{formatModelCost(node.openRouterCost)}</b></em> : null}
      <em><b>{openMessages}</b> msg</em>
      <em><b>{blockers}</b> block</em>
    </span>
    <small className={node?.latestFinding ? 'is-finding' : ''}>{needsHuman ? 'Human attention · ' : ''}{latest}</small>
  </button>;
}

function ThreadFocus({
  edge,
  thread,
  interactions,
  onClose,
}: {
  edge?: GraphEdgeView;
  thread?: OrganismThreadView;
  interactions: AgentInteraction[];
  onClose: () => void;
}) {
  if (!edge && !thread) return <p className="organism-thread-focus__hint"><span aria-hidden="true">↗</span>Select an edge to inspect its durable message thread.</p>;
  const messages = thread
    ? interactions.filter((interaction) => interaction.correlationId === thread.correlationId || thread.messageIds.includes(interaction.messageId ?? interaction.id))
    : edge?.interactions ?? [];
  const title = thread?.title ?? `${roleLabel(edge!.from)} → ${roleLabel(edge!.to)}`;
  const status = thread?.status ?? (edge?.activeInteraction ? 'active' : 'waiting');

  return <section className={`organism-thread-focus organism-thread-focus--${status}`} aria-label={`Focused thread: ${title}`}>
    <div className="organism-thread-focus__heading">
      <div><p className="organism__eyebrow">Focused path · {status}</p><h4>{title}</h4></div>
      <button type="button" onClick={onClose} aria-label={`Close ${title} thread focus`}>×</button>
    </div>
    <p>{thread
      ? `${thread.participantRoles.map(roleLabel).join(' · ')} · ${messages.length} message${messages.length === 1 ? '' : 's'}`
      : `${edge?.label}. ${messages.length > 0 ? `${messages.length} durable exchange${messages.length === 1 ? '' : 's'} recorded.` : 'No durable message has used this path yet.'}`}</p>
    {messages.length > 0 ? <ol>{messages.slice(0, 3).map((message) => <li key={message.id}>
      <span aria-hidden="true">{interactionKindIcon[message.kind]}</span><div><strong>{message.name}</strong><small>{partyLabel(message.from)} → {message.to.map(partyLabel).join(', ')}</small></div>
    </li>)}</ol> : null}
  </section>;
}

function AgentCard({ agent, selected, needsHuman, onSelect }: { agent: EffectiveAgent; selected: boolean; needsHuman: boolean; onSelect: (role: AgentRole) => void }) {
  const { definition, state, artifactName, assignedModel, assignedProvider } = agent;
  const stateText = stateCopy[state];
  return <button
    type="button"
    className={`organism-agent organism-agent--${state}${needsHuman ? ' organism-agent--needs-human' : ''}${selected ? ' is-selected' : ''}`}
    aria-pressed={selected}
    aria-label={`${definition.label}, ${stateText.shortLabel}${needsHuman ? ', needs human answer' : ''}`}
    onClick={() => onSelect(definition.role)}
  >
    <span className="organism-agent__top">
      <i aria-hidden="true">{definition.icon}</i>
      <span className="organism-agent__markers">
        {needsHuman ? <span className="organism-agent__question-mark" title="Needs human answer" aria-hidden="true">?</span> : null}
        <span className="organism-agent__state"><b aria-hidden="true">{stateText.icon}</b> {stateText.shortLabel}</span>
      </span>
    </span>
    <strong>{definition.label}</strong>
    <span className="organism-agent__artifact">Owns {definition.owns[0] ?? artifactName}</span>
    <small>{assignedModel ? `${assignedProvider ? `${assignedProvider} · ` : ''}${assignedModel}` : `Creates ${artifactName}`}</small>
  </button>;
}

function FlowColumn({ title, icon, kind, items, empty, onSelect }: { title: string; icon: string; kind: 'blocked' | 'handoff'; items: FlowItem[]; empty: string; onSelect: (role: AgentRole) => void }) {
  return <section className={`organism__flow-column organism__flow-column--${kind}`}>
    <div className="organism__flow-title"><i aria-hidden="true">{icon}</i><div><h3>{title}</h3><p>{kind === 'blocked' ? 'Required inputs that hold the next role' : 'Completed work opening the next role'}</p></div></div>
    {items.length > 0
      ? <ol>{items.slice(0, 5).map((item) => <li key={item.id}>
          <button type="button" onClick={() => onSelect(item.to)}>
            <span>{item.from ? <>{roleLabel(item.from)} <b aria-hidden="true">→</b> </> : null}{roleLabel(item.to)}</span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </button>
        </li>)}</ol>
      : <p className="organism__flow-empty"><span aria-hidden="true">✓</span>{empty}</p>}
  </section>;
}

function RelationshipsView({
  agent,
  relationships,
  agentByRole,
  selectRole,
  needingHuman,
}: {
  agent: EffectiveAgent;
  relationships: readonly Relationship[];
  agentByRole: Map<AgentRole, EffectiveAgent>;
  selectRole: (role: AgentRole) => void;
  needingHuman: ReadonlySet<AgentRole>;
}) {
  const incoming = relationships.filter((relationship) => relationship.to === agent.definition.role && !relationship.bidirectional);
  const mutual = relationships.filter((relationship) => relationship.bidirectional);
  const outgoing = relationships.filter((relationship) => relationship.from === agent.definition.role && !relationship.bidirectional);
  const needsHuman = needingHuman.has(agent.definition.role);

  return <div className="organism__relationship-view">
    <div className="organism__relationship-heading">
      <p className="organism__eyebrow">One-hop relationship focus</p>
      <h3>{agent.definition.label} in context</h3>
      <p>Only this role’s permitted direct relationships are shown, keeping authority and communication readable.</p>
    </div>

    <div className="organism__relationship-map">
      <RelationshipGroup label="Receives from" relationships={incoming} focusRole={agent.definition.role} agentByRole={agentByRole} selectRole={selectRole} needingHuman={needingHuman} direction="incoming" />
      <div className={`organism__relationship-focus organism__relationship-focus--${agent.state}${needsHuman ? ' organism__relationship-focus--needs-human' : ''}`}>
        <span aria-hidden="true">{agent.definition.icon}</span>
        {needsHuman ? <b className="organism__relationship-focus-mark" aria-hidden="true">?</b> : null}
        <small>Selected agent{needsHuman ? ' · needs human answer' : ''}</small>
        <strong>{agent.definition.label}</strong>
        <p>{stateCopy[agent.state].label}</p>
      </div>
      <RelationshipGroup label="Sends to" relationships={outgoing} focusRole={agent.definition.role} agentByRole={agentByRole} selectRole={selectRole} needingHuman={needingHuman} direction="outgoing" />
    </div>

    <RelationshipGroup label="Works both ways" relationships={mutual} focusRole={agent.definition.role} agentByRole={agentByRole} selectRole={selectRole} needingHuman={needingHuman} direction="mutual" wide />
  </div>;
}

function RelationshipGroup({
  label,
  relationships,
  focusRole,
  agentByRole,
  selectRole,
  needingHuman,
  direction,
  wide = false,
}: {
  label: string;
  relationships: readonly Relationship[];
  focusRole: AgentRole;
  agentByRole: Map<AgentRole, EffectiveAgent>;
  selectRole: (role: AgentRole) => void;
  needingHuman: ReadonlySet<AgentRole>;
  direction: 'incoming' | 'outgoing' | 'mutual';
  wide?: boolean;
}) {
  return <section className={`organism__relationship-group${wide ? ' organism__relationship-group--wide' : ''}`}>
    <h4>{label} <span>{relationships.length}</span></h4>
    {relationships.length > 0
      ? <div className="organism__relationship-list">{relationships.map((relationship) => {
          const otherRole = relationship.from === focusRole ? relationship.to : relationship.from;
          const other = agentByRole.get(otherRole);
          const arrow = direction === 'incoming' ? '→' : direction === 'outgoing' ? '→' : '↔';
          const needsHuman = needingHuman.has(otherRole);
          return <button type="button" key={relationship.id} className={`organism__relationship organism__relationship--${direction}${needsHuman ? ' organism__relationship--needs-human' : ''}`} onClick={() => selectRole(otherRole)} aria-label={`${other?.definition.label ?? roleLabel(otherRole)}${needsHuman ? ', needs human answer' : ''}`}>
            <span className="organism__relationship-person">
              <i aria-hidden="true">{other?.definition.icon ?? '•'}</i>
              <strong>{other?.definition.label ?? roleLabel(otherRole)}</strong>
              {needsHuman ? <em className="organism__relationship-question-mark" aria-hidden="true">?</em> : null}
            </span>
            <span className="organism__relationship-link"><b aria-hidden="true">{arrow}</b><em>{relationship.label || relationshipKindCopy[relationship.kind]}</em></span>
            <small>{relationship.description}</small>
          </button>;
        })}</div>
      : <p className="organism__relationship-empty">No permitted relationships in this direction.</p>}
  </section>;
}

function AgentDetail({
  agent,
  relationships,
  interactions,
  agentByRole,
  detail,
  questions,
  onReload,
  elapsedNow,
}: {
  agent: EffectiveAgent;
  relationships: readonly Relationship[];
  interactions: AgentInteraction[];
  agentByRole: Map<AgentRole, EffectiveAgent>;
  detail: ProjectDetail;
  questions: readonly AgentQuestionView[];
  onReload?: () => Promise<void>;
  elapsedNow: number;
}) {
  const id = useId();
  const { definition } = agent;
  const current = interactions.find((interaction) => interaction.live || ['pending', 'acknowledged', 'in_progress', 'blocked'].includes(interaction.status));
  const latest = interactions[0];
  const talksWith = uniqueRoles(relationships.map((relationship) => relationship.from === definition.role ? relationship.to : relationship.from));
  const roleQuestions = questions.filter((question) => question.roles.includes(definition.role));
  const [tab, setTab] = useState<DetailHitlTab>('open');
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [exitingIds, setExitingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<HumanCommentView[]>(() => normalizeComments(detail));
  const [commentDraft, setCommentDraft] = useState('');
  const [commentState, setCommentState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  useEffect(() => {
    setComments(normalizeComments(detail));
  }, [detail]);

  useEffect(() => {
    setTab(questions.some((question) => question.roles.includes(definition.role) && question.status === 'open') ? 'open' : 'comments');
    setCommentState('idle');
    setCommentDraft('');
  }, [definition.role]);

  const openQuestions = roleQuestions.filter((question) => {
    const answer = answers[question.id];
    if (answer?.state === 'answered' && !exitingIds.has(question.id)) return false;
    return question.status === 'open' || exitingIds.has(question.id);
  });
  const answeredQuestions = roleQuestions.filter((question) => {
    const answer = answers[question.id];
    return (question.status !== 'open' || answer?.state === 'answered') && !exitingIds.has(question.id);
  });
  const selectedComments = comments
    .filter((comment) => comment.role === definition.role)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const primaryArtifactType = deliveryAgentGraph.find((candidate) => candidate.role === definition.role)?.artifactType;
  const modelUsage = summarizeAgentModelUsage(detail.artifacts, definition.role, primaryArtifactType);
  const canonicalSpotlight = selectCanonicalAgentSpotlight(detail, definition.role);

  async function answerQuestion(question: AgentQuestionView, selection: QuestionAnswerSelection) {
    setAnswers((current) => ({ ...current, [question.id]: { state: 'sending', label: questionAnswerSendingLabel(selection) } }));
    try {
      const result = await submitQuestionAnswer(detail.project.id, question.id, selection);
      setAnswers((current) => ({ ...current, [question.id]: { state: 'answered', label: result.label } }));
      setExitingIds((current) => new Set(current).add(question.id));
      window.setTimeout(() => {
        setExitingIds((current) => {
          const next = new Set(current);
          next.delete(question.id);
          return next;
        });
      }, 320);
      await onReload?.();
    } catch {
      setAnswers((current) => ({ ...current, [question.id]: { state: 'error', label: 'We could not send this answer. Try again.' } }));
    }
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    const comment = commentDraft.trim();
    if (!comment) return;
    setCommentState('sending');
    try {
      const iterationId = detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration)?.id ?? null;
      await submitAgentComment(detail.project.id, definition.role, comment, iterationId);
      setComments((current) => [{ id: `local:${Date.now()}`, role: definition.role, comment, createdAt: new Date().toISOString(), author: 'You' }, ...current]);
      setCommentDraft('');
      setCommentState('sent');
      await onReload?.();
    } catch {
      setCommentState('error');
    }
  }

  return <section className="organism-detail" aria-labelledby={`agent-detail-${definition.role}`}>
    <div className="organism-detail__top">
      <span className="organism-detail__icon" aria-hidden="true">{definition.icon}</span>
      <div><p>Selected role</p><h3 id={`agent-detail-${definition.role}`}>{definition.label}</h3></div>
      <span className={`organism-detail__state organism-detail__state--${agent.state}${openQuestions.length > 0 ? ' organism-detail__state--needs-human' : ''}`}>
        <b aria-hidden="true">{openQuestions.length > 0 ? '?' : stateCopy[agent.state].icon}</b>
        {openQuestions.length > 0 ? 'Needs you' : stateCopy[agent.state].shortLabel}
      </span>
    </div>

    <p className="organism-detail__responsibility">{definition.responsibility}</p>

    <AgentRuntimeSummary agent={agent} elapsedNow={elapsedNow} />

    <CanonicalAgentSpotlight view={canonicalSpotlight} role={definition.role} />

    {detail.modelInvocations === undefined ? <ModelUsageSummary usage={modelUsage} /> : null}

    <DetailList title="Owns" values={definition.owns} empty="No exclusive ownership declared." />
    <DetailList title="Cannot" values={definition.cannot} empty="No explicit boundary declared." tone="boundary" />

    <dl className="organism-detail__connections">
      <div><dt>Needs</dt><dd>{roleList(agent.dependsOn, agentByRole, 'No blocking dependency')}</dd></div>
      <div><dt>Guided by</dt><dd>{roleList(agent.supervisedBy, agentByRole, 'Self-directed within its authority')}</dd></div>
      <div><dt>Talks with</dt><dd>{roleList(talksWith, agentByRole, 'No one-hop relationship declared')}</dd></div>
    </dl>

    <div className="organism-detail__exchange">
      <h4>Current / latest exchange</h4>
      {current ? <CompactExchange label="Current" interaction={current} /> : null}
      {latest && latest.id !== current?.id ? <CompactExchange label="Latest" interaction={latest} /> : null}
      {!current && !latest ? <p>No exchange has been recorded for this agent yet.</p> : null}
    </div>

    <section className="organism-detail__hitl" aria-label={`${definition.label} human loop`}>
      <div className="organism-detail__hitl-tabs" role="tablist" aria-label={`${definition.label} questions and comments`}>
        <button id={`${id}-open-tab`} type="button" role="tab" aria-selected={tab === 'open'} aria-controls={`${id}-open-panel`} onClick={() => setTab('open')}>
          Open{openQuestions.length > 0 ? <span>{openQuestions.length}</span> : null}
        </button>
        <button id={`${id}-answered-tab`} type="button" role="tab" aria-selected={tab === 'answered'} aria-controls={`${id}-answered-panel`} onClick={() => setTab('answered')}>
          Answered{answeredQuestions.length > 0 ? <span>{answeredQuestions.length}</span> : null}
        </button>
        <button id={`${id}-comments-tab`} type="button" role="tab" aria-selected={tab === 'comments'} aria-controls={`${id}-comments-panel`} onClick={() => setTab('comments')}>
          Comments{selectedComments.length > 0 ? <span>{Math.min(selectedComments.length, 99)}</span> : null}
        </button>
      </div>

      {tab === 'open' ? <div id={`${id}-open-panel`} role="tabpanel" aria-labelledby={`${id}-open-tab`} className="organism-detail__hitl-panel">
        {openQuestions.length > 0
          ? <div className="organism-detail__questions">{openQuestions.map((question) => {
              const answer = answers[question.id];
              const exiting = exitingIds.has(question.id) || answer?.state === 'answered';
              return <article className={`agent-question${exiting ? ' is-exiting is-resolved' : ''}`} key={question.id}>
                <div className="agent-question__agent"><i aria-hidden="true">{definition.icon}</i><span>{definition.label} asks</span>{exiting ? <b>Answered ✓</b> : null}</div>
                {question.roles.length > 1 ? <p>Shared decision for {question.roles.map(roleLabel).join(', ')}. One answer applies to every listed agent.</p> : null}
                <h4>{question.prompt}</h4>
                {question.context ? <p>{question.context}</p> : null}
                {!exiting ? <div className="agent-question__options" aria-label={`Answers for: ${question.prompt}`}>
                  {question.options.map((option) => <button type="button" key={option.id} disabled={answer?.state === 'sending'} onClick={() => void answerQuestion(question, { option })}>
                    <strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}
                  </button>)}
                  {question.allowCustomAnswer ? <div className="agent-question__custom">
                    <label htmlFor={`${id}-custom-${question.id}`}>Answer in your own words <span>optional alternative</span></label>
                    <textarea id={`${id}-custom-${question.id}`} rows={2} maxLength={5_000} value={customAnswers[question.id] ?? ''} onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Add the context or decision the options do not capture…" />
                    <button type="button" disabled={!customAnswers[question.id]?.trim() || answer?.state === 'sending'} onClick={() => void answerQuestion(question, { custom: customAnswers[question.id] ?? '' })}><strong>Send written answer →</strong></button>
                  </div> : null}
                  {question.allowAgentDecide ? <button type="button" className="agent-question__delegate" disabled={answer?.state === 'sending'} onClick={() => void answerQuestion(question, { delegate: true })}>
                    <strong>Let the agent decide</strong><small>Use its declared authority and record the rationale.</small>
                  </button> : null}
                </div> : null}
                {answer ? <p className={`agent-question__result agent-question__result--${answer.state}`} role={answer.state === 'error' ? 'alert' : 'status'}>{answer.state === 'sending' ? 'Sending your answer…' : answer.label}</p> : null}
              </article>;
            })}</div>
          : <div className="organism-detail__empty"><span aria-hidden="true">✓</span><div><strong>No open questions</strong><p>This role has enough human context for now.</p></div></div>}
      </div> : null}

      {tab === 'answered' ? <div id={`${id}-answered-panel`} role="tabpanel" aria-labelledby={`${id}-answered-tab`} className="organism-detail__hitl-panel">
        {answeredQuestions.length > 0
          ? <div className="organism-detail__questions">{answeredQuestions.map((question) => {
              const answer = answers[question.id];
              return <article className="agent-question is-resolved" key={question.id}>
                <div className="agent-question__agent"><i aria-hidden="true">{definition.icon}</i><span>{definition.label} asked</span><b>Answered ✓</b></div>
                {question.roles.length > 1 ? <p>Shared decision across {question.roles.map(roleLabel).join(', ')}.</p> : null}
                <h4>{question.prompt}</h4>
                {question.context ? <p>{question.context}</p> : null}
                {answer?.label ? <p className="agent-question__result agent-question__result--answered" role="status">{answer.label}</p> : null}
              </article>;
            })}</div>
          : <div className="organism-detail__empty"><span aria-hidden="true">◇</span><div><strong>No answered questions yet</strong><p>Resolved questions for this agent will gather here.</p></div></div>}
      </div> : null}

      {tab === 'comments' ? <div id={`${id}-comments-panel`} role="tabpanel" aria-labelledby={`${id}-comments-tab`} className="organism-detail__hitl-panel organism-detail__comments">
        <form onSubmit={submitComment}>
          <label htmlFor={`${id}-agent-comment`}>Your comment <span>optional until sent</span></label>
          <textarea id={`${id}-agent-comment`} maxLength={2_000} rows={4} value={commentDraft} onChange={(event) => { setCommentDraft(event.target.value); setCommentState('idle'); }} placeholder={`Clarify a constraint, answer a question, or guide ${definition.label}…`} />
          <div><small>{commentDraft.length}/2,000</small><button type="submit" disabled={!commentDraft.trim() || commentState === 'sending'}>{commentState === 'sending' ? 'Sending…' : `Send to ${definition.label} →`}</button></div>
          {commentState === 'sent' ? <p className="organism-detail__notice" role="status">Comment sent and attached to this iteration.</p> : null}
          {commentState === 'error' ? <p className="organism-detail__notice organism-detail__notice--error" role="alert">We could not send that comment. Your draft is still here.</p> : null}
        </form>
        {selectedComments.length > 0 ? <div className="organism-detail__comment-history"><h4>Recent comments</h4>{selectedComments.slice(0, 5).map((comment) => <article key={comment.id}><div><strong>{comment.author}</strong><time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time></div><p>{comment.comment}</p></article>)}</div> : null}
      </div> : null}
    </section>
  </section>;
}

export function selectCanonicalAgentSpotlight(detail: ProjectDetail, role: AgentRole): CanonicalAgentSpotlightView {
  const currentIteration = detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration);
  const iterationId = currentIteration?.id;
  const inCurrentIteration = (record: { iterationId: string | null }) => Boolean(iterationId && record.iterationId === iterationId);
  const available = detail.agentGoals !== undefined
    || detail.agentActionPlans !== undefined
    || detail.agentActions !== undefined
    || detail.agentObligations !== undefined
    || detail.artifactVersions !== undefined
    || detail.findings !== undefined
    || detail.modelInvocations !== undefined
    || detail.repositoryOperations !== undefined;

  const goals = [...(detail.agentGoals ?? [])]
    .filter((record) => inCurrentIteration(record) && record.role === role)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const plans = [...(detail.agentActionPlans ?? [])]
    .filter((record) => inCurrentIteration(record) && record.role === role)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const actions = [...(detail.agentActions ?? [])]
    .filter((record) => inCurrentIteration(record) && record.role === role)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const selectedActionIds = new Set(actions.map((action) => action.id));
  const obligations = [...(detail.agentObligations ?? [])]
    .filter((record) => inCurrentIteration(record) && record.ownerRole === role)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const findings = [...(detail.findings ?? [])]
    .filter((record) => inCurrentIteration(record)
      && record.ownerRole === role
      && ['open', 'acknowledged', 'remediating'].includes(record.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  const latestArtifactById = new Map<string, ArtifactVersionRecord>();
  for (const record of (detail.artifactVersions ?? []).filter((candidate) => inCurrentIteration(candidate) && candidate.producedByRole === role)) {
    const current = latestArtifactById.get(record.artifactId);
    if (!current || record.version > current.version || (record.version === current.version && record.createdAt > current.createdAt)) {
      latestArtifactById.set(record.artifactId, record);
    }
  }
  const artifactVersions = [...latestArtifactById.values()]
    .filter((record) => record.status !== 'superseded')
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const modelInvocations = [...(detail.modelInvocations ?? [])]
    .filter((record) => inCurrentIteration(record) && (record.role === role || (record.role === null && Boolean(record.actionId && selectedActionIds.has(record.actionId)))))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const repositoryOperations = [...(detail.repositoryOperations ?? [])]
    .filter((record) => inCurrentIteration(record) && (record.role === role || (record.role === null && Boolean(record.actionId && selectedActionIds.has(record.actionId)))))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  return {
    available,
    iterationNumber: detail.project.currentIteration,
    currentGoal: goals.find((goal) => goal.status === 'active' || goal.status === 'blocked'),
    currentPlan: plans.find((plan) => plan.status === 'draft' || plan.status === 'active' || plan.status === 'blocked'),
    actions,
    obligations,
    findings,
    artifactVersions,
    modelInvocations,
    repositoryOperations,
  };
}

function CanonicalAgentSpotlight({ view, role }: { view: CanonicalAgentSpotlightView; role: AgentRole }) {
  const pendingActions = view.actions.filter((action) => ['pending', 'ready', 'running', 'waiting'].includes(action.status)).length;
  const completedActions = view.actions.filter((action) => action.status === 'completed').length;
  const otherActions = view.actions.length - pendingActions - completedActions;
  const pendingObligations = view.obligations.filter((obligation) => ['pending', 'ready', 'in_progress', 'blocked'].includes(obligation.status)).length;
  const satisfiedObligations = view.obligations.filter((obligation) => obligation.status === 'satisfied').length;
  const otherObligations = view.obligations.length - pendingObligations - satisfiedObligations;
  const roleName = roleLabel(role);

  return <section className="organism-canonical" aria-label={`${roleName} canonical ledger spotlight`}>
    <div className="organism-canonical__heading">
      <div><p>Canonical role ledger · iteration {view.iterationNumber}</p><h4>Durable spotlight</h4></div>
      <span>{view.available ? 'Recorded' : 'Unavailable'}</span>
    </div>

    {!view.available ? <div className="organism-canonical__empty"><strong>No canonical ledger projection</strong><p>This response does not include role-scoped goals, actions, evidence, or operations.</p></div> : <>
      <div className="organism-canonical__lead-grid">
        <CanonicalLeadRecord
          label="Current goal"
          status={view.currentGoal?.status}
          title={view.currentGoal?.objective}
          detail={view.currentGoal ? `${humanizeToken(view.currentGoal.priority)} priority${view.currentGoal.successCriteria.length > 0 ? ` · ${view.currentGoal.successCriteria.length} success criteria` : ' · no success criteria recorded'}` : undefined}
          timestamp={view.currentGoal?.updatedAt}
          empty={`No active or blocked goal is recorded for ${roleName} in this iteration.`}
        />
        <CanonicalLeadRecord
          label="Current plan"
          status={view.currentPlan?.status}
          title={view.currentPlan?.summary}
          detail={view.currentPlan ? `Version ${view.currentPlan.version}${view.currentPlan.sourceRevision ? ` · revision ${view.currentPlan.sourceRevision}` : ' · no source revision recorded'}` : undefined}
          timestamp={view.currentPlan?.updatedAt}
          empty={`No draft, active, or blocked plan is recorded for ${roleName} in this iteration.`}
        />
      </div>

      <dl className="organism-canonical__counts">
        <div><dt>Actions</dt><dd>{pendingActions} pending · {completedActions} complete{otherActions > 0 ? ` · ${otherActions} other` : ''}</dd></div>
        <div><dt>Obligations</dt><dd>{pendingObligations} open · {satisfiedObligations} satisfied{otherObligations > 0 ? ` · ${otherObligations} other` : ''}</dd></div>
        <div><dt>Findings</dt><dd>{view.findings.length} unresolved</dd></div>
        <div><dt>Artifacts</dt><dd>{view.artifactVersions.length} current</dd></div>
        <div><dt>Model calls</dt><dd>{view.modelInvocations.length} recorded</dd></div>
        <div><dt>Repository</dt><dd>{view.repositoryOperations.length} operations</dd></div>
      </dl>

      <CanonicalRecordGroup title="Actions and obligations" count={view.actions.length + view.obligations.length}>
        <h6>Actions</h6>
        {view.actions.length > 0 ? <ul>{view.actions.slice(0, 5).map((action) => <li key={action.id}>
          <CanonicalRecordHeading status={action.status} timestamp={action.completedAt ?? action.startedAt ?? action.updatedAt} />
          <strong>{action.summary}</strong>
          <small>{humanizeToken(action.kind)} · position {action.position + 1}{action.blocking ? ' · blocking' : ''}</small>
          {action.error ? <p className="is-error">{action.error}</p> : null}
        </li>)}</ul> : <CanonicalEmpty text={`No current-iteration actions are recorded for ${roleName}.`} />}
        {view.actions.length > 5 ? <p className="organism-canonical__more">{view.actions.length - 5} more actions recorded</p> : null}

        <h6>Obligations</h6>
        {view.obligations.length > 0 ? <ul>{view.obligations.slice(0, 5).map((obligation) => <li key={obligation.id}>
          <CanonicalRecordHeading status={obligation.status} timestamp={obligation.satisfiedAt ?? obligation.updatedAt} />
          <strong>{obligation.title}</strong>
          <small>{humanizeToken(obligation.type)} · {obligation.mandatory ? 'mandatory' : 'optional'}{obligation.blocking ? ' · blocking' : ''}</small>
          {obligation.disposition ? <p>{obligation.disposition}</p> : null}
        </li>)}</ul> : <CanonicalEmpty text={`No current-iteration obligations are recorded for ${roleName}.`} />}
        {view.obligations.length > 5 ? <p className="organism-canonical__more">{view.obligations.length - 5} more obligations recorded</p> : null}
      </CanonicalRecordGroup>

      <CanonicalRecordGroup title="Findings and artifact versions" count={view.findings.length + view.artifactVersions.length}>
        <h6>Owned unresolved findings</h6>
        {view.findings.length > 0 ? <ul>{view.findings.slice(0, 5).map((finding) => <li className={`is-severity-${finding.severity}`} key={finding.id}>
          <CanonicalRecordHeading status={`${finding.severity} · ${finding.status}`} timestamp={finding.updatedAt} />
          <strong>{finding.title}</strong>
          <small>{humanizeToken(finding.category)}{finding.disposition ? ` · ${humanizeToken(finding.disposition)}` : ' · no disposition recorded'}</small>
          <p>{finding.description}</p>
        </li>)}</ul> : <CanonicalEmpty text={`No unresolved finding is assigned to ${roleName} in this iteration.`} />}
        {view.findings.length > 5 ? <p className="organism-canonical__more">{view.findings.length - 5} more unresolved findings recorded</p> : null}

        <h6>Current artifact versions</h6>
        {view.artifactVersions.length > 0 ? <ul>{view.artifactVersions.slice(0, 5).map((artifact) => <li key={artifact.id}>
          <CanonicalRecordHeading status={artifact.status} timestamp={artifact.createdAt} />
          <strong>{artifact.artifactName} · v{artifact.version}</strong>
          <small>{humanizeToken(artifact.artifactType)}{artifact.sourceRevision ? ` · revision ${artifact.sourceRevision}` : ' · no source revision recorded'}</small>
          {artifact.repositoryPath ? <p>{artifact.repositoryPath}</p> : null}
        </li>)}</ul> : <CanonicalEmpty text={`No current artifact version is owned by ${roleName} in this iteration.`} />}
        {view.artifactVersions.length > 5 ? <p className="organism-canonical__more">{view.artifactVersions.length - 5} more current artifact versions recorded</p> : null}
      </CanonicalRecordGroup>

      <CanonicalRecordGroup title="Model and repository operations" count={view.modelInvocations.length + view.repositoryOperations.length}>
        <h6>Canonical model calls</h6>
        {view.modelInvocations.length > 0 ? <ul>{view.modelInvocations.slice(0, 5).map((invocation) => <li key={invocation.id}>
          <CanonicalRecordHeading status={invocation.status} timestamp={invocation.completedAt ?? invocation.startedAt ?? invocation.createdAt} />
          <strong>{invocation.provider} · {invocation.model}</strong>
          <small>{humanizeToken(invocation.purpose)} · {invocation.totalTokens.toLocaleString()} tokens · {formatModelCost(invocation.costUsd)}</small>
          {invocation.error ? <p className="is-error">{invocation.error}</p> : null}
        </li>)}</ul> : <CanonicalEmpty text={`No canonical model call is attributed to ${roleName} in this iteration.`} />}
        {view.modelInvocations.length > 5 ? <p className="organism-canonical__more">{view.modelInvocations.length - 5} more model calls recorded</p> : null}

        <h6>Repository operations</h6>
        {view.repositoryOperations.length > 0 ? <ul>{view.repositoryOperations.slice(0, 5).map((operation) => <li key={operation.id}>
          <CanonicalRecordHeading status={operation.status} timestamp={operation.completedAt ?? operation.startedAt ?? operation.createdAt} />
          <strong>{operation.summary}</strong>
          <small>{humanizeToken(operation.type)} · {operation.mutating ? 'mutating' : 'read only'}{operation.branchName ? ` · ${operation.branchName}` : ''}</small>
          {operation.resultingRevision ? <p>Result {operation.resultingRevision}</p> : operation.paths.length > 0 ? <p>{operation.paths.join(', ')}</p> : null}
        </li>)}</ul> : <CanonicalEmpty text={`No repository operation is attributed to ${roleName} in this iteration.`} />}
        {view.repositoryOperations.length > 5 ? <p className="organism-canonical__more">{view.repositoryOperations.length - 5} more repository operations recorded</p> : null}
      </CanonicalRecordGroup>
    </>}
  </section>;
}

function CanonicalLeadRecord({ label, status, title, detail, timestamp, empty }: { label: string; status?: string; title?: string; detail?: string; timestamp?: string; empty: string }) {
  return <article className={`organism-canonical__lead${title ? '' : ' is-empty'}`}>
    <div><span>{label}</span>{status ? <b className={`is-status-${status}`}>{humanizeToken(status)}</b> : null}</div>
    {title ? <><strong>{title}</strong>{detail ? <small>{detail}</small> : null}{timestamp ? <CanonicalTimestamp value={timestamp} prefix="Updated" /> : null}</> : <p>{empty}</p>}
  </article>;
}

function CanonicalRecordGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <details className="organism-canonical__group">
    <summary><span>{title}</span><b>{count}</b></summary>
    <div>{children}</div>
  </details>;
}

function CanonicalRecordHeading({ status, timestamp }: { status: string; timestamp: string }) {
  return <div className="organism-canonical__record-heading"><span>{humanizeToken(status)}</span><CanonicalTimestamp value={timestamp} /></div>;
}

function CanonicalTimestamp({ value, prefix }: { value: string; prefix?: string }) {
  return <time dateTime={value} title={value}>{prefix ? `${prefix} ` : ''}{formatTimestamp(value)}</time>;
}

function CanonicalEmpty({ text }: { text: string }) {
  return <p className="organism-canonical__record-empty">{text}</p>;
}

export interface AgentModelUsageSummary {
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  openRouterRequests: number;
  openRouterCost: number;
  openRouterCostReported: boolean;
}

export function summarizeAgentModelUsage(
  artifacts: readonly ProjectArtifact[],
  role: AgentRole,
  primaryArtifactType?: string,
): AgentModelUsageSummary {
  const summary: AgentModelUsageSummary = {
    requests: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    openRouterRequests: 0,
    openRouterCost: 0,
    openRouterCostReported: false,
  };
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.producedBy !== role || (primaryArtifactType && artifact.type !== primaryArtifactType)) continue;
    for (const [index, invocation] of (artifact.modelInvocations ?? []).entries()) {
      const identity = invocation.requestId ? `${invocation.provider ?? artifact.modelProvider}:${invocation.requestId}` : `${artifact.id}:${index}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const promptTokens = invocation.usage?.promptTokens ?? 0;
      const completionTokens = invocation.usage?.completionTokens ?? 0;
      const reasoningTokens = invocation.usage?.reasoningTokens ?? 0;
      summary.requests += 1;
      summary.promptTokens += promptTokens;
      summary.completionTokens += completionTokens;
      summary.reasoningTokens += reasoningTokens;
      summary.totalTokens += invocation.usage?.totalTokens ?? promptTokens + completionTokens;
      if ((invocation.provider ?? artifact.modelProvider) === 'openrouter') {
        summary.openRouterRequests += 1;
        if (typeof invocation.usage?.cost === 'number') {
          summary.openRouterCost += invocation.usage.cost;
          summary.openRouterCostReported = true;
        }
      }
    }
  }
  return summary;
}

function AgentRuntimeSummary({ agent, elapsedNow }: { agent: EffectiveAgent; elapsedNow: number }) {
  const { node, state } = agent;
  const activity = node?.activity;
  const stateSince = node?.stateChangedAt ?? activity?.startedAt ?? node?.startedAt;
  const waitReason = state === 'waiting_on_agent'
    ? node?.latestFinding ?? `${agent.dependsOn.map(roleLabel).join(' · ') || 'A declared dependency'} must provide the next handoff.`
    : state === 'waiting_on_human'
      ? 'A human answer or decision is required before this role can continue.'
      : state === 'blocked'
        ? node?.latestFinding ?? 'The latest runtime state reports an unresolved blocker.'
        : undefined;

  return <section className={`organism-detail__runtime organism-detail__runtime--${state}`} aria-label="Current runtime activity">
    <div className="organism-detail__runtime-heading"><h4>Current activity</h4>{stateSince ? <time dateTime={stateSince}>{formatElapsed(stateSince, elapsedNow)}</time> : null}</div>
    <strong>{activity?.summary ?? stateCopy[state].label}</strong>
    {activity?.type ? <p>{humanizeToken(activity.type)}</p> : null}
    {waitReason ? <p className="organism-detail__runtime-wait"><span aria-hidden="true">{state === 'blocked' ? '!' : '?'}</span>{waitReason}</p> : null}
    <dl>
      <div><dt>Open messages</dt><dd>{node?.openMessageCount ?? 0}</dd></div>
      <div><dt>Dependencies</dt><dd>{node?.blockingDependencyCount ?? 0}</dd></div>
      <div><dt>Tokens</dt><dd>{typeof node?.tokenUse === 'number' ? node.tokenUse.toLocaleString() : '—'}</dd></div>
      <div><dt>Cost</dt><dd>{typeof node?.openRouterCost === 'number' ? formatModelCost(node.openRouterCost) : '—'}</dd></div>
    </dl>
    {node?.latestFinding ? <p className="organism-detail__runtime-latest is-finding"><span>Latest finding</span>{node.latestFinding}</p> : null}
    {node?.latestArtifact ? <p className="organism-detail__runtime-latest"><span>Latest artifact</span>{node.latestArtifact}</p> : null}
  </section>;
}

function ModelUsageSummary({ usage }: { usage: AgentModelUsageSummary }) {
  return <section className="organism-detail__usage" aria-label="Recorded model usage">
    <div className="organism-detail__usage-heading"><h4>Model usage</h4><span>Recorded so far</span></div>
    {usage.requests > 0 ? <>
      <div className="organism-detail__usage-grid">
        <article><span>Tokens</span><strong>{usage.totalTokens.toLocaleString()}</strong><small>{usage.promptTokens.toLocaleString()} input · {usage.completionTokens.toLocaleString()} output{usage.reasoningTokens > 0 ? ` · ${usage.reasoningTokens.toLocaleString()} reasoning` : ''}</small></article>
        <article><span>Requests</span><strong>{usage.requests.toLocaleString()}</strong><small>Completed model calls</small></article>
        {usage.openRouterRequests > 0 ? <article className="organism-detail__usage-cost"><span>OpenRouter cost</span><strong>{usage.openRouterCostReported ? formatModelCost(usage.openRouterCost) : 'Not reported'}</strong><small>{usage.openRouterRequests.toLocaleString()} hosted request{usage.openRouterRequests === 1 ? '' : 's'}</small></article> : null}
      </div>
      <p>Totals update after completed model calls are saved with an agent artifact.</p>
    </> : <div className="organism-detail__usage-empty"><strong>No recorded usage yet</strong><span>Token and OpenRouter cost totals appear after this agent saves an artifact.</span></div>}
  </section>;
}

function formatModelCost(value: number) {
  if (value === 0) return '$0.00';
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function DetailList({ title, values, empty, tone = 'default' }: { title: string; values: readonly string[]; empty: string; tone?: 'default' | 'boundary' }) {
  return <section className={`organism-detail__list organism-detail__list--${tone}`}>
    <h4>{title}</h4>
    {values.length > 0 ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>{empty}</p>}
  </section>;
}

function CompactExchange({ label, interaction }: { label: string; interaction: AgentInteraction }) {
  const status = interactionStatusCopy[interaction.status];
  return <article className={`organism-exchange organism-exchange--${interaction.status}`}>
    <div><span>{label}</span><time dateTime={interaction.createdAt}>{formatTimestamp(interaction.createdAt)}</time></div>
    <strong>{interaction.name}</strong>
    <p>{partyLabel(interaction.from)} <b aria-hidden="true">→</b> {interaction.to.map(partyLabel).join(', ')}</p>
    <small><i aria-hidden="true">{status.icon}</i>{status.label} · {interactionKindCopy[interaction.kind]}</small>
  </article>;
}

function ReadinessPanel({ readiness, iterationNumber }: { readiness: OrganismReadinessView; iterationNumber: number }) {
  const readyItems = readiness.items.filter((item) => item.status === 'ready' || item.status === 'not_required').length;
  const blockingItems = readiness.items.filter((item) => item.status === 'blocked').length;
  const readyPercentage = readiness.items.length > 0 ? Math.round((readyItems / readiness.items.length) * 100) : 0;
  const readinessColor = blockingItems > 0 ? '#a84f40' : readyItems === readiness.items.length ? '#4f8567' : 'var(--organism-gold)';
  return <section className="organism-readiness" aria-labelledby={`iteration-${iterationNumber}-readiness-title`}>
    <div className="organism-readiness__heading">
      <div>
        <p className="organism__eyebrow">Iteration {iterationNumber} readiness · {readiness.source === 'proposal' ? 'latest Manager proposal' : readiness.source === 'recorded' ? 'recorded evidence' : 'compatibility view'}</p>
        <h3 id={`iteration-${iterationNumber}-readiness-title`}>{readiness.managerRecommendation}</h3>
        <p>{readiness.managerRationale}</p>
      </div>
      <div
        className={`organism-readiness__score${blockingItems > 0 ? ' is-blocked' : readyItems === readiness.items.length ? ' is-ready' : ''}`}
        style={{ '--readiness-color': readinessColor, '--readiness-progress': `${readyPercentage}%` } as CSSProperties}
        aria-label={`${readyItems} of ${readiness.items.length} readiness checks ready`}
      >
        <strong>{readyItems}/{readiness.items.length}</strong><span>checks ready</span>
      </div>
    </div>
    <div className="organism-readiness__strip" role="list" aria-live="polite">
      {readiness.items.map((item) => <article className={`organism-readiness__item organism-readiness__item--${item.status}`} role="listitem" key={item.id} title={item.summary}>
        <span aria-hidden="true">{readinessStatusIcon(item.status)}</span>
        <div><strong>{item.label}</strong><small>{item.current !== undefined && item.target !== undefined ? `${item.current} / ${item.target}` : item.summary}</small></div>
      </article>)}
    </div>
    <div className="organism-readiness__facts">
      <span>Objective <strong>{readiness.objectiveStatus}</strong></span>
      <span>Gate <strong>{readiness.gateStatus}</strong></span>
      <span>Critical <strong>{readiness.openCriticalFindings}</strong></span>
      <span>High <strong>{readiness.openHighFindings}</strong></span>
      <span>Human decisions <strong>{readiness.pendingHumanDecisions}</strong></span>
      {readiness.includedRevision ? <span>Included revision <strong>{readiness.includedRevision}</strong></span> : null}
      {readiness.proposedAt ? <span>Proposed <strong>{formatTimestamp(readiness.proposedAt)}</strong></span> : null}
    </div>
  </section>;
}

function ActivityStream({
  idPrefix,
  interactions,
  threads,
  agents,
  artifacts,
  iterationNumbers,
  selectedThreadId,
  onFocusThread,
  onSelectRole,
}: {
  idPrefix: string;
  interactions: AgentInteraction[];
  threads: OrganismThreadView[];
  agents: EffectiveAgent[];
  artifacts: ProjectArtifact[];
  iterationNumbers: number[];
  selectedThreadId?: string;
  onFocusThread: (threadId: string, role?: AgentRole) => void;
  onSelectRole: (role: AgentRole) => void;
}) {
  const [agentFilter, setAgentFilter] = useState<ActivityAgentFilter>('all');
  const [kindFilter, setKindFilter] = useState<ActivityKindFilter>('all');
  const [iterationFilter, setIterationFilter] = useState<ActivityIterationFilter>('all');
  const [dimensionFilter, setDimensionFilter] = useState<ActivityDimensionFilter>('all');
  const [threadFilter, setThreadFilter] = useState('all');

  useEffect(() => {
    if (!selectedThreadId) return;
    const thread = threads.find((candidate) => candidate.id === selectedThreadId);
    if (thread) setThreadFilter(thread.correlationId);
  }, [selectedThreadId, threads]);

  const filtered = useMemo(() => filterActivityInteractions(interactions, {
    agent: agentFilter,
    kind: kindFilter,
    iterationNumber: iterationFilter,
    dimension: dimensionFilter,
    correlationId: threadFilter,
    artifacts,
  }), [agentFilter, artifacts, dimensionFilter, interactions, iterationFilter, kindFilter, threadFilter]);
  const availableIterations = useMemo(
    () => [...new Set([...iterationNumbers, ...interactions.map((interaction) => interaction.iterationNumber)])].sort((left, right) => right - left),
    [interactions, iterationNumbers],
  );
  const dimensionCounts = useMemo(() => Object.fromEntries(
    (Object.keys(activityDimensionCopy) as Exclude<ActivityDimensionFilter, 'all'>[]).map((dimension) => [
      dimension,
      filterActivityInteractions(interactions, { dimension, artifacts }).length,
    ]),
  ) as Record<Exclude<ActivityDimensionFilter, 'all'>, number>, [artifacts, interactions]);

  return <section className="organism-activity" aria-labelledby={`${idPrefix}-activity-title`}>
    <div className="organism-activity__heading">
      <div><p className="organism__eyebrow">Shared activity stream</p><h3 id={`${idPrefix}-activity-title`}>Messages, findings, evidence and decisions</h3></div>
      <p>{filtered.length} of {interactions.length} events · newest first</p>
    </div>
    <div className="organism-activity__filters" aria-label="Activity stream filters">
      <label>Agent<select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value as ActivityAgentFilter)}>
        <option value="all">All agents</option>{agents.map((agent) => <option value={agent.definition.role} key={agent.definition.role}>{agent.definition.label}</option>)}
      </select></label>
      <label>Message type<select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as ActivityKindFilter)}>
        <option value="all">All types</option>{(Object.keys(interactionKindCopy) as AgentInteraction['kind'][]).map((kind) => <option value={kind} key={kind}>{interactionKindCopy[kind]}</option>)}
      </select></label>
      <label>Iteration<select value={iterationFilter} onChange={(event) => setIterationFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
        <option value="all">All iterations</option>{availableIterations.map((iteration) => <option value={iteration} key={iteration}>Iteration {iteration}</option>)}
      </select></label>
      <label>Thread<select value={threadFilter} onChange={(event) => setThreadFilter(event.target.value)}>
        <option value="all">All threads</option>{threads.map((thread) => <option value={thread.correlationId} key={thread.id}>{thread.title}</option>)}
      </select></label>
      <label>Recorded dimension<select value={dimensionFilter} onChange={(event) => setDimensionFilter(event.target.value as ActivityDimensionFilter)}>
        <option value="all">All recorded dimensions</option>{(Object.entries(activityDimensionCopy) as [Exclude<ActivityDimensionFilter, 'all'>, string][]).map(([dimension, label]) => <option value={dimension} key={dimension} disabled={dimensionCounts[dimension] === 0}>{label} · {dimensionCounts[dimension]}</option>)}
      </select></label>
    </div>
    {filtered.length > 0 ? <ol className="organism-activity__list" aria-live="polite">
      {filtered.slice(0, 50).map((interaction) => {
        const status = interactionStatusCopy[interaction.status];
        const thread = threads.find((candidate) => candidate.correlationId === interaction.correlationId || candidate.messageIds.includes(interaction.messageId ?? interaction.id));
        const primaryRole = isAgentRole(interaction.from) ? interaction.from : interaction.to.find(isAgentRole);
        const dimensions = interactionDimensions(interaction, artifacts).filter((dimension) => dimension !== 'human' && dimension !== 'finding');
        const activate = () => thread ? onFocusThread(thread.id, primaryRole) : primaryRole ? onSelectRole(primaryRole) : undefined;
        return <li className={`organism-activity__row organism-activity__row--${interaction.kind}${interaction.live ? ' is-live' : ''}`} key={interaction.id}>
          <button type="button" onClick={activate} disabled={!thread && !primaryRole} aria-label={`Inspect ${interaction.name}`}>
            <span className="organism-activity__kind" aria-hidden="true">{interactionKindIcon[interaction.kind]}</span>
            <time dateTime={interaction.createdAt}>{formatTimestamp(interaction.createdAt)}</time>
            <div className="organism-activity__route"><strong>{partyLabel(interaction.from)}</strong><span aria-hidden="true">→</span><strong>{interaction.to.map(partyLabel).join(', ')}</strong></div>
            <div className="organism-activity__message"><span>{interactionKindCopy[interaction.kind]} · {status.label}{thread ? ` · ${thread.title}` : ''}{dimensions.length > 0 ? ` · ${dimensions.map((dimension) => activityDimensionCopy[dimension]).join(' · ')}` : ''}</span><strong>{interaction.name}</strong><p>{interaction.summary}</p></div>
            {interaction.live ? <em>Live</em> : null}
          </button>
        </li>;
      })}
    </ol> : <div className="organism-activity__empty"><span aria-hidden="true">◎</span><div><strong>No events match these filters</strong><p>Clear one or more filters to return to the full durable activity stream.</p></div></div>}
  </section>;
}

function buildEffectiveAgents(detail: ProjectDetail): EffectiveAgent[] {
  const graphNodeByRole = new Map(detail.executionGraph?.nodes.map((node) => [node.role, node]) ?? []);
  const deliveryNodeByRole = new Map<AgentRole, (typeof deliveryAgentGraph)[number]>(
    deliveryAgentGraph.map((node): [AgentRole, (typeof deliveryAgentGraph)[number]] => [node.role, node]),
  );
  const activeIteration = detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration);
  const iterationArtifacts = detail.artifacts.filter((artifact) => !activeIteration || artifact.iterationId === activeIteration.id);
  const completedRoles = new Set(iterationArtifacts.map((artifact) => artifact.producedBy));
  const latestEvents = new Map<AgentRole, ProjectEvent>();
  const latestTypedStates = new Map<AgentRole, AgentExecutionState>();

  for (const event of [...(detail.organismEvents ?? [])].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== 'agent.state.changed' || !event.subjectRole) continue;
    if (activeIteration && event.iterationId && event.iterationId !== activeIteration.id) continue;
    const state = organismEventState(event);
    if (state) latestTypedStates.set(event.subjectRole, state);
  }

  for (const event of [...detail.events].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
    if (event.agentRole && event.iterationNumber === detail.project.currentIteration) latestEvents.set(event.agentRole, event);
  }

  return agentRoleDefinitions.map((definition) => {
    const node = graphNodeByRole.get(definition.role);
    const deliveryNode = deliveryNodeByRole.get(definition.role);
    const latestEvent = latestEvents.get(definition.role);
    const latestTypedState = latestTypedStates.get(definition.role);
    const releaseOnly = deliveryNode && 'activation' in deliveryNode && deliveryNode.activation === 'authorized_release';
    const state = normalizeAgentState(
      node?.state ?? latestTypedState ?? (releaseOnly ? 'dormant' : inferAgentState(latestEvent, completedRoles.has(definition.role))),
    );
    return {
      definition,
      node,
      state,
      dependsOn: node?.dependsOn ?? deliveryNode?.dependsOn ?? [],
      supervisedBy: node?.supervisedBy ?? deliveryNode?.supervisedBy ?? [],
      artifactName: node?.artifactName ?? deliveryNode?.artifactName ?? definition.primaryArtifacts[0] ?? 'role artifact',
      assignedModel: node?.assignedModel,
      assignedProvider: node?.assignedProvider,
    };
  });
}

export function normalizeAgentState(
  state: AgentExecutionState | LegacyAgentExecutionState | null | undefined,
): AgentExecutionState {
  if (state === 'dormant') return 'observing';
  if (state === 'waiting') return 'waiting_on_agent';
  if (state === 'active') return 'working';
  if (state === 'completed') return 'completed_for_iteration';
  return state ?? 'observing';
}

function inferAgentState(event: ProjectEvent | undefined, hasArtifact: boolean): AgentExecutionState {
  if (hasArtifact) return 'completed_for_iteration';
  const text = `${event?.title ?? ''} ${event?.description ?? ''}`.toLowerCase();
  if (/block|fail|cannot|needs attention|packaging check failed|packaging checks failed/.test(text)) return 'blocked';
  if (/review|evaluat|compar/.test(text)) return 'reviewing';
  if (/plan|deciding next/.test(text)) return 'planning';
  if (/message|send|receiv|acknowledg/.test(text)) return 'communicating';
  if (/start|working|running|progress|active/.test(text)) return 'working';
  if (/ready|queued|accepted|acknowledged/.test(text)) return 'ready';
  return 'waiting_on_agent';
}

export function buildInteractionLedger(detail: ProjectDetail): AgentInteraction[] {
  const graph = detail.executionGraph as (typeof detail.executionGraph & { interactions?: AgentInteraction[] }) | undefined;
  const recorded = [...(graph?.interactions ?? []), ...(detail.agentMessages ?? [])];
  const typed = (detail.organismEvents ?? []).flatMap((event) => {
    const interaction = interactionFromOrganismEvent(event, detail);
    return interaction ? [interaction] : [];
  });
  const unique = new Map<string, AgentInteraction>();
  for (const interaction of [...recorded, ...typed]) {
    const identity = interaction.messageId ?? interaction.id;
    if (!unique.has(identity)) unique.set(identity, interaction);
  }
  // ProjectEvent predates the typed organism vocabulary. Text classification
  // is retained solely for snapshots from older workers that supply neither a
  // typed stream nor compact durable interactions.
  const interactions = unique.size > 0
    ? [...unique.values()]
    : detail.organismEvents === undefined
      ? detail.events.map((event) => interactionFromEvent(event, detail))
      : [];
  return interactions.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function selectInteractionThreads(
  interactions: readonly AgentInteraction[],
  suppliedThreads: readonly MessageThread[] = [],
): OrganismThreadView[] {
  const suppliedByCorrelation = new Map(suppliedThreads.map((thread) => [thread.correlationId, thread]));
  const grouped = new Map<string, AgentInteraction[]>();
  for (const interaction of interactions) {
    const correlationId = interaction.correlationId ?? `message:${interaction.messageId ?? interaction.id}`;
    grouped.set(correlationId, [...(grouped.get(correlationId) ?? []), interaction]);
  }

  const correlationIds = new Set([...suppliedByCorrelation.keys(), ...grouped.keys()]);
  return [...correlationIds].map((correlationId) => {
    const supplied = suppliedByCorrelation.get(correlationId);
    const messages = [...(grouped.get(correlationId) ?? [])].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const participants = uniqueRoles([
      ...(supplied?.participantRoles ?? []),
      ...messages.flatMap((message) => [message.from, ...message.to].filter(isAgentRole)),
    ]);
    const blocked = messages.some((message) => message.status === 'blocked' || message.kind === 'blocker');
    const active = messages.some((message) => message.live);
    const waiting = messages.some((message) => message.status === 'pending' || message.status === 'in_progress');
    return {
      id: supplied?.id ?? `thread:${correlationId}`,
      correlationId,
      title: supplied?.title ?? messages.at(-1)?.name ?? humanizeToken(correlationId),
      participantRoles: participants,
      messageIds: [...new Set([...(supplied?.messageIds ?? []), ...messages.map((message) => message.messageId ?? message.id)])],
      status: supplied?.status ?? (blocked ? 'blocked' : active ? 'active' : waiting ? 'waiting' : 'resolved'),
      updatedAt: supplied?.updatedAt ?? messages[0]?.createdAt ?? new Date(0).toISOString(),
    } satisfies OrganismThreadView;
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function filterActivityInteractions(
  interactions: readonly AgentInteraction[],
  filters: {
    agent?: ActivityAgentFilter;
    kind?: ActivityKindFilter;
    iterationNumber?: ActivityIterationFilter;
    dimension?: ActivityDimensionFilter;
    correlationId?: string;
    humanOnly?: boolean;
    artifacts?: readonly ProjectArtifact[];
  },
): AgentInteraction[] {
  return [...interactions]
    .filter((interaction) => !filters.agent || filters.agent === 'all' || involvesRole(interaction, filters.agent))
    .filter((interaction) => !filters.kind || filters.kind === 'all' || interaction.kind === filters.kind)
    .filter((interaction) => !filters.iterationNumber || filters.iterationNumber === 'all' || interaction.iterationNumber === filters.iterationNumber)
    .filter((interaction) => !filters.dimension || filters.dimension === 'all' || interactionDimensions(interaction, filters.artifacts ?? []).includes(filters.dimension))
    .filter((interaction) => !filters.correlationId || filters.correlationId === 'all' || interaction.correlationId === filters.correlationId)
    .filter((interaction) => !filters.humanOnly || interaction.from === 'human' || interaction.to.includes('human'))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function deriveIterationReadiness(detail: ProjectDetail): OrganismReadinessView {
  const latestProposal = currentIterationReviewProposal(detail);
  const recorded = detail.executionGraph?.readiness;
  if (latestProposal) {
    const positions = Object.values(latestProposal.agentPositions);
    const requiredPositions = positions.filter((position) => position !== 'not_required');
    const readyPositions = requiredPositions.filter((position) => position !== 'not_ready');
    const notReadyPositions = requiredPositions.length - readyPositions.length;
    const criticalFindings = latestProposal.openFindings.filter((finding) => finding.severity === 'critical').length;
    const highFindings = latestProposal.openFindings.filter((finding) => finding.severity === 'high').length;
    const resolveInIteration = latestProposal.openFindings.filter((finding) => finding.disposition === 'resolve_in_iteration').length;
    const humanDecisions = latestProposal.openFindings.filter((finding) => finding.disposition === 'human_decision_required').length;
    const proposalItems: OrganismReadinessItemView[] = [
      {
        id: 'objective',
        label: 'Iteration objective',
        status: 'ready',
        summary: humanizeToken(latestProposal.objectiveStatus),
      },
      {
        id: 'agents',
        label: 'Agent positions',
        status: notReadyPositions > 0 ? latestProposal.gateStatus === 'blocked' ? 'blocked' : 'waiting' : 'ready',
        summary: `${readyPositions.length} of ${requiredPositions.length} required agent positions are ready.`,
        current: readyPositions.length,
        target: requiredPositions.length,
      },
      {
        id: 'findings',
        label: 'Finding dispositions',
        status: resolveInIteration > 0 ? latestProposal.gateStatus === 'blocked' ? 'blocked' : 'waiting' : 'ready',
        summary: latestProposal.openFindings.length === 0 ? 'The proposal records no open findings.' : `${latestProposal.openFindings.length} open; ${resolveInIteration} marked resolve in iteration.`,
        current: resolveInIteration,
        target: 0,
      },
      {
        id: 'human',
        label: 'Human decisions',
        status: humanDecisions > 0 ? 'waiting' : 'ready',
        summary: humanDecisions > 0 ? `${humanDecisions} open finding${humanDecisions === 1 ? ' requires' : 's require'} a human decision.` : 'The proposal records no finding that requires a human decision.',
        current: humanDecisions,
        target: 0,
      },
      {
        id: 'gate',
        label: 'Gate status',
        status: latestProposal.gateStatus === 'pass' ? 'ready' : 'blocked',
        summary: latestProposal.gateStatus === 'pass' ? 'Gate passed for the included revision.' : 'Gate blocked the included revision.',
      },
    ];
    const proposalItemIds = new Set(proposalItems.map((item) => item.id));
    return {
      source: 'proposal',
      objectiveStatus: humanizeToken(latestProposal.objectiveStatus),
      items: [...proposalItems, ...(recorded?.items ?? []).filter((item) => !proposalItemIds.has(item.id)).map((item) => ({ ...item }))],
      gateStatus: humanizeToken(latestProposal.gateStatus),
      managerRecommendation: managerRecommendationCopy[latestProposal.recommendation],
      managerRationale: latestProposal.managerRationale,
      openCriticalFindings: criticalFindings,
      openHighFindings: highFindings,
      pendingHumanDecisions: humanDecisions,
      includedRevision: latestProposal.includedRevision,
      proposedAt: latestProposal.createdAt,
    };
  }
  if (recorded) {
    return {
      source: 'recorded',
      objectiveStatus: humanizeToken(recorded.objectiveStatus),
      items: recorded.items.map((item) => ({ ...item })),
      gateStatus: humanizeToken(recorded.gateStatus),
      managerRecommendation: managerRecommendationCopy[recorded.managerRecommendation],
      managerRationale: recorded.managerRationale,
      openCriticalFindings: recorded.openCriticalFindings,
      openHighFindings: recorded.openHighFindings,
      pendingHumanDecisions: recorded.pendingHumanDecisions,
    };
  }

  const iteration = detail.iterations.find((candidate) => candidate.number === detail.project.currentIteration);
  const artifacts = detail.artifacts.filter((artifact) =>
    (!iteration || artifact.iterationId === iteration.id)
    && (artifact.status === 'ready_for_review' || artifact.status === 'approved'));
  const iterationAgents = deliveryAgentGraph.filter((definition) => !('activation' in definition) || definition.activation !== 'authorized_release');
  const completedRoles = iterationAgents.filter((definition) => artifacts.some((artifact) => artifact.producedBy === definition.role && artifactTypeMatches(definition.artifactType, artifact.type)));
  const previewReady = detail.media.some((item) => item.kind === 'preview' && (!iteration || item.iterationId === iteration.id));
  const testReady = artifacts.some((artifact) => artifact.type === 'test-evidence');
  const gateReady = artifacts.some((artifact) => artifact.type === 'gate-decision');
  const pendingHumanDecisions = normalizeQuestions(detail).filter((question) => question.status === 'open').length;
  const iterationReady = Boolean(iteration && ['awaiting_review', 'approved', 'completed'].includes(iteration.status));
  const blocked = detail.project.status === 'blocked' || iteration?.status === 'blocked';
  const items: OrganismReadinessItemView[] = [
    { id: 'objective', label: 'Iteration objective', status: blocked ? 'blocked' : iterationReady ? 'ready' : 'waiting', summary: iteration?.objective || 'No current iteration objective is available.' },
    { id: 'preview', label: 'Runnable preview', status: blocked && !previewReady ? 'blocked' : previewReady ? 'ready' : 'waiting', summary: previewReady ? 'A preview is attached to this iteration.' : 'No current-iteration preview is attached yet.' },
    { id: 'artifacts', label: 'Required artifacts', status: completedRoles.length >= iterationAgents.length ? 'ready' : 'waiting', summary: `${completedRoles.length} of ${iterationAgents.length} role handoffs are recorded.`, current: completedRoles.length, target: iterationAgents.length },
    { id: 'tests', label: 'Test evidence', status: testReady ? 'ready' : 'waiting', summary: testReady ? 'A test-evidence artifact is recorded.' : 'Test evidence has not been recorded.' },
    { id: 'human', label: 'Human decisions', status: pendingHumanDecisions === 0 ? 'ready' : 'waiting', summary: pendingHumanDecisions === 0 ? 'No agent question is awaiting a human answer.' : `${pendingHumanDecisions} human decision${pendingHumanDecisions === 1 ? ' is' : 's are'} pending.`, current: pendingHumanDecisions, target: 0 },
    { id: 'gate', label: 'Gate status', status: blocked ? 'blocked' : gateReady ? 'ready' : 'waiting', summary: gateReady ? 'A gate-decision artifact is recorded.' : blocked ? 'The current iteration is blocked.' : 'Gate has not recorded a decision.' },
  ];
  return {
    source: 'fallback',
    objectiveStatus: blocked ? 'blocked' : iterationReady ? 'reviewable' : 'in progress',
    items,
    gateStatus: blocked ? 'blocked' : gateReady ? 'decision recorded' : 'waiting',
    managerRecommendation: 'Awaiting a recorded Manager recommendation',
    managerRationale: 'This compatibility view reports durable project evidence without inventing a Manager cutoff proposal.',
    openCriticalFindings: 0,
    openHighFindings: 0,
    pendingHumanDecisions,
  };
}

function currentIterationReviewProposal(detail: ProjectDetail): IterationReviewProposal | undefined {
  const iteration = detail.iterations.find((candidate) => candidate.number === detail.project.currentIteration);
  if (!iteration || iteration.status === 'changes_requested' || iteration.status === 'blocked') return undefined;
  const now = Date.now();
  const preview = detail.media
    .filter((item) => item.iterationId === iteration.id
      && item.kind === 'preview'
      && Boolean(item.sourceRevision)
      && (!item.expiresAt || Date.parse(item.expiresAt) > now))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  if (!preview?.sourceRevision) return undefined;

  const evidenceTimestamps = [
    ...detail.artifacts.filter((artifact) => artifact.iterationId === iteration.id).map((artifact) => artifact.createdAt),
    ...detail.media.filter((item) => item.iterationId === iteration.id).map((item) => item.createdAt),
    ...(detail.artifactVersions ?? []).filter((version) => version.iterationId === iteration.id).map((version) => version.createdAt),
    ...(detail.findings ?? []).filter((finding) => finding.iterationId === iteration.id).map((finding) => finding.updatedAt),
    ...(detail.agentGoals ?? []).filter((goal) => goal.iterationId === iteration.id).map((goal) => goal.updatedAt),
    ...(detail.agentActionPlans ?? []).filter((plan) => plan.iterationId === iteration.id).map((plan) => plan.updatedAt),
    ...(detail.agentActions ?? []).filter((action) => action.iterationId === iteration.id).map((action) => action.updatedAt),
    ...(detail.agentObligations ?? []).filter((obligation) => obligation.iterationId === iteration.id).map((obligation) => obligation.updatedAt),
    ...(detail.modelInvocations ?? []).filter((invocation) => invocation.iterationId === iteration.id).map((invocation) => invocation.completedAt ?? invocation.createdAt),
    ...(detail.repositoryOperations ?? []).filter((operation) => operation.iterationId === iteration.id).map((operation) => operation.completedAt ?? operation.createdAt),
    ...(detail.questions ?? []).filter((question) => question.iterationId === iteration.id || question.iterationId === null).map((question) => question.updatedAt),
    ...(detail.agentComments ?? []).filter((comment) => comment.iterationId === iteration.id || comment.iterationId === null).map((comment) => comment.createdAt),
    ...(detail.artifactFeedback ?? []).map((feedback) => feedback.createdAt),
    ...(detail.iterationReviews ?? []).filter((review) => review.iterationId === iteration.id).map((review) => review.createdAt),
  ].map((timestamp) => Date.parse(timestamp)).filter(Number.isFinite);
  const latestEvidenceAt = evidenceTimestamps.length > 0 ? Math.max(...evidenceTimestamps) : 0;

  return (detail.iterationReviewProposals ?? [])
    .filter((proposal) => proposal.iterationId === iteration.id
      && proposal.includedRevision === preview.sourceRevision
      && proposal.status !== 'rejected'
      && proposal.status !== 'superseded'
      && Date.parse(proposal.createdAt) >= latestEvidenceAt)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

export function buildGraphEdges(interactions: readonly AgentInteraction[], threads: readonly OrganismThreadView[] = []): GraphEdgeView[] {
  const edges = new Map<string, GraphEdgeView>();
  for (const target of deliveryAgentGraph) {
    for (const from of target.dependsOn) {
      const id = `${from}:${target.role}`;
      edges.set(id, {
        id,
        from,
        to: target.role,
        label: `${roleLabel(from)} handoff`,
        kind: 'dependency',
        interactions: [],
        threadIds: [],
      });
    }
  }

  const threadByCorrelation = new Map(threads.map((thread) => [thread.correlationId, thread.id]));
  for (const interaction of interactions) {
    if (!isAgentRole(interaction.from)) continue;
    for (const recipient of interaction.to.filter(isAgentRole)) {
      const id = `${interaction.from}:${recipient}`;
      const existing = edges.get(id);
      const edge = existing ?? {
        id,
        from: interaction.from,
        to: recipient,
        label: interactionKindCopy[interaction.kind],
        kind: 'message' as const,
        interactions: [],
        threadIds: [],
      };
      edge.interactions = [...edge.interactions, interaction].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      edge.activeInteraction = edge.interactions.find((candidate) => candidate.live);
      const threadId = interaction.correlationId ? threadByCorrelation.get(interaction.correlationId) : undefined;
      if (threadId) edge.threadIds = [...new Set([...edge.threadIds, threadId])];
      edges.set(id, edge);
    }
  }
  return [...edges.values()];
}

function graphEdgePath(from: AgentRole, to: AgentRole) {
  const source = graphPositions[from];
  const target = graphPositions[to];
  const forward = target.x >= source.x;
  const startX = forward ? source.x + graphNodeWidth : source.x;
  const endX = forward ? target.x : target.x + graphNodeWidth;
  const startY = source.y + graphNodeHeight / 2;
  const endY = target.y + graphNodeHeight / 2;
  const bend = Math.max(34, Math.abs(endX - startX) * .48);
  return `M${startX} ${startY} C${startX + (forward ? bend : -bend)} ${startY},${endX + (forward ? -bend : bend)} ${endY},${endX} ${endY}`;
}

function interactionFromOrganismEvent(event: OrganismEvent, detail: ProjectDetail): AgentInteraction | undefined {
  if (event.type === 'message.delivered' || event.type === 'message.acknowledged') return undefined;
  const iterationNumber = event.iterationId
    ? detail.iterations.find((iteration) => iteration.id === event.iterationId)?.number ?? detail.project.currentIteration
    : detail.project.currentIteration;
  const actor = organismActorParty(event);
  const targetRole = organismPayloadRole(event.payload.targetRole)
    ?? organismPayloadRole(event.payload.ownerRole)
    ?? event.subjectRole;
  const common = {
    iterationNumber,
    correlationId: event.correlationId,
    summary: event.summary,
    createdAt: event.createdAt,
  };

  if (event.type === 'message.sent') {
    const recipients = Array.isArray(event.payload.to)
      ? event.payload.to.map(organismPayloadParty).filter((party): party is InteractionParty => Boolean(party))
      : [];
    return {
      id: organismPayloadString(event.payload.interactionId) ?? `event:${event.eventId}`,
      messageId: organismPayloadString(event.payload.messageId) ?? event.eventId,
      ...common,
      from: organismPayloadParty(event.payload.from) ?? actor,
      to: recipients.length > 0 ? recipients : ['project'],
      kind: organismInteractionKind(event.payload.kind) ?? 'status',
      name: organismPayloadString(event.payload.name) ?? event.summary,
      status: organismInteractionStatus(event.payload.status) ?? 'completed',
      ...(organismPriority(event.payload.priority) ? { priority: organismPriority(event.payload.priority) } : {}),
      ...(typeof event.payload.requiresAcknowledgement === 'boolean'
        ? { requiresAcknowledgement: event.payload.requiresAcknowledgement }
        : {}),
      ...(organismPayloadString(event.payload.deliveredAt)
        ? { deliveredAt: organismPayloadString(event.payload.deliveredAt) }
        : {}),
      ...(Array.isArray(event.payload.artifactRefs)
        ? { artifactRefs: event.payload.artifactRefs as NonNullable<AgentInteraction['artifactRefs']> }
        : {}),
      ...(organismDimensions(event.payload.dimensions).length > 0
        ? { dimensions: organismDimensions(event.payload.dimensions) }
        : {}),
      live: event.payload.live === true,
    };
  }

  if (event.type === 'agent.state.changed' || event.type === 'agent.activity.started' || event.type === 'agent.activity.completed') {
    const state = organismEventState(event);
    const recordedStatus = organismPayloadString(event.payload.status);
    const status: AgentInteraction['status'] = recordedStatus === 'failed' || recordedStatus === 'cancelled' || state === 'blocked'
      ? 'blocked'
      : event.type === 'agent.activity.started' && event.payload.dimension === 'model' && recordedStatus === 'running'
        ? 'in_progress'
        : state === 'waiting_on_agent' || state === 'waiting_on_human'
          ? 'pending'
          : state && isComputationallyActive(state)
            ? 'in_progress'
            : 'completed';
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: ['project'],
      kind: status === 'blocked' ? 'blocker' : 'status',
      name: event.type === 'agent.state.changed'
        ? 'Agent state changed'
        : event.type === 'agent.activity.started'
          ? 'Agent activity started'
          : 'Agent activity completed',
      status,
      ...(event.payload.dimension === 'model' ? { dimensions: ['model' as const] } : {}),
      live: false,
    };
  }

  if (event.type === 'artifact.created' || event.type === 'artifact.revised') {
    const artifactId = organismPayloadString(event.payload.artifactId);
    const artifactType = organismPayloadString(event.payload.artifactType);
    const artifactName = organismPayloadString(event.payload.artifactName) ?? event.summary;
    const version = event.payload.version;
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: ['project'],
      kind: 'evidence',
      name: artifactName,
      status: 'completed',
      dimensions: ['artifact'],
      ...(artifactId && artifactType && (typeof version === 'number' || typeof version === 'string')
        ? {
            artifactRefs: [{
              artifactId,
              artifactType,
              version: String(version),
              name: artifactName,
              ...(event.subjectRole ? { ownerRole: event.subjectRole } : {}),
              ...(organismPayloadString(event.payload.storageUri)
                ? { storageUri: organismPayloadString(event.payload.storageUri) }
                : {}),
            }],
          }
        : {}),
      live: false,
    };
  }

  if (event.type === 'finding.opened' || event.type === 'finding.resolved' || event.type === 'policy.violation.detected') {
    const disposition = organismPayloadString(event.payload.disposition);
    const severity = organismPayloadString(event.payload.severity);
    const blocked = event.type !== 'finding.resolved' && (disposition === 'block_iteration' || severity === 'critical');
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: targetRole && targetRole !== actor ? [targetRole] : ['project'],
      kind: blocked || event.type === 'policy.violation.detected' ? 'blocker' : 'finding',
      name: organismPayloadString(event.payload.title) ?? (event.type === 'finding.resolved' ? 'Finding resolved' : 'Finding opened'),
      status: event.type === 'finding.resolved' ? 'completed' : blocked ? 'blocked' : 'pending',
      dimensions: ['finding'],
      ...(severity === 'critical' ? { priority: 'critical' as const }
        : severity === 'high' ? { priority: 'high' as const }
          : severity === 'low' || severity === 'info' ? { priority: 'low' as const }
            : {}),
      live: false,
    };
  }

  if (event.type === 'iteration.review.proposed') {
    const status = organismPayloadString(event.payload.status);
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: event.payload.recommendation === 'send_for_human_review' ? ['human'] : targetRole ? [targetRole] : ['project'],
      kind: 'review_proposal',
      name: 'Iteration review proposal',
      status: status === 'gate_blocked' ? 'blocked'
        : status === 'rejected' ? 'rejected'
          : status === 'draft' || status === 'proposed' ? 'pending'
            : 'completed',
      live: false,
    };
  }

  if (event.type === 'human.feedback.received' || event.type === 'question.answered') {
    return {
      id: `event:${event.eventId}`,
      ...common,
      from: actor,
      to: targetRole ? [targetRole] : ['project'],
      kind: event.type === 'question.answered'
        ? 'answer'
        : organismPayloadString(event.payload.artifactId) ? 'revision_request' : 'request',
      name: event.type === 'question.answered'
        ? 'Question answered'
        : organismPayloadString(event.payload.artifactName) ?? 'Human feedback received',
      status: 'completed',
      ...(event.type === 'human.feedback.received' ? { dimensions: ['human' as const] } : {}),
      live: false,
    };
  }

  const structuralKind: Partial<Record<OrganismEvent['type'], AgentInteraction['kind']>> = {
    'decision.recorded': 'decision',
    'repository.revision.changed': 'status',
    'test.completed': 'evidence',
    'preview.deployed': 'handoff',
    'agent.registered': 'status',
  };
  const kind = structuralKind[event.type];
  if (!kind) return undefined;
  return {
    id: `event:${event.eventId}`,
    ...common,
    from: actor,
    to: targetRole && targetRole !== actor ? [targetRole] : ['project'],
    kind,
    name: humanizeToken(event.type),
    status: 'completed',
    ...(event.type === 'repository.revision.changed' ? { dimensions: ['repository' as const] }
      : event.payload.dimension === 'model' ? { dimensions: ['model' as const] }
        : {}),
    live: false,
  };
}

function organismActorParty(event: OrganismEvent): InteractionParty {
  if ('role' in event.actor) return event.actor.role;
  if ('humanId' in event.actor) return 'human';
  return 'system';
}

function organismEventState(event: OrganismEvent): AgentExecutionState | undefined {
  const state = event.payload.state;
  return typeof state === 'string' && agentExecutionStates.includes(state as AgentExecutionState)
    ? state as AgentExecutionState
    : undefined;
}

function organismPayloadString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function organismPayloadRole(value: unknown): AgentRole | undefined {
  return typeof value === 'string' && agentRoleDefinitions.some((definition) => definition.role === value)
    ? value as AgentRole
    : undefined;
}

function organismPayloadParty(value: unknown): InteractionParty | undefined {
  if (value === 'human' || value === 'system' || value === 'project') return value;
  return organismPayloadRole(value);
}

function organismInteractionKind(value: unknown): AgentInteraction['kind'] | undefined {
  return typeof value === 'string' && interactionKindValues.includes(value as AgentInteraction['kind'])
    ? value as AgentInteraction['kind']
    : undefined;
}

function organismInteractionStatus(value: unknown): AgentInteraction['status'] | undefined {
  return typeof value === 'string' && interactionStatusValues.includes(value as AgentInteraction['status'])
    ? value as AgentInteraction['status']
    : undefined;
}

function organismPriority(value: unknown): AgentInteraction['priority'] | undefined {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'critical' ? value : undefined;
}

function organismDimensions(value: unknown): NonNullable<AgentInteraction['dimensions']> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is NonNullable<AgentInteraction['dimensions']>[number] =>
    entry === 'artifact' || entry === 'finding' || entry === 'human' || entry === 'model' || entry === 'repository');
}

function interactionFromEvent(event: ProjectEvent, detail: ProjectDetail): AgentInteraction {
  const text = `${event.title} ${event.description}`;
  const from = event.agentRole ?? defaultEventSender(event);
  const kind = eventInteractionKind(event, text);
  const status = interactionStatusFromText(text);
  const to = eventTargets(event, from, kind, text);
  return {
    id: `event:${event.id}`,
    iterationNumber: event.iterationNumber ?? detail.project.currentIteration,
    from,
    to,
    kind,
    name: event.title,
    summary: event.description,
    status,
    createdAt: event.createdAt,
    // Legacy events are snapshots, not transport events. They remain visible in
    // the stream but never create a moving message marker.
    live: false,
  };
}

function defaultEventSender(event: ProjectEvent): InteractionParty {
  if (event.kind === 'project') return 'human';
  if (event.kind === 'deployment') return 'deployment';
  if (event.kind === 'review') return 'reviewer';
  return 'system';
}

function eventInteractionKind(event: ProjectEvent, text: string): AgentInteraction['kind'] {
  const normalized = text.toLowerCase();
  if (/human answered|answer to|answered the/.test(normalized)) return 'answer';
  if (/question|needs a human decision|awaiting human/.test(normalized)) return 'question';
  if (/revision request|changes requested|request changes/.test(normalized)) return 'revision_request';
  if (/review proposal|human review candidate|cutoff proposal/.test(normalized)) return 'review_proposal';
  if (/block|fail|cannot|needs attention/.test(normalized)) return 'blocker';
  if (/acknowledg|received/.test(normalized)) return 'acknowledgement';
  if (event.kind === 'artifact') return /evidence|test|report/.test(normalized) ? 'evidence' : 'handoff';
  if (event.kind === 'review') return /finding|defect|issue/.test(normalized) ? 'finding' : /approv|reject|decid/.test(normalized) ? 'decision' : 'review';
  if (event.kind === 'project') return /approv|reject|decid/.test(normalized) ? 'decision' : 'order';
  if (event.kind === 'deployment') return 'handoff';
  if (event.kind === 'system') return 'control';
  return /handoff|deliver|publish/.test(normalized) ? 'handoff' : 'status';
}

function interactionStatusFromText(text: string): AgentInteraction['status'] {
  const normalized = text.toLowerCase();
  if (/reject|declin/.test(normalized)) return 'rejected';
  if (/block|fail|cannot|needs attention|packaging check failed|packaging checks failed/.test(normalized)) return 'blocked';
  if (/start|working|running|in progress/.test(normalized)) return 'in_progress';
  if (/acknowledge|accepted|received/.test(normalized)) return 'acknowledged';
  if (/pending|queued|waiting/.test(normalized)) return 'pending';
  return 'completed';
}

function eventTargets(event: ProjectEvent, from: InteractionParty, kind: AgentInteraction['kind'], text: string): AgentInteraction['to'] {
  if (isAgentRole(from)) {
    const explicitlyNamed = agentRoleDefinitions
      .filter((definition) => definition.role !== from && containsRoleName(text, definition))
      .map((definition) => definition.role);
    if (explicitlyNamed.length > 0) return uniqueParties(explicitlyNamed);

    const related = agentRelationshipCatalog
      .filter((relationship) => relationship.from === from && (kind !== 'handoff' || relationship.kind === 'hands_off'))
      .map((relationship) => relationship.to);
    if (related.length > 0 && (event.kind === 'artifact' || event.kind === 'deployment')) return uniqueParties(related.slice(0, 3));
  }

  if (event.kind === 'project') return ['manager'];
  if (event.kind === 'deployment') return ['validation'];
  if (event.kind === 'review' && from !== 'gate') return ['gate'];
  return ['project'];
}

function containsRoleName(text: string, definition: AgentDefinition) {
  const normalized = text.toLowerCase();
  return normalized.includes(definition.role) || normalized.includes(definition.label.toLowerCase());
}

function connectedRelationships(role: AgentRole) {
  return agentRelationshipCatalog.filter((relationship) => relationship.from === role || relationship.to === role);
}

function buildBlockedFlow(agents: EffectiveAgent[]): FlowItem[] {
  const byRole = new Map(agents.map((agent) => [agent.definition.role, agent]));
  return agents.flatMap((agent) => {
    const unmet = agent.dependsOn.filter((role) => byRole.get(role)?.state !== 'completed_for_iteration');
    if (agent.state !== 'blocked' && (agent.state !== 'waiting_on_agent' || unmet.length === 0)) return [];
    if (unmet.length === 0) return [{ id: `blocked:${agent.definition.role}`, to: agent.definition.role, label: stateCopy[agent.state].label, detail: 'The latest status reports a blocker without a named upstream dependency.' }];
    return unmet.map((from) => ({
      id: `blocked:${from}:${agent.definition.role}`,
      from,
      to: agent.definition.role,
      label: `${roleLabel(agent.definition.role)} needs ${roleLabel(from)}`,
      detail: `${roleLabel(from)} must complete its declared handoff before this role can safely begin.`,
    }));
  });
}

function buildHandoffFlow(detail: ProjectDetail, agents: EffectiveAgent[], interactions: AgentInteraction[]): FlowItem[] {
  const byRole = new Map(agents.map((agent) => [agent.definition.role, agent]));
  const liveHandoffs = interactions.flatMap((interaction) => {
    if (interaction.kind !== 'handoff' || !isAgentRole(interaction.from) || !['pending', 'acknowledged', 'in_progress', 'completed'].includes(interaction.status)) return [];
    return interaction.to.filter(isAgentRole).map((to) => ({
      id: `interaction:${interaction.id}:${to}`,
      from: interaction.from as AgentRole,
      to,
      label: interaction.name,
      detail: interaction.summary,
    }));
  });
  if (liveHandoffs.length > 0) return liveHandoffs;

  return (detail.executionGraph?.edges ?? []).flatMap((edge) => {
    if (edge.kind !== 'blocks') return [];
    const from = byRole.get(edge.from);
    const to = byRole.get(edge.to);
    if (from?.state !== 'completed_for_iteration' || !to || !['ready', 'planning', 'working', 'communicating'].includes(to.state)) return [];
    return [{
      id: `edge:${edge.from}:${edge.to}`,
      from: edge.from,
      to: edge.to,
      label: `${roleLabel(edge.from)} opened ${roleLabel(edge.to)}`,
      detail: edge.artifacts.length > 0 ? `Available: ${edge.artifacts.join(', ')}` : `${from.artifactName} is available to the next role.`,
    }];
  });
}

function countStates(agents: EffectiveAgent[]) {
  return agents.reduce<Record<AgentExecutionState, number>>((counts, agent) => ({ ...counts, [agent.state]: counts[agent.state] + 1 }), {
    observing: 0,
    ready: 0,
    planning: 0,
    working: 0,
    reviewing: 0,
    communicating: 0,
    waiting_on_agent: 0,
    waiting_on_human: 0,
    monitoring: 0,
    blocked: 0,
    completed_for_iteration: 0,
  });
}

function isComputationallyActive(state: AgentExecutionState) {
  return state === 'planning' || state === 'working' || state === 'reviewing' || state === 'communicating';
}

function readinessStatusIcon(status: OrganismReadinessItemView['status']) {
  if (status === 'ready') return '✓';
  if (status === 'blocked') return '!';
  if (status === 'not_required') return '—';
  return '○';
}

function artifactTypeMatches(pattern: string, type: string) {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

function humanizeToken(value: string) {
  return value.replaceAll(/[_:.\-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function useElapsedTicker() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function interactionDimensions(interaction: AgentInteraction, artifacts: readonly ProjectArtifact[]): Exclude<ActivityDimensionFilter, 'all'>[] {
  const dimensions: Exclude<ActivityDimensionFilter, 'all'>[] = [...(interaction.dimensions ?? [])];
  const artifactIds = new Set((interaction.artifactRefs ?? []).map((reference) => reference.artifactId));
  const linkedArtifacts = artifactIds.size > 0 ? artifacts.filter((artifact) => artifactIds.has(artifact.id)) : [];
  if (artifactIds.size > 0) dimensions.push('artifact');
  if (interaction.kind === 'finding') dimensions.push('finding');
  if (interaction.from === 'human' || interaction.to.includes('human')) dimensions.push('human');
  if (linkedArtifacts.some((artifact) => Boolean(artifact.model) || (artifact.modelInvocations?.length ?? 0) > 0)) dimensions.push('model');
  if (linkedArtifacts.some((artifact) => Boolean(artifact.repositoryPath) || Boolean(artifact.repositoryUrl))) dimensions.push('repository');
  return [...new Set(dimensions)];
}

export function formatElapsed(value: string, now = Date.now()) {
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function involvesRole(interaction: AgentInteraction, role: AgentRole) {
  return interaction.from === role || interaction.to.includes(role);
}

function isAgentRole(party: InteractionParty): party is AgentRole {
  return agentRoleDefinitions.some((definition) => definition.role === party);
}

function uniqueParties(parties: InteractionParty[]): AgentInteraction['to'] {
  return [...new Set(parties)];
}

function uniqueRoles(roles: AgentRole[]): AgentRole[] {
  return [...new Set(roles)];
}

function roleLabel(role: AgentRole) {
  return agentRoleDefinitions.find((definition) => definition.role === role)?.label ?? role;
}

function partyLabel(party: InteractionParty) {
  if (isAgentRole(party)) return roleLabel(party);
  if (party === 'human') return 'Human';
  if (party === 'project') return 'Project organism';
  return 'System';
}

function roleList(roles: readonly AgentRole[], agentByRole: Map<AgentRole, EffectiveAgent>, empty: string) {
  if (roles.length === 0) return empty;
  return roles.map((role) => agentByRole.get(role)?.definition.label ?? roleLabel(role)).join(' · ');
}

function joinNames(names: string[]) {
  if (names.length < 2) return names[0] ?? 'The team';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
