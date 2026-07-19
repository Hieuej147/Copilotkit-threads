import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { OpenAICompatibleTitleWorker } from "../src/title-worker.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("OpenAI-compatible title worker", () => {
  it("returns a bounded, unquoted title", async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      assert.equal(body.messages[1]?.content, "How do I deploy this service?");
      return new Response(JSON.stringify({ model: "title-v1", choices: [{ message: { content: '"Deploy Thread Service"' } }] }));
    };
    const worker = new OpenAICompatibleTitleWorker({
      baseUrl: "https://models.example/v1/",
      apiKey: "test",
      model: "title-v1",
      timeoutMs: 1_000,
    });
    assert.deepEqual(await worker.generate("How do I deploy this service?"), {
      title: "Deploy Thread Service",
      model: "title-v1",
    });
  });

  it("fails fast without a key", async () => {
    const worker = new OpenAICompatibleTitleWorker({
      baseUrl: "https://models.example/v1",
      apiKey: "",
      model: "title-v1",
      timeoutMs: 1_000,
    });
    await assert.rejects(() => worker.generate("hello"), /TITLE_API_KEY_MISSING/);
  });
});
