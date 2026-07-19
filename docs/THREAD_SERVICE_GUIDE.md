# Thread Platform Handbook

This is the canonical guide for operating this repository and integrating it
with another product. The `examples/` directory is disposable reference code;
the reusable product is Runtime, PostgreSQL migrations, SDKs and Helm chart.

## 1. Architecture

```mermaid
flowchart LR
  UI[Product UI\nCopilotKit + useThreadManager] -->|/v2 threads + SSE| RT[Thread Runtime]
  UI -->|/api/copilotkit AG-UI| RT
  RT -->|AG-UI HTTP, private| AG[Project LangGraph agent]
  RT --> PG[(PostgreSQL)]
  RT --> RD[(Redis)]
  TW[Title worker] --> PG
  TW -->|OpenAI-compatible API| LLM[Title model]
  TW --> RD
  AG -->|LangGraph checkpoints| PG
```

One Runtime deployment serves one `AGENT_NAMESPACE` and configured `AGENT_ID`.
The UUID `threadId` is identical in the UI, CopilotKit Runtime, AG-UI request and
LangGraph `configurable.thread_id`.

Responsibilities:

| Component | Owns |
|---|---|
| Runtime | authentication context, thread API, CopilotKit endpoint, run persistence, AG-UI lifecycle normalization |
| PostgreSQL | threads, messages, runs, replay events, title jobs, LangGraph checkpoints |
| Redis | per-thread run lock, cancellation, short-lived run stream, SSE wake-up and rate-limit counters |
| Project agent | graph, prompts, business tools, interrupts and checkpoint state |
| Product UI | CopilotKit chat and product-specific thread presentation |

The title model never participates in the main agent stream. The first user
message creates exactly one PostgreSQL outbox job in the same transaction as run
creation. A separate worker claims jobs using `FOR UPDATE SKIP LOCKED`. Manual
rename closes that job, so later messages never regenerate the title.

## 2. Database ownership

Use one PostgreSQL server/database if desired, but keep ownership boundaries:

- `agent_core.*`: owned and migrated by Runtime from `infra/postgres/`.
- LangGraph checkpoint tables: owned by `langgraph-checkpoint-postgres`.
- Product tables: owned by Prisma, Drizzle or the product's migration tool.

Do not model or migrate `agent_core` or LangGraph tables in Prisma. Reference a
thread from product data with a scalar UUID and optional database foreign key:

```prisma
model SupportTicket {
  id            String  @id @default(uuid()) @db.Uuid
  agentThreadId String? @unique @map("agent_thread_id") @db.Uuid
}
```

For a shared database, add the foreign key in a product-owned SQL migration only
if both services share lifecycle and deployment ownership:

```sql
ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_ticket_thread_fk
  FOREIGN KEY (agent_thread_id)
  REFERENCES agent_core.agent_threads(id)
  ON DELETE SET NULL;
```

For microservices or separate databases, never use a cross-service foreign key.
Store the UUID plus tenant/user ownership, call the Thread API, and handle
`404 THREAD_NOT_FOUND` as a normal stale-reference case.

## 3. Integration options

### Option A: deploy as a separate service (recommended)

1. Build/publish `apps/runtime/Dockerfile`.
2. Apply the Helm chart or core Compose file.
3. Set `agent.url` to the project's private AG-UI LangGraph endpoint.
4. Expose `/api/copilotkit`, `/v2/threads` and `/v2/thread-events` through the
   product gateway.
5. Give the browser only the gateway URL, never PostgreSQL/Redis/agent URLs.

This keeps Prisma and product releases independent of thread infrastructure.

### Option B: consume workspace packages

Publish or copy these packages into the product monorepo:

```text
@threads/contracts
@threads/client
@threads/react
```

The server still runs independently. These packages provide contracts and UI
state; they do not open a database connection.

## 4. Product UI

Create one stable client instance and use the provided hook for cursor pagination
and SSE updates:

```tsx
import { CopilotKit } from "@copilotkit/react-core/v2";
import { ThreadClient, useThreadManager } from "@threads/react";

const client = new ThreadClient({
  baseUrl: "/agent-platform",
  credentials: "include",
  // JWT mode: getAccessToken: () => auth.getAccessToken(),
});

export function AgentWorkspace() {
  const threads = useThreadManager({ client, agentId: "support", pageSize: 30 });
  const threadId = threads.selectedThreadId;

  if (!threadId) return <button onClick={() => threads.createThread()}>New chat</button>;
  return (
    <CopilotKit
      key={threadId}
      runtimeUrl="/agent-platform/api/copilotkit"
      agent="support"
      threadId={threadId}
      useSingleEndpoint={false}
    >
      {/* Render CopilotChat and your sidebar here. */}
    </CopilotKit>
  );
}
```

