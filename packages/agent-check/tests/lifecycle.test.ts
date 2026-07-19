import assert from "node:assert/strict";
import test from "node:test";
import { validateEventLifecycle } from "../src/index.js";

test("accepts a complete text lifecycle", () => {
  const result = validateEventLifecycle([
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hello" },
    { type: "TEXT_MESSAGE_END", messageId: "m" },
    { type: "RUN_FINISHED", threadId: "t", runId: "r" },
  ]);
  assert.equal(result.eventCount, 5);
});

test("rejects content without a start", () => {
  assert.throws(() => validateEventLifecycle([
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hello" },
    { type: "RUN_FINISHED", threadId: "t", runId: "r" },
  ]), /no matching TEXT_MESSAGE_START/);
});

test("rejects events after a terminal event", () => {
  assert.throws(() => validateEventLifecycle([
    { type: "RUN_STARTED", threadId: "t", runId: "r" },
    { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    { type: "CUSTOM", name: "late", value: {} },
  ]), /after the run terminated/);
});
