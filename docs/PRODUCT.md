# Product definition

## Promise

Orchestra helps a person go from an incomplete idea to working, owned software without requiring them to understand repositories, branches, CI, deployment, or agent prompts.

## Core loop

`Express intent → clarify → build a thin slice → deploy a preview → inspect evidence → approve or request changes → merge`

The system should ask consequential questions with understandable choices and may offer to decide within an agent's declared authority. The human can comment on any role or artifact, leave overall direction, try the deployed candidate, inspect recorded journeys, and either approve or request another pass. It should show what changed, why it matters, what needs a decision, and what is safe to undo.

Every iteration review records a value for every agent, including an intentional empty value when the human has no role-specific note. Approval is not a UI-only state: the reviewed pull request must be confirmed merged into `main` before the project advances. Requesting changes preserves the current issue, branch, and pull request so the next pass remains incremental.

## Agent roles

The living project team contains Manager, Requirements, Product, UX, Architecture, Data, Security, Planner, Builder, Test, Reviewer, Gate, Deployment, and Validation. They are durable roles with different authority, evidence obligations, and prohibitions—not merely different prompts or necessarily different models.

The human-facing UI keeps the whole organization visible as a live graph. Agent nodes explain precise work and waiting states; message edges and topic threads show collaboration; a spotlight provides role detail without hiding the graph; and readiness separates the Manager's iteration-cutoff recommendation from mandatory Gate evidence. See [the agent organism](AGENT_ORGANISM.md) for the role and protocol model.

## Trust model

Each run records its input intention, plan version, model and tool identity, actions, artifacts, cost, approvals, and result. Credentials are leased just-in-time. Network and filesystem access are denied by default. Generated changes enter through pull requests and cannot self-approve.

## Deliberately outside the first milestone

- Fully autonomous production deployment
- Arbitrary user-supplied code execution without isolation
- Multiple Git providers
- A marketplace of agent personas
- Optimizing for maximum agent count
