# Self-hosted CopilotKit Thread Platform

Production-oriented thread infrastructure for CopilotKit and AG-UI agents,
designed primarily for LangGraph and LangChain applications. It owns thread
metadata, durable run history, realtime sidebar updates, async titles and
per-thread concurrency without CopilotKit Cloud.

## Agent compatibility

LangGraph is the reference integration: expose the compiled graph as an AG-UI
HTTP endpoint and use the same `threadId` for its PostgreSQL checkpointer.
LangChain agents that do not use LangGraph must first be wrapped in an AG-UI
server. Other agent frameworks can also work when they implement the
[Agent Contract](docs/AGENT_CONTRACT.md); the Thread API itself does not import
or execute LangChain or LangGraph code.

Version 1 uses Thread API `/v3`, a PostgreSQL-backed dynamic agent registry,
canonical message parts and durable event batching. Thread API v2 is removed;
see
[`docs/V3_MIGRATION.md`](docs/V3_MIGRATION.md).

> [!WARNING]
> This is an AI-assisted, vibe-coded reference implementation, not a production
> certification. Before handling real user data, review the source and SQL,
> threat-model the deployment, pin artifacts, run integration/load tests, and
> arrange independent security and recovery audits for your environment.

## Try the full demo

Prerequisites: Docker Compose and an OpenAI API key.

```bash
git clone https://github.com/Hieuej147/Copilotkit-threads.git
cd Copilotkit-threads
cp .env.example .env
# Set OPENAI_API_KEY in .env
make demo-up
```

Open `http://localhost:3000`. `make demo-up` pulls the versioned Thread Runtime
from GHCR and builds only the example agent and UI. Use `WEB_PORT=3001` in
`.env` when port 3000 is occupied.

The maintainer UI also includes a collapsible
[CopilotKit Hooks Compatibility Lab](examples/nextjs-copilotkit/README.md) that
tests React v2 agent, context, suggestion, tool-rendering and HITL hooks while
continuing to use the self-hosted `useThreadManager` instead of CopilotKit
Cloud threads.

Repository maintainers use `make dev-up` to build Runtime from the current
checkout instead of pulling the released image.

```bash
make demo-logs   # follow all logs
make demo-db     # open psql
make demo-down   # stop, retain PostgreSQL data
make demo-reset  # stop and delete local data
```

Maintainers testing unreleased Runtime source use `make dev-up` and
`make dev-logs` instead.

## Use it in another project

Do not copy `apps/runtime` into the product. Deploy the versioned Runtime image,
point it at the product's private AG-UI endpoint, then install only the UI SDK:

```bash
pnpm add @kiri_ikki/thread-react @copilotkit/react-core
```

Start with [Consumer Quickstart](docs/CONSUMER_QUICKSTART.md). The completely
isolated [consumer starter](examples/consumer-starter/README.md) demonstrates a
separate app that consumes npm and GHCR releases without workspace imports.

## Repository map

```text
apps/runtime/                   Thread API + CopilotKit Runtime gateway
packages/contracts/             Runtime-validated public types
packages/thread-client/         Framework-neutral TypeScript client
packages/thread-react/          useThreadManager React hook
packages/agent-check/           AG-UI conformance CLI
examples/langgraph-agent/       Maintainer LangGraph example
examples/nextjs-copilotkit/     Maintainer CopilotKit example
examples/consumer-starter/      Standalone consumer template
infra/postgres/                 Core-owned migrations
infra/k8s/charts/               Helm chart
```

PostgreSQL is the durable source of truth. Redis contains distributed locks,
cancellation signals and realtime wake-ups only; flushing Redis does not erase
thread history.

## Documentation

- [Consumer Quickstart](docs/CONSUMER_QUICKSTART.md): integrate a new product.
- [Agent Contract](docs/AGENT_CONTRACT.md): build and validate an AG-UI agent.
- [Thread Platform Handbook](docs/THREAD_SERVICE_GUIDE.md): architecture, DB,
  auth, operation, Kubernetes and troubleshooting.
- [OpenAPI](docs/openapi.yaml): Thread HTTP API contract.

## Maintainer checks

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  -f docker-compose.example.yml config --quiet
make helm-lint
```

Licensed under the [MIT License](LICENSE).
