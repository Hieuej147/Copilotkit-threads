# @kiri_ikki/thread-agent-check

## 2.0.0

### Major Changes

- bbe761a: Release Thread Platform V4 with a consolidated PostgreSQL storage model,
  durable multi-replica runs, dynamic agent registration, stable error envelopes,
  header-based idempotency, and version-guarded thread mutations.

  The framework-neutral client and React integration now target only the V4 API.
  The React manager refreshes the current version before rename, archive, and
  delete operations so background run and title updates do not cause stale writes.

  The AG-UI conformance CLI now validates the V4 lifecycle and cleanup contract.

## 1.0.1

### Patch Changes

- 513f50f: Publish the Runtime image on native amd64 and arm64 GitHub runners to avoid
  QEMU failures during multi-platform releases.

## 1.0.0

### Major Changes

- fa1b5ab: Release Thread Platform 1.0 with API v3, durable event batching, canonical message parts,
  and a dynamic self-hosted agent registry. Thread API v2 is removed.

## 0.1.1

## 0.1.0

### Minor Changes

- 3916ff3: Publish the AG-UI lifecycle and Thread Runtime conformance CLI.
