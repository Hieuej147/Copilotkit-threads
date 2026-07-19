# Self-hosted CopilotKit Thread Platform

Reusable thread infrastructure for CopilotKit + AG-UI agents. The platform owns
thread metadata, run/event history, realtime sidebar events, async titles and
concurrency control without CopilotKit Cloud.

## Repository layout

```text
apps/runtime/                 Thread API + CopilotKit runtime gateway
packages/contracts/           Runtime-validated public contracts
packages/thread-client/       Framework-neutral TypeScript SDK
packages/thread-react/        useThreadManager React hook
examples/langgraph-agent/     LangGraph tools + HITL example only
examples/nextjs-copilotkit/   CopilotKit UI example only
infra/postgres/               Core database migrations
infra/k8s/charts/             Production Helm chart
```

PostgreSQL is the durable source of truth. Redis contains only distributed
locks, cancellation signals and realtime notifications; flushing Redis does not
delete thread history.

## Run the complete example

```bash
cp .env.example .env
# Set OPENAI_API_KEY and optionally TITLE_API_KEY in .env
docker compose -f docker-compose.yml -f docker-compose.example.yml up --build
```

Open `http://localhost:3000`. Use `WEB_PORT=3001` if port 3000 is occupied.

Core only, with an agent running elsewhere:

```bash
AGENT_URL=http://host.docker.internal:8000/agent \
docker compose up --build
```

## Verification

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
docker compose -f docker-compose.yml -f docker-compose.example.yml config --quiet
make helm-lint
```

Start with [Thread Platform Handbook](docs/THREAD_SERVICE_GUIDE.md) when moving
this service into another project. The HTTP contract is in
[OpenAPI](docs/openapi.yaml).
