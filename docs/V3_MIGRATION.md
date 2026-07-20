# Thread Platform 1.0 / API v3 Migration

## What changes

Runtime remains self-hosted with PostgreSQL and Redis. API v3 adds a database-backed
agent registry, thread metadata, typed message parts, durable event batching and
independent retention controls. CopilotKit is an edge adapter; LangGraph/LangChain
agents continue to expose AG-UI over HTTP.

Migration `006_platform_v3.sql` is additive. It creates agent definitions,
message parts and run snapshots, then backfills existing messages. Existing
thread, run, message and event IDs are preserved.

## Safe rollout

1. Back up PostgreSQL and test restore.
2. Deploy the `1.0.0` migration Job while the old Runtime still serves traffic.
3. The migration command seeds `AGENT_ID` and `AGENT_URL` as the first registry
   entry. Ensure these variables point to the production agent.
4. Upgrade browser packages and Runtime/workers to `1.0.0` in one coordinated
   release. `ThreadClient` uses v3 exclusively.
5. Verify the gateway/Ingress exposes `/v3` and `/api/copilotkit`.

Thread API `/v2` is removed and returns 404. CopilotKit imports such as
`@copilotkit/react-core/v2` refer to CopilotKit's package API and remain valid.

Do not move or reuse `v0.1.1`. Merge the Changesets version PR and tag its
resulting commit as `v1.0.0`.

## Agent registry

Admin endpoints require `thread-platform-admin`. Apply definitions with:

```bash
THREAD_PLATFORM_URL=https://threads.example.com \
THREAD_PLATFORM_TOKEN="$ADMIN_JWT" \
node apps/runtime/dist/agent-admin-cli.js agents apply --file agents.json
```

```json
{
  "agentId": "support",
  "displayName": "Support",
  "endpointUrl": "http://support-agent.internal:8000/agent",
  "healthUrl": "http://support-agent.internal:8000/health",
  "credentialRef": "file:support-agent-token",
  "enabled": true,
  "timeoutMs": 120000,
  "maxConcurrentRuns": 25,
  "titleEnabled": true,
  "titleBaseUrl": "http://model-gateway.internal/v1",
  "titleModel": "small-title-model",
  "titleCredentialRef": "file:title-model-token"
}
```

Set `AGENT_ALLOWED_HOSTS` to exact internal hosts or wildcard DNS suffixes.
Runtime configuration fails fast outside development when this list is empty.
Credential references support `env:VARIABLE_NAME` and files below
`SECRET_FILE_ROOT`; plaintext credential values are never stored in PostgreSQL.

## Storage defaults

```env
EVENT_BATCH_MAX_DELAY_MS=50
EVENT_BATCH_MAX_SIZE=32
EVENT_BATCH_MAX_BYTES=262144
RUN_EVENT_RETENTION_DAYS=7
THREAD_EVENT_RETENTION_DAYS=7
TITLE_JOB_RETENTION_DAYS=30
MESSAGE_RETENTION_DAYS=365
RUN_RETENTION_DAYS=365
DELETED_THREAD_RETENTION_DAYS=30
```

Completed conversations replay from canonical messages and typed parts. Raw
events serve active/incomplete runs and short-term audit. Terminal events and
process shutdown force a synchronous flush.

## Rollback

The schema change is additive, so Runtime `0.1.1` can still read its original
tables. There is no destructive down migration. A rollback must be coordinated
with the old browser SDK because Runtime `0.1.1` does not serve the v3 contract;
never drop the new tables during rollback.
