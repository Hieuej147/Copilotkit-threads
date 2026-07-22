import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentAdminClient, ThreadApiError, ThreadClient } from "../src/index.js";

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
  metadata: {},
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
    assert.deepEqual(calls, [{ url: "https://threads.example/v4/threads?limit=20", authorization: "Bearer token" }]);
  });

  it("uses the caller idempotency key as a header", async () => {
    let requestBody = "";
    let idempotencyKey: string | null = null;
    const client = new ThreadClient({
      baseUrl: "https://threads.example",
      fetch: async (_input, init) => {
        requestBody = String(init?.body);
        idempotencyKey = new Headers(init?.headers).get("idempotency-key");
        return new Response(JSON.stringify(thread), { headers: { "content-type": "application/json" } });
      },
    });
    const key = "83189ec6-b705-44aa-ae18-7f3b763491fa";
    await client.create({ idempotencyKey: key });
    assert.equal(idempotencyKey, key);
    assert.equal(JSON.parse(requestBody).idempotencyKey, undefined);
    assert.deepEqual(JSON.parse(requestBody).metadata, {});
  });

  it("preserves the receiver of a caller-provided fetch implementation", async () => {
    const transport = {
      calls: 0,
      fetch(this: { calls: number }): Promise<Response> {
        this.calls += 1;
        return Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null, eventCursor: "0" })));
      },
    };
    const customFetch = transport.fetch.bind(transport) as typeof globalThis.fetch;

    const client = new ThreadClient({
      baseUrl: "https://threads.example",
      fetch: customFetch,
    });
    const page = await client.list();
    assert.deepEqual(page.items, []);
    assert.equal(transport.calls, 1);
  });

  it("binds native-style global fetch when no implementation is provided", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function nativeStyleFetch(this: typeof globalThis): Promise<Response> {
      assert.equal(this, globalThis);
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null, eventCursor: "0" })));
    } as typeof globalThis.fetch;
    try {
      const client = new ThreadClient({ baseUrl: "https://threads.example" });
      const page = await client.list();
      assert.deepEqual(page.items, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends If-Match and exposes the stable error envelope", async () => {
    let ifMatch: string | null = null;
    const client = new ThreadClient({
      baseUrl: "https://threads.example",
      fetch: async (_input, init) => {
        ifMatch = new Headers(init?.headers).get("if-match");
        return new Response(JSON.stringify({
          error: {
            code: "THREAD_VERSION_CONFLICT",
            message: "Thread version is stale",
            requestId: "request-99",
          },
        }), { status: 412, headers: { "content-type": "application/json" } });
      },
    });
    await assert.rejects(
      client.rename(thread.id, "new title", 7),
      (error: unknown) => {
        assert.ok(error instanceof ThreadApiError);
        assert.equal(error.status, 412);
        assert.equal(error.code, "THREAD_VERSION_CONFLICT");
        assert.equal(error.requestId, "request-99");
        assert.equal(error.message, "Thread version is stale");
        return true;
      },
    );
    assert.equal(ifMatch, '"7"');
  });
});

describe("AgentAdminClient", () => {
  it("targets the v4 admin API and forwards authentication", async () => {
    let request: { url: string; method: string | undefined; authorization: string | null } | undefined;
    const client = new AgentAdminClient({
      baseUrl: "https://threads.example/",
      getAccessToken: async () => "admin-token",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        request = {
          url: String(input),
          method: init?.method,
          authorization: headers.get("authorization"),
        };
        return new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(await client.list(), []);
    assert.deepEqual(request, {
      url: "https://threads.example/v4/admin/agents",
      method: undefined,
      authorization: "Bearer admin-token",
    });
  });
});
