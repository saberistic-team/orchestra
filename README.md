# Orchestra

Orchestra is a source-available "software shop as a service": a guided interface turns a person's intent into a reviewed, testable software project while specialized agents work behind the scenes.

## First product slice

1. A user describes the product, audience, and desired outcome.
2. The API validates the brief and starts a Temporal workflow; it never writes application state directly.
3. A worker activity stores the brief, then a durable project workflow plans the work and pauses at human approval gates.
4. Agents work in isolated Git branches and propose changes through Forgejo pull requests.
5. The user can answer agent questions, comment on roles and artifacts, try the deployed preview, inspect recorded journeys, and approve or request changes.
6. Approval merges the reviewed pull request into `main`; a change request keeps the same issue, branch, and pull request open for revision.

## Architecture

- `apps/web`: installable React PWA with offline app-shell support and locally saved drafts
- `apps/api`: NestJS/Fastify control-plane API and Temporal client gateway
- `apps/worker`: one project-organism workflow, 14 long-lived role actors with durable mailboxes, dedicated queues, and deterministic interpreters for bounded model-planned actions, plus separately routed persistence and Forgejo activities
- `apps/model-worker`: purpose-specific model-interaction children for planning/repair and artifact authoring/review/revision, with reserved assessment purposes; local Ollama uses a singleton serialized inference lane, OpenRouter may run many calls in parallel (`MODEL_PROVIDER`)
- `apps/preview-manager`: exact-revision local Docker builds and short-lived, isolated review deployments
- `apps/validation-worker`: isolated Playwright worker that records real configured previews
- `packages/contracts`: shared Zod contracts and TypeScript types
- `packages/database`: Drizzle schema, migrations, and worker-only persistence
- PostgreSQL: projects, intentions, decisions, runs, and audit history
- Redis: short-lived UI state, rate limits, and event fan-out
- Temporal: durable orchestration, retries, timeouts, and approval waits
- Forgejo: automatically initialized Git hosting for issues, agent-labelled work, commits, pull requests, projects, releases, generic review packages, and iteration wiki pages

All application API calls cross the Temporal boundary. Commands execute workflows, reads use workflow queries, and only worker activities may access durable stores. The local `/health` probe is the sole infrastructure-only exception.

Each project runs an artifact-driven, versioned agent organism. Requirements and Product, UX and Architecture, Data and Security, and Test and Reviewer form parallel-ready branches; Planner and Gate enforce the joins. This outer delivery graph is deterministic. Inside each bounded role order, the first dynamic adapter lets the model choose bounded artifact generation, review, or revision actions while the role workflow validates authority and budgets, records observations, and deterministically verifies completion. The shared registry and scheduler are ready for later repository and delivery capability adapters. Deployment and Validation remain visible and monitoring until a release is explicitly authorized. The PWA renders all persistent actors as a live graph, keeps that context visible behind an agent spotlight, groups typed exchanges by topic, and explains the Manager recommendation separately from mandatory Gate readiness. See [dynamic agent execution](docs/DYNAMIC_AGENT_EXECUTION.md), [the delivery graph](docs/DELIVERY_GRAPH.md), [agent organism](docs/AGENT_ORGANISM.md), and [worker topology](docs/WORKER_TOPOLOGY.md) for the complete relationship, authority, and execution model.

The human review workspace is durable rather than form-only. Agent questions carry understandable options and may explicitly allow “let the agent decide.” Human comments, overall direction, artifact feedback, and one feedback value for every agent are stored with the exact iteration review and supplied to subsequent or retried agent orders. Empty per-agent feedback is preserved as an intentional reviewed value.

## Local development

Requirements: Node.js 26+, pnpm 11+, and Docker.

```sh
cp .env.example .env
touch .env.docker   # optional Docker-only overrides (highest precedence)
pnpm stack:up
```

Compose loads env files in this order (later wins): `.env.example` → `.env` → `.env.docker`. Use `.env` for general local secrets and `.env.docker` for Compose-only overrides (for example `MODEL_PROVIDER=openrouter`).

PWA: `http://localhost:8088`
API health: `http://localhost:3000/health`
Temporal UI: `http://localhost:8080`
Forgejo: `http://localhost:3001`

Forgejo requires no onboarding step. Compose locks installation, disables public registration, and idempotently creates the local `orchestra-agent` automation account before delivery workers start. Change `FORGEJO_ADMIN_PASSWORD` outside local development.

The Compose stack is intentionally localhost-only and the API does not allow cross-origin browser calls. This first slice has no multi-user identity system; place both the web app and API behind authenticated access control before exposing them beyond one trusted machine.

