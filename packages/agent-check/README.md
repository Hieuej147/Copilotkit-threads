# @kiri_ikki/thread-agent-check

Command-line conformance checks for AG-UI lifecycle ordering and Thread Runtime
CRUD/idempotency.

```bash
pnpm dlx @kiri_ikki/thread-agent-check \
  --agent-url http://localhost:8000/agent \
  --health-url http://localhost:8000/health \
  --concurrency 2
```

Add `--runtime-url http://localhost:4000` to validate the self-hosted Thread API.
See the [Agent Contract](https://github.com/Hieuej147/Copilotkit-threads/blob/main/docs/AGENT_CONTRACT.md).
