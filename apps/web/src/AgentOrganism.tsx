import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  agentRelationshipCatalog,
  agentRoleDefinitions,
  deliveryAgentGraph,
  type AgentExecutionNode,
  type AgentExecutionState,
  type AgentInteraction,
  type AgentRelationship,
  type AgentRole,
  type ProjectDetail,
  type ProjectArtifact,
  type ProjectEvent,
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

type OrganismView = 'now' | 'relationships';
type DetailHitlTab = 'open' | 'answered' | 'comments';
type AgentDefinition = (typeof agentRoleDefinitions)[number];
type AgentPhase = AgentDefinition['phase'];
type Relationship = AgentRelationship;
type InteractionParty = AgentInteraction['from'];
type AnswerState = { state: 'sending' | 'answered' | 'error'; label?: string };

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

const phaseOrder = ['shape', 'design', 'plan', 'build', 'assure'] as const satisfies readonly AgentPhase[];

const phaseCopy: Record<AgentPhase, { index: string; label: string; description: string }> = {
  shape: { index: '01', label: 'Shape', description: 'Intent, scope and value' },
  design: { index: '02', label: 'Design', description: 'Experience, system and controls' },
  plan: { index: '03', label: 'Plan', description: 'Bounded work and evidence' },
  build: { index: '04', label: 'Build', description: 'Implementation and proof' },
  assure: { index: '05', label: 'Assure', description: 'Review, release and outcome' },
};

const stateCopy: Record<AgentExecutionState, { icon: string; label: string; shortLabel: string }> = {
  dormant: { icon: '‖', label: 'Dormant until authorized', shortLabel: 'Dormant' },
  waiting: { icon: '○', label: 'Waiting for inputs', shortLabel: 'Waiting' },
  ready: { icon: '◇', label: 'Ready to begin', shortLabel: 'Ready' },
  active: { icon: '↻', label: 'Working now', shortLabel: 'Working' },
  completed: { icon: '✓', label: 'Handoff complete', shortLabel: 'Handed off' },
  blocked: { icon: '!', label: 'Blocked — needs attention', shortLabel: 'Blocked' },
};

const interactionKindCopy: Record<AgentInteraction['kind'], string> = {
  order: 'Order',
  status: 'Status update',
  handoff: 'Handoff',
  evidence: 'Evidence',
  finding: 'Finding',
  decision: 'Decision',
  control: 'Control',
};

