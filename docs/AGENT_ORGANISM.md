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

Each actor has a deterministic mailbox, idempotency checks, graph-version checks, authority validation, scoped order capabilities, pause/resume/cancel transitions, status and capability views, interaction records, and a Continue-As-New threshold. External work remains in Activities.

## Shared protocol

`packages/contracts/src/agent-organism.ts` is the system boundary for:

- addresses and identity;
- authority grants;
- versioned messages with correlation and reply metadata;
- orders, scope, criteria, dependencies, evidence obligations, and adaptive loop policy;
- results, findings, decisions, questions, assumptions, and limitations;
- artifact and evidence provenance;
- graph mutations;
- feature, bug-fix, incident, and discovery activation scenarios.

The runtime rejects duplicate or conflicting idempotency keys, wrong recipients, wrong projects, stale or future graph versions, unsupported order types, unauthorized actions or targets, and out-of-scope grants before work can advance.

## Relationship versus interaction

The UI deliberately separates two different truths:

1. **Now** shows the current dependency-ready execution state, active handoffs, and blockers.
2. **Relationships** shows the selected role's one-hop permitted communication network, including feedback and remediation paths that may not be active now.

Selecting an agent explains its responsibility, owned decisions and artifacts, explicit prohibitions, prerequisites, supervisors, collaborators, and latest exchange. The interaction ledger translates project protocol and audit events into plain-language `from → to` records with kind and status.

This avoids rendering the complete relationship catalog as an unreadable hairball while keeping every relationship available for inspection.

## Evidence boundary

Builder descriptions are submissions, not proof. Test remains independent of Builder, Reviewer cannot change the candidate, Gate treats missing proof as missing, Deployment can act only on an authorized immutable artifact, and Validation cannot infer business success from technical conformance.

Deployment and Validation are registered for every project but remain dormant in the current default iteration. The repository does not claim a rollout, metric observation, or real-world outcome until a permission-bounded external adapter supplies that evidence.