Important rules:

- Keep `ThreadClient` outside the React component or memoize it.
- Key `CopilotKit` by `threadId`; this gives each thread isolated chat state.
- Use CopilotKit's `CopilotChat`, `useRenderToolCall`/tool renderer and interrupt
  hook for chat behavior. Use `useThreadManager` only for sidebar metadata.
- Do not merge message history manually into CopilotChat. Runtime `connect()`
  replays persisted AG-UI events when a thread is selected.
- `fetchMore()` performs keyset pagination. The hook subscribes from the event
  cursor returned with the initial snapshot, so mounting does not replay all old
  sidebar events.

See `examples/nextjs-copilotkit/` for tool and HITL renderers.

## 5. Project LangGraph agent

The external agent must expose an AG-UI compatible endpoint. With Python:

```python
from ag_ui_langgraph import LangGraphAgent
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()
agent = LangGraphAgent(name="support", graph=compiled_graph)

@app.post("/agent")
async def run_agent(request: Request):
    return StreamingResponse(
        agent.run(await request.json()),
        media_type="text/event-stream",
    )
```

Compile the graph with `AsyncPostgresSaver` and use the incoming thread ID as
LangGraph `configurable.thread_id`. Run checkpoint migrations as a separate
deployment job. Business tools and `interrupt()` remain inside this service.
`examples/langgraph-agent/` is the executable reference.

Runtime forwards the authenticated principal in reserved input metadata:

```json
{"forwardedProps":{"threadPlatform":{"tenantId":"acme","userId":"u-42","roles":["agent-user"]}}}
```

Treat that metadata as context, not as a replacement for private-network service
authentication between Runtime and agent.

## 6. HTTP API

Base path is `/v2`. Full schemas are in `docs/openapi.yaml`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/threads` | idempotent create using `requestId` |
| GET | `/threads?limit=30&cursor=...` | keyset/lazy list |
| GET | `/threads/{id}` | thread metadata |
| GET | `/threads/{id}/messages?after=0` | projected messages for audit/export |
| PATCH | `/threads/{id}` | manual title rename |
| POST | `/threads/{id}/archive` | archive |
| POST | `/threads/{id}/unarchive` | restore |
| DELETE | `/threads/{id}` | soft delete |
| GET | `/thread-events` | authenticated SSE with `Last-Event-ID` replay |

One run is allowed per thread. Different threads can run concurrently, including
multiple threads owned by the same user. A second run on the same thread receives
`409 THREAD_BUSY`. Scale Runtime horizontally; Redis coordinates the lock.

## 7. Authentication and isolation

Never expose `AUTH_MODE=development` outside local development.

Gateway mode (recommended when the product already has auth):

```env
AUTH_MODE=gateway
AUTH_TENANT_HEADER=x-auth-tenant-id
AUTH_USER_HEADER=x-auth-user-id
AUTH_ROLES_HEADER=x-auth-roles
```

The trusted gateway validates the session/JWT, removes inbound spoofed identity
headers, and injects canonical values. Runtime scopes every thread query by
`tenant_id + owner_id + namespace`.

Direct JWT mode:

```env
AUTH_MODE=jwt
JWT_ISSUER=https://identity.example.com/
JWT_AUDIENCE=thread-platform
JWT_JWKS_URL=https://identity.example.com/.well-known/jwks.json
JWT_TENANT_CLAIM=tenant_id
JWT_USER_CLAIM=sub
JWT_ROLES_CLAIM=roles
```

Runtime validates signature, issuer and audience using remote JWKS. Configure
CORS to exact product origins and keep the agent, PostgreSQL and Redis private.

## 8. Local operation

Full reference stack:

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.example.yml up --build -d
docker compose -f docker-compose.yml -f docker-compose.example.yml ps
docker compose -f docker-compose.yml -f docker-compose.example.yml logs -f runtime agent title-worker web
# Only recent logs (avoids confusing errors from replaced containers):
docker compose -f docker-compose.yml -f docker-compose.example.yml logs --since=5m runtime agent
```

Core with an external local agent:

```bash
AGENT_URL=http://host.docker.internal:8000/agent docker compose up --build -d
```

Inspect PostgreSQL:

```bash
docker compose exec postgres psql -U agent -d agent_threads
```

```sql
SELECT id, tenant_id, owner_id, title, title_status, status, message_count,
       last_activity_at
FROM agent_core.agent_threads
ORDER BY last_activity_at DESC LIMIT 30;

SELECT thread_id, sequence, role, status, left(content::text, 120)
FROM agent_core.agent_messages ORDER BY created_at DESC LIMIT 50;

SELECT thread_id, status, attempts, last_error, updated_at
FROM agent_core.agent_title_jobs ORDER BY created_at DESC LIMIT 30;

SELECT id, event_type, thread_id, created_at
FROM agent_core.agent_thread_events ORDER BY id DESC LIMIT 50;
```

