# Thread Platform 2.0 / API v4 migration

V4 is an intentionally breaking, clean-install release. There is no production
data migration from the previous experimental schemas. Back up anything worth
keeping, deploy an empty PostgreSQL database, and run `pnpm db:migrate` before
starting Runtime or workers.

## Breaking changes

- The HTTP API base path is `/v4`.
- Published packages move to `2.0.0`.
- `POST /threads` takes `Idempotency-Key` as a required header; it is no longer a
  request-body field.
- Rename, archive, unarchive, and delete require `If-Match` with the current
  thread version. Stale versions receive HTTP 412; a missing header receives 428.
- PostgreSQL uses the consolidated `thread_platform` schema.
- PostgreSQL is the durable source for runs and events. Redis carries locks,
  fencing counters, capacity leases, cancellation, and Pub/Sub wakeups only.
- A crashed run is preserved as partial history and reconciled to `interrupted`.
  Retrying creates a new idempotent run; V4 does not promise transparent resume.

## Rollout

1. Stop the experimental Runtime, title worker, and reconciler.
2. Provision an empty database and Redis deployment.
3. Deploy the `2.0.0` migration job.
4. Deploy Runtime and workers, then verify `/live`, `/ready`, and `/health`.
5. Upgrade `thread-contracts`, `thread-client`, and `thread-react` together.
6. Confirm the gateway streams `/api/copilotkit` and `/v4/thread-events` without
   buffering and forwards `Last-Event-ID`, `Idempotency-Key`, and `If-Match`.

Rollback means redeploying the old stack against its old database. Do not point
old binaries at the V4 schema.
