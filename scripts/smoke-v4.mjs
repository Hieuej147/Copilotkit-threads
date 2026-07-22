import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const baseUrl = (process.env.THREAD_PLATFORM_URL ?? "http://localhost:4000").replace(/\/$/, "");

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

const key = `smoke-${randomUUID()}`;
const createHeaders = { "content-type": "application/json", "idempotency-key": key };
const created = await json("/v4/threads", {
  method: "POST",
  headers: createHeaders,
  body: JSON.stringify({ metadata: { source: "smoke-v4" } }),
});
assert.equal(created.response.status, 201);
assert.equal(typeof created.body.id, "string");
assert.equal(typeof created.body.version, "number");

const duplicate = await json("/v4/threads", {
  method: "POST",
  headers: createHeaders,
  body: JSON.stringify({ metadata: { source: "ignored-on-retry" } }),
});
assert.equal(duplicate.response.status, 200);
assert.equal(duplicate.body.id, created.body.id);

const missingVersion = await json(`/v4/threads/${created.body.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Missing precondition" }),
});
assert.equal(missingVersion.response.status, 428);
assert.equal(missingVersion.body.error.code, "THREAD_VERSION_REQUIRED");
assert.equal(typeof missingVersion.body.error.requestId, "string");

const renamed = await json(`/v4/threads/${created.body.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json", "if-match": `"${created.body.version}"` },
  body: JSON.stringify({ title: "V4 smoke thread" }),
});
assert.equal(renamed.response.status, 200);
assert.equal(renamed.body.version, created.body.version + 1);

const stale = await json(`/v4/threads/${created.body.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json", "if-match": `"${created.body.version}"` },
  body: JSON.stringify({ title: "Stale write" }),
});
assert.equal(stale.response.status, 412);
assert.equal(stale.body.error.code, "THREAD_VERSION_CONFLICT");

const list = await json("/v4/threads?limit=10");
assert.equal(list.response.status, 200);
assert.ok(list.body.items.some((thread) => thread.id === created.body.id));
assert.match(list.body.eventCursor, /^\d+$/);

const streamController = new AbortController();
const streamTimeout = setTimeout(() => streamController.abort(), 5_000);
const stream = await fetch(`${baseUrl}/v4/thread-events?after=0`, { signal: streamController.signal });
assert.equal(stream.status, 200);
assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let streamed = "";
while (!streamed.includes(created.body.id)) {
  const chunk = await reader.read();
  if (chunk.done) break;
  streamed += decoder.decode(chunk.value, { stream: true });
}
clearTimeout(streamTimeout);
streamController.abort();
assert.ok(streamed.includes(created.body.id));

const info = await fetch(`${baseUrl}/api/copilotkit/info`);
assert.equal(info.status, 200);

const removed = await json(`/v4/threads/${created.body.id}`, {
  method: "DELETE",
  headers: { "if-match": `"${renamed.body.version}"` },
});
assert.equal(removed.response.status, 204);

console.log(JSON.stringify({ status: "ok", threadId: created.body.id }));