const interactionStatusCopy: Record<AgentInteraction['status'], { icon: string; label: string }> = {
  pending: { icon: '○', label: 'Pending' },
  acknowledged: { icon: '✓', label: 'Acknowledged' },
  in_progress: { icon: '↻', label: 'In progress' },
  completed: { icon: '✓', label: 'Completed' },
  blocked: { icon: '!', label: 'Blocked' },
  rejected: { icon: '×', label: 'Rejected' },
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
  const [view, setView] = useState<OrganismView>('now');
  const [internalSelectedRole, setInternalSelectedRole] = useState<AgentRole>('manager');
  const selectedRole = selectedRoleProp ?? internalSelectedRole;
  const selectRole = (role: AgentRole) => {
    setInternalSelectedRole(role);
    onSelectedRoleChange?.(role);
  };
  const id = useId();
  const agents = useMemo(() => buildEffectiveAgents(detail), [detail]);
  const interactions = useMemo(() => buildInteractionLedger(detail), [detail]);
  const questions = useMemo(() => normalizeQuestions(detail), [detail]);
  const needingHuman = useMemo(() => rolesNeedingHuman(questions), [questions]);
  const agentByRole = useMemo(() => new Map(agents.map((agent) => [agent.definition.role, agent])), [agents]);
  const selectedAgent = agentByRole.get(selectedRole) ?? agents[0];

  if (!selectedAgent) return null;

  const counts = countStates(agents);
  const activeAgents = agents.filter((agent) => agent.state === 'active');
  const selectedRelationships = connectedRelationships(selectedRole);
  const selectedInteractions = interactions.filter((interaction) => involvesRole(interaction, selectedRole));
  const blockedFlow = buildBlockedFlow(agents);
  const handoffFlow = buildHandoffFlow(detail, agents, interactions);
  const focus = activeAgents.length > 0
    ? `${joinNames(activeAgents.map((agent) => agent.definition.label))} ${activeAgents.length === 1 ? 'is' : 'are'} working now.`
    : counts.ready > 0
      ? `${counts.ready} agent${counts.ready === 1 ? ' is' : 's are'} ready for the next safe move.`
      : counts.completed === agents.length
        ? 'This iteration has completed its agent handoffs.'
        : 'The organism is waiting for its next safe handoff.';

  return <section className="organism" aria-labelledby={`${id}-title`}>
    <div className="organism__heading">
      <div className="organism__intro">
        <div className="organism__pulse" aria-hidden="true"><span>{activeAgents[0]?.definition.icon ?? '✦'}</span></div>
        <div>
          <p className="organism__eyebrow">Living delivery organism · iteration {detail.project.currentIteration}</p>
          <h2 id={`${id}-title`}>{focus}</h2>
          <p>Every role has a durable responsibility. Work moves through explicit orders, evidence, findings and handoffs. Select an agent to answer questions or leave comments.</p>
        </div>
      </div>
      <div className="organism__stats" aria-label="Agent status summary">
        <span><strong>{counts.active}</strong> working</span>
        <span><strong>{counts.ready}</strong> ready</span>
        <span><strong>{counts.blocked}</strong> blocked</span>
        <span><strong>{needingHuman.size}</strong> need you</span>
        <span><strong>{counts.completed}/{agents.length}</strong> handed off</span>
      </div>
    </div>

    <div className="organism__toolbar">
      <div className="organism__tabs" role="tablist" aria-label="Agent organism views">
        <button id={`${id}-now-tab`} role="tab" aria-selected={view === 'now'} aria-controls={`${id}-now-panel`} onClick={() => setView('now')}>
          <span aria-hidden="true">◉</span> Now
        </button>
        <button id={`${id}-relationships-tab`} role="tab" aria-selected={view === 'relationships'} aria-controls={`${id}-relationships-panel`} onClick={() => setView('relationships')}>
          <span aria-hidden="true">↔</span> Relationships
        </button>
      </div>
      <p><span aria-hidden="true">●</span> Select any agent for questions, answers, and comments.</p>
    </div>

    <div className="organism__layout">
      <div className="organism__workspace">
        {view === 'now'
          ? <div id={`${id}-now-panel`} role="tabpanel" aria-labelledby={`${id}-now-tab`}>
              <NowView idPrefix={id} agents={agents} selectedRole={selectedRole} selectRole={selectRole} needingHuman={needingHuman} blockedFlow={blockedFlow} handoffFlow={handoffFlow} />
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
      />
    </div>

    <InteractionLedger
      idPrefix={id}
      interactions={view === 'relationships' ? selectedInteractions : interactions}
      selectedAgent={view === 'relationships' ? selectedAgent : undefined}
    />
  </section>;
}

function NowView({
  idPrefix,
  agents,
  selectedRole,
  selectRole,
  needingHuman,
  blockedFlow,
  handoffFlow,
}: {
  idPrefix: string;
  agents: EffectiveAgent[];
  selectedRole: AgentRole;
  selectRole: (role: AgentRole) => void;
  needingHuman: ReadonlySet<AgentRole>;
  blockedFlow: FlowItem[];
  handoffFlow: FlowItem[];
}) {
  return <>
    <div className="organism__legend" aria-label="Agent status legend">
      {(Object.entries(stateCopy) as [AgentExecutionState, (typeof stateCopy)[AgentExecutionState]][]).map(([state, copy]) =>
        <span className={`organism__legend-item organism__legend-item--${state}`} key={state}><i aria-hidden="true">{copy.icon}</i>{copy.label}</span>)}
      <span className="organism__legend-item organism__legend-item--needs-human"><i aria-hidden="true">?</i>Needs human answer</span>
    </div>

    <div className="organism__lanes" aria-label="All agents by delivery phase">
      {phaseOrder.map((phase) => {
        const phaseAgents = agents.filter((agent) => agent.definition.phase === phase);
        if (phaseAgents.length === 0) return null;
        const copy = phaseCopy[phase];
        return <section className="organism__lane" key={phase} aria-labelledby={`${idPrefix}-phase-${phase}`}>
          <div className="organism__lane-label">
            <span>{copy.index}</span>
            <div><h3 id={`${idPrefix}-phase-${phase}`}>{copy.label}</h3><p>{copy.description}</p></div>
          </div>
          <div className="organism__agent-grid">
            {phaseAgents.map((agent) => <AgentCard key={agent.definition.role} agent={agent} selected={selectedRole === agent.definition.role} needsHuman={needingHuman.has(agent.definition.role)} onSelect={selectRole} />)}
          </div>
        </section>;
      })}
    </div>

    <div className="organism__flow" aria-label="Current blocking and handoff flow">
      <FlowColumn title="Waiting on" icon="!" kind="blocked" items={blockedFlow} empty="No unresolved dependency is blocking the current move." onSelect={selectRole} />
      <FlowColumn title="Moving now" icon="→" kind="handoff" items={handoffFlow} empty="No handoff is moving at this moment." onSelect={selectRole} />
    </div>
  </>;
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
}: {
  agent: EffectiveAgent;
  relationships: readonly Relationship[];
  interactions: AgentInteraction[];
  agentByRole: Map<AgentRole, EffectiveAgent>;
  detail: ProjectDetail;
  questions: readonly AgentQuestionView[];
  onReload?: () => Promise<void>;
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

    <ModelUsageSummary usage={modelUsage} />

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

export interface AgentModelUsageSummary {
  requests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
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
      summary.requests += 1;
      summary.promptTokens += promptTokens;
      summary.completionTokens += completionTokens;
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

function ModelUsageSummary({ usage }: { usage: AgentModelUsageSummary }) {
  return <section className="organism-detail__usage" aria-label="Recorded model usage">
    <div className="organism-detail__usage-heading"><h4>Model usage</h4><span>Recorded so far</span></div>
    {usage.requests > 0 ? <>
      <div className="organism-detail__usage-grid">
        <article><span>Tokens</span><strong>{usage.totalTokens.toLocaleString()}</strong><small>{usage.promptTokens.toLocaleString()} input · {usage.completionTokens.toLocaleString()} output</small></article>
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

function InteractionLedger({ idPrefix, interactions, selectedAgent }: { idPrefix: string; interactions: AgentInteraction[]; selectedAgent?: EffectiveAgent }) {
  return <section className="organism-ledger" aria-labelledby={`${idPrefix}-ledger-title`}>
    <div className="organism-ledger__heading">
      <div><p className="organism__eyebrow">Decision &amp; evidence ledger</p><h3 id={`${idPrefix}-ledger-title`}>{selectedAgent ? `${selectedAgent.definition.label} exchanges` : 'Recent agent exchanges'}</h3></div>
      <p>{interactions.length} recorded exchange{interactions.length === 1 ? '' : 's'} · newest first</p>
    </div>
    {interactions.length > 0
      ? <ol aria-live="polite">{interactions.slice(0, 10).map((interaction) => {
          const status = interactionStatusCopy[interaction.status];
          return <li className={`organism-ledger__row organism-ledger__row--${interaction.status}`} key={interaction.id}>
            <span className="organism-ledger__status"><i aria-hidden="true">{status.icon}</i><b>{status.label}</b></span>
            <div className="organism-ledger__route"><strong>{partyLabel(interaction.from)}</strong><span aria-hidden="true">→</span><strong>{interaction.to.map(partyLabel).join(', ')}</strong></div>
            <div className="organism-ledger__message"><span>{interactionKindCopy[interaction.kind]}</span><strong>{interaction.name}</strong><p>{interaction.summary}</p></div>
            <time dateTime={interaction.createdAt}>{formatTimestamp(interaction.createdAt)}</time>
          </li>;
        })}</ol>
      : <div className="organism-ledger__empty"><span aria-hidden="true">◎</span><div><strong>No exchanges recorded yet</strong><p>Orders, handoffs, evidence, findings and decisions will appear here as the organism works.</p></div></div>}
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

  for (const event of [...detail.events].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
    if (event.agentRole && event.iterationNumber === detail.project.currentIteration) latestEvents.set(event.agentRole, event);
  }

  return agentRoleDefinitions.map((definition) => {
    const node = graphNodeByRole.get(definition.role);
    const deliveryNode = deliveryNodeByRole.get(definition.role);
    const latestEvent = latestEvents.get(definition.role);
    const releaseOnly = deliveryNode && 'activation' in deliveryNode && deliveryNode.activation === 'authorized_release';
    const state = node?.state
      ?? (releaseOnly ? 'dormant' : inferAgentState(latestEvent, completedRoles.has(definition.role)));
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

function inferAgentState(event: ProjectEvent | undefined, hasArtifact: boolean): AgentExecutionState {
  if (hasArtifact) return 'completed';
  const text = `${event?.title ?? ''} ${event?.description ?? ''}`.toLowerCase();
  if (/block|fail|cannot|needs attention/.test(text)) return 'blocked';
  if (/start|working|running|progress|active/.test(text)) return 'active';
  if (/ready|queued|accepted|acknowledged/.test(text)) return 'ready';
  return 'waiting';
}

function buildInteractionLedger(detail: ProjectDetail): AgentInteraction[] {
  const graph = detail.executionGraph as (typeof detail.executionGraph & { interactions?: AgentInteraction[] }) | undefined;
  const recorded = graph?.interactions ?? [];
  const interactions = recorded.length > 0 ? [...recorded] : detail.events.map((event) => interactionFromEvent(event, detail));
  return interactions.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
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
    live: status === 'pending' || status === 'in_progress' || status === 'blocked',
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
  if (event.kind === 'artifact') return /evidence|test|report/.test(normalized) ? 'evidence' : 'handoff';
  if (event.kind === 'review') return /finding|change|defect|issue/.test(normalized) ? 'finding' : 'decision';
  if (event.kind === 'project') return /approv|reject|decid/.test(normalized) ? 'decision' : 'order';
  if (event.kind === 'deployment') return 'handoff';
  if (event.kind === 'system') return 'control';
  return /handoff|deliver|publish/.test(normalized) ? 'handoff' : 'status';
}

function interactionStatusFromText(text: string): AgentInteraction['status'] {
  const normalized = text.toLowerCase();
  if (/reject|declin/.test(normalized)) return 'rejected';
  if (/block|fail|cannot|needs attention/.test(normalized)) return 'blocked';
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
    const unmet = agent.dependsOn.filter((role) => byRole.get(role)?.state !== 'completed');
    if (agent.state !== 'blocked' && (agent.state !== 'waiting' || unmet.length === 0)) return [];
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
    if (from?.state !== 'completed' || (to?.state !== 'ready' && to?.state !== 'active')) return [];
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
    dormant: 0,
    waiting: 0,
    ready: 0,
    active: 0,
    completed: 0,
    blocked: 0,
  });
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
