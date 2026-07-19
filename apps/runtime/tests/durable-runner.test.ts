import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventNormalizer } from "../src/durable-runner.js";

function textEvent(
  type: "TEXT_MESSAGE_START" | "TEXT_MESSAGE_CONTENT" | "TEXT_MESSAGE_END",
  messageId: string,
  chunkId: string,
  node = "chat",
) {
  return {
    type,
    messageId,
    delta: type === "TEXT_MESSAGE_CONTENT" ? "hello" : undefined,
    rawEvent: {
      data: { chunk: { id: chunkId, content: "hello" } },
      metadata: { langgraph_node: node },
    },
  } as never;
}

describe("AG-UI event normalizer", () => {
  it("repairs adapter message IDs from the model chunk", () => {
    const normalize = createEventNormalizer();
    const start = normalize(textEvent("TEXT_MESSAGE_START", "title-id", "chat-id"));
    const content = normalize(textEvent("TEXT_MESSAGE_CONTENT", "title-id", "chat-id"));
    assert.equal(start?.messageId, "chat-id");
    assert.equal(content?.messageId, "chat-id");
  });

  it("drops title events, duplicate starts, and orphan content", () => {
    const normalize = createEventNormalizer();
    assert.equal(normalize(textEvent("TEXT_MESSAGE_START", "title-id", "title-id", "title")), null);
    assert.equal(normalize(textEvent("TEXT_MESSAGE_CONTENT", "chat-id", "chat-id")), null);
    assert.notEqual(normalize(textEvent("TEXT_MESSAGE_START", "chat-id", "chat-id")), null);
    assert.equal(normalize(textEvent("TEXT_MESSAGE_START", "chat-id", "chat-id")), null);
    assert.notEqual(normalize(textEvent("TEXT_MESSAGE_CONTENT", "chat-id", "chat-id")), null);
    assert.notEqual(normalize(textEvent("TEXT_MESSAGE_END", "chat-id", "chat-id")), null);
    assert.equal(normalize(textEvent("TEXT_MESSAGE_CONTENT", "chat-id", "chat-id")), null);
  });

  it("drops every event emitted after RUN_FINISHED", () => {
    const normalize = createEventNormalizer();
    assert.deepEqual(normalize({ type: "RUN_FINISHED", threadId: "thread", runId: "run" } as never), {
      type: "RUN_FINISHED", threadId: "thread", runId: "run",
    });
    assert.equal(normalize({ type: "CUSTOM", name: "late", value: {} } as never), null);
    assert.equal(normalize(textEvent("TEXT_MESSAGE_START", "late", "late")), null);
  });
});