## 9. Kubernetes

Local k3d example:

```bash
export OPENAI_API_KEY=...
make local-up
make local-status
make local-logs
make local-db
```

Open `http://threads.localhost:8080`. Delete with `make local-down`.

Production uses core only (`examples.enabled=false`):

```bash
helm upgrade --install threads infra/k8s/charts/thread-platform \
  -n threads --create-namespace \
  -f infra/k8s/charts/thread-platform/values-production.example.yaml \
  --wait --timeout 10m
```

Create secrets before install:

```bash
kubectl -n threads create secret generic ticketing-postgres \
  --from-literal=postgres-url='postgresql://...'
kubectl -n threads create secret generic ticketing-redis \
  --from-literal=redis-url='rediss://...'
kubectl -n threads create secret generic ticketing-title-model \
  --from-literal=TITLE_API_KEY='...'
```

Useful commands:

```bash
kubectl -n threads get deploy,pod,job,cronjob,ingress
kubectl -n threads logs deploy/threads-thread-platform-runtime -f --tail=200
kubectl -n threads logs deploy/threads-thread-platform-title-worker -f --tail=200
kubectl -n threads logs job/threads-thread-platform-postgres-migrate
kubectl -n threads describe pod <pod>
kubectl -n threads get events --sort-by=.lastTimestamp
```

Health probe access logs every few seconds are expected Kubernetes traffic. They
should be excluded or sampled in the agent's access logger, as the reference
agent does; they are not React requests or user runs.

## 10. Small production profile

The supplied defaults target approximately 100 active users and 25 concurrent
runs, subject to model latency and event volume:

- Runtime: 2 replicas, 100m CPU/256Mi request, 1 CPU/1Gi limit.
- Title worker: 1 replica. Increase replicas only if title-job lag grows.
- Managed PostgreSQL with automated backups and connection limits appropriate
  for all Runtime, worker and agent replicas.
- Redis with `noeviction`; persistence is optional because it is not history.
- Ingress buffering disabled and read timeout at least 3600 seconds for SSE.
- PodDisruptionBudget, rolling updates and a 45-second termination grace period.

Before calling a deployment production-ready, provide externally:

- TLS, DNS, WAF/gateway auth, secret manager and image registry.
- Managed PostgreSQL HA, point-in-time recovery and a tested restore procedure.
- Redis HA if temporary run interruption during Redis loss is unacceptable.
- Metrics scraping and alerts for 5xx, latency, active runs, dead title jobs,
  oldest title job, PostgreSQL saturation and Redis memory.
- Load test with representative streaming response sizes and model latency.

## 11. Backup, retention and recovery

Back up the entire PostgreSQL database so `agent_core` and LangGraph checkpoints
remain consistent. Test restore into an isolated database quarterly. Redis does
not need to be restored for history; active runs may be marked interrupted by the
reconciler after lock loss.

`EVENT_RETENTION_DAYS` controls durable sidebar event pruning. It does not delete
threads/messages. `REDIS_STREAM_TTL_SECONDS` controls transient AG-UI live stream
retention; PostgreSQL still stores complete run events for reconnect.

## 12. Troubleshooting

`404 /api/copilotkit`: Runtime must use CopilotKit multi-route handler and the UI
must point exactly to `/api/copilotkit`.

`THREAD_BUSY`: another run owns the same thread lock. Switch to a different
thread or stop/wait for the current run.

AG-UI errors about text start/content/end or custom events after finish: verify
the project agent emits one valid lifecycle. Runtime also normalizes duplicate
message starts, orphan content, duplicate ends and drops events after
`RUN_FINISHED`.

`Response object has been garbage collected`: commonly caused by browser
disconnects during streaming in older CopilotKit/runtime combinations. Confirm
the pinned versions, graceful shutdown, and that UI changes `CopilotKit` key only
when changing thread. Historical occurrences in old container logs do not prove
the current container is failing; use `docker compose logs --since=5m runtime`.

Title remains `New conversation`: inspect `agent_title_jobs`, title-worker logs,
`TITLE_API_KEY`, `TITLE_BASE_URL` and model name. Chat remains non-blocking even
when title generation fails; the job retries and then becomes `fallback`.

Sidebar re-renders repeatedly: create `ThreadClient` once, do not recreate hook
options on every render, and use the SDK version that consumes `eventCursor`
rather than subscribing from event zero.
