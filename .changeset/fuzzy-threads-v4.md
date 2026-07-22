---
"@kiri_ikki/thread-contracts": major
"@kiri_ikki/thread-client": major
"@kiri_ikki/thread-react": major
"@kiri_ikki/thread-agent-check": major
---

Release Thread Platform V4 with a consolidated PostgreSQL storage model,
durable multi-replica runs, dynamic agent registration, stable error envelopes,
header-based idempotency, and version-guarded thread mutations.

The framework-neutral client and React integration now target only the V4 API.
The React manager refreshes the current version before rename, archive, and
delete operations so background run and title updates do not cause stale writes.

The AG-UI conformance CLI now validates the V4 lifecycle and cleanup contract.