Runnable previews are built locally by default. Builder must commit a root `Dockerfile` that exposes `8080` and implements an active `GET /health` Docker health check. The preview manager resolves the iteration branch to an immutable Forgejo revision, removes the non-runtime `artifacts/` evidence tree from the build context, builds the image, starts it on a private no-egress network, and waits for Docker health. A separate credential-free gateway gives the browser a deterministic `*.localhost:3003` address without publishing the generated container itself. The validation worker independently checks the exact internal `GET /health` endpoint before Test or human approval can continue. The review checkpoint and human attestation are bound to the revision, immutable image digest, and preview expiry; a changed pull-request head or rebuilt image cannot reuse the approval.

Generated previews run non-root on a separate internal network with no host mounts or control-plane credentials, a read-only root filesystem, dropped Linux capabilities, `no-new-privileges`, and CPU, memory, PID, log, timeout, and expiry limits. The preview-manager alone mounts the Docker socket. Docker socket access is effectively host-level authority, so this built-in path is for a trusted local development machine; use a dedicated rootless daemon or disposable VM before treating model-generated Dockerfiles as hostile. See [local Docker previews](docs/LOCAL_DOCKER_PREVIEWS.md). `FORGEJO_LIFECYCLE_PERMISSIONS` controls which post-approval repository side effects are enabled.

Before starting agent reasoning, set `MODEL_PROVIDER` to `ollama` (default) or `openrouter`; `MODEL_PROVIDER_<ROLE>` may override individual roles. For Ollama, make sure it is running on the host and that the `OLLAMA_MODEL_*` models in `.env.example` are installed; its worker and singleton FIFO lane both enforce one active local call. For OpenRouter, set `OPENROUTER_API_KEY`, explicitly acknowledge remote prompt processing with `OPENROUTER_ALLOW_REMOTE_DATA=true`, and optionally configure `OPENROUTER_ALLOWED_MODELS`, role models, and starting `OPENROUTER_MAX_TOKENS` / `OPENROUTER_REASONING_MAX_TOKENS`. Hosted budgets are clamped per model family and can bump on length cutoffs or incomplete JSON up to `OPENROUTER_*_HARD_LIMIT` / `OPENROUTER_BUDGET_BUMPS`. With `OPENROUTER_BUDGET_LEARNING=true` (default), the openrouter-worker stores successful prompt/completion/reasoning usage as Redis EWMA priors per role, purpose, and model, then raises later starting budgets with `OPENROUTER_BUDGET_HEADROOM`; Redis failures fall back to heuristic starts without failing inference. Successful-but-empty or malformed hosted responses are retried within the configured bounded attempt count. Routing, local inference, and hosted inference use separate workers and queues; only the hosted inference worker receives the API key. Each planning, repair, authoring, review, or revision request runs through a role-specific model-interaction child workflow while the role workflow remains the durable control plane. Local model downloads are never triggered automatically.

## Verification

The same commands run locally and in GitHub Actions:

```sh
pnpm check:quick       # Temporal boundary, build, types, unit tests, dependency audit
pnpm test              # unit, integration, API e2e, and Playwright flow scenarios
pnpm test:flows        # black-box product journeys through the current API
pnpm security          # immutable pins, pnpm audit, Trivy, and Prowler IaC
pnpm check             # all of the above
```

Integration and API e2e tests use ephemeral PostgreSQL containers and therefore require Docker. Playwright exercises both API journeys and the human-facing PWA on desktop and mobile viewports. Trivy checks dependencies, secrets, every component Dockerfile, and Compose configuration. Prowler checks the local infrastructure-as-code without cloud credentials.

Every Compose component owns its Dockerfile: the six applications live beside their source under `apps/*`, while PostgreSQL, Redis, Temporal, Temporal UI, Forgejo, and its one-shot bootstrap live under `infra/*`. Compose builds all twelve images locally from immutable upstream image pins.

For application development with infrastructure in Docker and API/worker processes on the host:

```sh
docker compose up -d postgres redis temporal temporal-ui forgejo forgejo-bootstrap
pnpm install
pnpm dev
```

The complete local preview path is a Compose feature because the validation worker must reach the isolated runtime network. Use `docker compose up --build -d` when exercising the deploy-before-approval flow; host-only workers need an explicitly configured external preview adapter.

Create a project:

```sh
curl -X POST http://localhost:3000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Neighborhood helper","intent":"Help neighbors request and offer small favors","audience":"People in one neighborhood","success":"A resident can post a request and another can accept it"}'
```

## Product principles

- Human intent is the source of truth; generated code is a disposable implementation.
- Application commands and reads are mediated by Temporal workflows; the API does not access the database directly.
- Every meaningful action is attributable, reviewable, and reversible.
- Agents receive narrowly scoped capabilities and never share a working tree.
- Approval gates are based on impact: product decisions, spending, credentials, production changes, and destructive actions require a human.
- The UI speaks in outcomes and tradeoffs, while technical detail remains available on demand.

## License

Copyright © 2026 AmirSaber Sharifi, Saberistic LLC.

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial use is permitted under that license. Commercial use requires a separate paid license — contact [inbox@saberistic.com](mailto:inbox@saberistic.com).
