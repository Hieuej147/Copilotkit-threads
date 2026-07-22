import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const replicaA = (process.env.THREAD_PLATFORM_URL_A ?? "http://localhost:4401").replace(/\/$/, "");
const replicaB = (process.env.THREAD_PLATFORM_URL_B ?? "http://localhost:4402").replace(/\/$/, "");
const gatewaySecret = process.env.AUTH_GATEWAY_SECRET ?? "smoke-gateway-secret-with-32-characters";
const ownerHeaders = {
  "x-auth-tenant-id": "smoke-tenant",
  "x-auth-user-id": "smoke-owner",
  "x-thread-platform-gateway-secret": gatewaySecret,
};
const otherHeaders = {
  "x-auth-tenant-id": "smoke-tenant",
  "x-auth-user-id": "other-owner",
  "x-thread-platform-gateway-secret": gatewaySecret,
};

async function json(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

const key = `multi-${randomUUID()}`;
const created = await json(replicaA, "/v4/threads", {
  method: "POST",
  headers: {
    ...ownerHeaders,
    "content-type": "application/json",
    "idempotency-key": key,
  },
  body: "{}",
});
assert.equal(created.response.status, 201);

const hidden = await json(replicaB, `/v4/threads/${created.body.id}`, { headers: otherHeaders });
assert.equal(hidden.response.status, 404);
assert.equal(hidden.body.error.code, "THREAD_NOT_FOUND");

const snapshot = await json(replicaB, "/v4/threads?limit=10", { headers: ownerHeaders });
assert.equal(snapshot.response.status, 200);
assert.ok(snapshot.body.items.some((thread) => thread.id === created.body.id));

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5_000);
const stream = await fetch(`${replicaB}/v4/thread-events`, {
  headers: { ...ownerHeaders, "last-event-id": snapshot.body.eventCursor },
  signal: controller.signal,
});
assert.equal(stream.status, 200);

const renamed = await json(replicaA, `/v4/threads/${created.body.id}`, {
  method: "PATCH",
  headers: {
    ...ownerHeaders,
    "content-type": "application/json",
    "if-match": `"${created.body.version}"`,
  },
  body: JSON.stringify({ title: "Cross-replica wakeup" }),
});
assert.equal(renamed.response.status, 200);

const reader = stream.body.getReader();
const decoder = new TextDecoder();
let payload = "";
while (!payload.includes("Cross-replica wakeup")) {
  const chunk = await reader.read();
  if (chunk.done) break;
  payload += decoder.decode(chunk.value, { stream: true });
}
clearTimeout(timeout);
controller.abort();
assert.ok(payload.includes("Cross-replica wakeup"));

const removed = await json(replicaB, `/v4/threads/${created.body.id}`, {
  method: "DELETE",
  headers: { ...ownerHeaders, "if-match": `"${renamed.body.version}"` },
});
assert.equal(removed.response.status, 204);

console.log(JSON.stringify({ status: "ok", threadId: created.body.id }));
