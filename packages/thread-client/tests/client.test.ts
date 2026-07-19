import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThreadClient } from "../src/index.js";

const thread = {
  id: "65c823b6-4a31-46e4-9cf8-89ef64394c11",
  namespace: "test",
  agentId: "default",
  title: "New conversation",
  titleStatus: "pending",
  status: "active",
  messageCount: 0,
  lastMessagePreview: null,
  version: 0,
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  lastActivityAt: "2026-07-19T00:00:00.000Z",
};

describe("ThreadClient", () => {
  it("sends auth and parses a paginated snapshot cursor", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = new ThreadClient({
      baseUrl: "https://threads.example/",
      getAccessToken: () => "token",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), authorization: headers.get("authorization") });
        return new Response(JSON.stringify({ items: [thread], nextCursor: "next", eventCursor: "42" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const page = await client.list({ limit: 20 });
    assert.equal(page.eventCursor, "42");
    assert.deepEqual(calls, [{ url: "https://threads.example/v2/threads?limit=20", authorization: "Bearer token" }]);
  });

  it("uses caller requestId for idempotent creation", async () => {
    let requestBody = "";
    const client = new ThreadClient({
      baseUrl: "https://threads.example",
      fetch: async (_input, init) => {
        requestBody = String(init?.body);
        return new Response(JSON.stringify(thread), { headers: { "content-type": "application/json" } });
      },
    });
    const requestId = "83189ec6-b705-44aa-ae18-7f3b763491fa";
    await client.create({ requestId });
    assert.equal(JSON.parse(requestBody).requestId, requestId);
  });
});
