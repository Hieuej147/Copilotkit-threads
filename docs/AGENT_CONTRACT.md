# Agent Contract

Thread Runtime accepts any agent that implements AG-UI over HTTP. The agent is
responsible for graph state, tools, HITL interrupts and LangGraph checkpoints;
it must not write `agent_core` tables.

## Required endpoints

- `GET /health`: return `200` only when the process and checkpoint store are
  ready.
- `POST /agent`: accept AG-UI `RunAgentInput` and stream AG-UI events as SSE.

Use `ag-ui-langgraph` rather than writing the event adapter by hand:

```python
agent = LangGraphAgent(name="default", graph=compiled_graph)
add_langgraph_fastapi_endpoint(app, agent, "/agent")
```

Compile the graph with `AsyncPostgresSaver` and run its `.setup()` migration in
a separate one-shot job. The incoming AG-UI `threadId` must remain LangGraph's
`configurable.thread_id`; do not replace it with a process-local session ID.

## Event lifecycle

For every run:

1. Emit exactly one `RUN_STARTED` before all other run events.
2. For each text message, emit one start, zero or more content events, then one
   end using the same `messageId`.
3. For each tool call, emit one start, args chunks, then one end using the same
   `toolCallId`.
4. Emit exactly one terminal `RUN_FINISHED` or `RUN_ERROR`.
5. Emit nothing after the terminal event.

Tool calls and LangGraph `interrupt()` stay in the main AG-UI stream. Thread
title generation does not: Runtime enqueues it once after the first user
message and a separate title worker processes it asynchronously.

## Identity and trust

Runtime adds authenticated context under:

```json
{"forwardedProps":{"threadPlatform":{"tenantId":"acme","userId":"u-42","roles":["agent-user"]}}}
```

Use this for authorization context, but also authenticate Runtime-to-agent
traffic at the network/service layer. Never trust identity headers sent directly
by a browser.

## Validate before integration

```bash
pnpm dlx @kiri_ikki/thread-agent-check \
  --agent-url http://localhost:8000/agent \
  --health-url http://localhost:8000/health \
  --concurrency 2 \
  --timeout-ms 90000
```

Run it in the agent's CI against a disposable PostgreSQL database. Add separate
tests for each business tool and interrupt path because a generic conformance
prompt cannot force every domain-specific branch.
