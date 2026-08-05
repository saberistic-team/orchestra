# Agent organism

Orchestra models delivery as a living, scenario-shaped network rather than a one-way prompt chain.

## Durable topology

One control-plane workflow owns project lifecycle and graph state:

```text
project/{projectId}
```

Fourteen durable role actors live for the project lifetime:

```text
project/{projectId}/agent/manager
project/{projectId}/agent/requirements
project/{projectId}/agent/product
project/{projectId}/agent/ux
project/{projectId}/agent/architecture
project/{projectId}/agent/data
project/{projectId}/agent/security
project/{projectId}/agent/planner
project/{projectId}/agent/builder
project/{projectId}/agent/test
project/{projectId}/agent/reviewer
project/{projectId}/agent/gate
project/{projectId}/agent/deployment
project/{projectId}/agent/validation
```

Each actor has a deterministic mailbox, idempotency checks, graph-version checks, authority validation, scoped order capabilities, pause/resume/cancel transitions, status and capability views, interaction records, and a Continue-As-New threshold. For each bounded order, the actor interprets small model-proposed action batches through deterministic validation, Activity execution, observation, budget accounting, human waits, and completion checks. External work remains in Activities.

Temporal execution status and human-facing organizational state are separate. The UI and actor query share eleven organizational states: `observing`, `ready`, `planning`, `working`, `reviewing`, `communicating`, `waiting_on_agent`, `waiting_on_human`, `monitoring`, `blocked`, and `completed_for_iteration`. Returning to `monitoring` after a handoff keeps the role visibly present without implying another model call.

## Shared protocol

`packages/contracts/src/agent-organism.ts` is the system boundary for:

- addresses and identity;
- authority grants;
- versioned messages with correlation and reply metadata;
- orders, scope, criteria, dependencies, evidence obligations, and adaptive loop policy;
- structured plans, capability versions, action dependencies, observations, budgets, and terminal reasons;
- results, findings, decisions, questions, assumptions, and limitations;
- artifact and evidence provenance;
- graph mutations;
- feature, bug-fix, incident, and discovery activation scenarios.

The runtime rejects duplicate or conflicting idempotency keys, wrong recipients, wrong projects, stale or future graph versions, unsupported order types, unavailable activities, malformed or cyclic plans, unauthorized actions or targets, out-of-scope grants, unsafe mutations, exceeded budgets, and unsupported completion claims before work can advance.

## Stable graph, reactive activation, dynamic role execution

The project organism and a role actor solve different scheduling problems. The topology and authority relationships stay versioned and reviewable, while the project workflow may reactivate a bounded subset of that topology:

- the first execution round schedules every mandatory iteration role through dependency-ready waves;
- a later round seeds reactivation from roles whose ledger position is not ready or from targeted human feedback, expands that set through transitive downstream dependencies, and always re-evaluates Gate;
- broad human direction or an empty seed falls back to the full mandatory graph; Deployment and Validation still require separate release authority;
- a role actor owns the deterministic interpreter for one assigned order;
- the role's model proposes what bounded actions would be useful next;
- the actor validates those actions against its capability registry, authority, scope, human decisions, and remaining limits;
- Activities perform permitted side effects and return recorded observations;
- deterministic completion checks, not the model, authorize the final handoff.

Reactive activation does not let a model invent graph edges, wake another role, or widen authority. Only the project workflow derives the later-round role set from durable evidence and human direction; each activated role still receives an independently bounded order.

Safe independent read activities may run concurrently. Mutations are serialized unless their registered contracts prove independent targets. Invalid plans execute nothing and enter a bounded repair path. Repeated-action and no-progress checks, token and cost ceilings, wall-clock limits, maximum planning rounds, and maximum repair attempts prevent an actor from looping forever.

An order ends as `completed`, `waiting_for_human`, `blocked`, or `budget_exhausted`. A structured human question is durable project context: after it is answered, that decision is supplied to every subsequent planning, assessment, repair, review, and completion call. “Let the agent decide” delegates only that named decision within the existing grant.

Model planning and assessment remain child workflows, so their recorded results are replayed instead of regenerated. Activity operation keys make retries idempotent, while the audit record connects plans, actions, observations, artifacts, model usage, human decisions, verification evidence, and the final terminal reason.

See [dynamic agent execution](DYNAMIC_AGENT_EXECUTION.md) for the normative interpreter, validation, replay, budget, audit, and completion rules.

## Live organization view

The project screen renders the entire persistent organization as a selectable graph. It separates three related truths:

1. **Nodes** show each role's current organizational state, precise activity, time in state, model, completed usage, mailbox pressure, blockers, human attention, and latest evidence.
2. **Edges** show required handoffs, supervision, and current or historical typed message flow. Selecting an edge opens its correlated conversation without hiding the other agents.
3. **Readiness** explains the Manager recommendation and the separate mandatory Gate result, including objective status, preview revision, required artifacts, tests, findings, and pending human decisions.

Selecting an agent opens a spotlight panel while the graph remains visible. The panel explains responsibility, activity, owned decisions and artifacts, boundaries, prerequisites, collaborators, latest exchanges, usage, questions, and human comments. A filterable activity stream and correlation threads expose orders, requests, questions, answers, findings, decisions, handoffs, evidence, reviews, acknowledgements, blockers, revision requests, and review proposals.

Animation is driven only by recorded live interactions or runtime state. Monitoring roles are muted, blockers and human waits carry text and icons in addition to color, and reduced-motion users receive static emphasis instead of travel or pulse effects.

## Durable organism ledger

Migration `0009_living_organism_ledger` adds the canonical records needed to stop treating English event prose as the long-term source of truth: agents, runtime-state history, goals, plans, actions, threads, messages and per-recipient delivery, obligations, artifact versions, findings, decisions, feedback, model invocations, repository operations, and review proposals. Correlation, causation, idempotency, response-depth, revision-binding, and current-state indexes are part of the storage contract. The existing append-only project event log remains the compatibility event source while typed ledger records become the forward projection path.

Earlier project histories remain readable through an adapter over their durable project events and artifacts. New actor queries provide live state and activity directly; the typed ledger is the forward path for message delivery, replay, topic threads, and low-latency fan-out.

## Manager cutoff and Gate

Manager and Gate remain deliberately separate. Gate evaluates mandatory evidence for the frozen candidate revision and records its own deterministic Gate rationale; it cannot be overridden silently. Manager then derives a separate rationale and recommendation from the canonical ledger's outcomes, findings, obligations, pending decisions, and active mutations. The resulting iteration-review proposal preserves both rationales, known limitations, and a budget snapshot, and explains why the Manager recommendation is `continue_iteration`, `request_human_decision`, or `send_for_human_review`.

## Evidence boundary

Builder descriptions are submissions, not proof. Once the candidate revision is resolved, Test, Reviewer, and Gate all receive that same immutable preview revision. Their assurance artifacts are written only to the organism ledger with that `sourceRevision`; they are not committed onto the candidate branch they assess. Orchestra resolves the candidate again before opening human review and blocks if its revision changed. Test remains independent of Builder, Reviewer cannot change the candidate, Gate treats missing or stale proof as missing, Deployment can act only on an authorized immutable artifact, and Validation cannot infer business success from technical conformance.

Deployment and Validation are registered for every project but remain dormant in the current default iteration. The repository does not claim a rollout, metric observation, or real-world outcome until a permission-bounded external adapter supplies that evidence.
