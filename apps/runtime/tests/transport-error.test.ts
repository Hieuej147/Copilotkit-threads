import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAgentTransportDisconnect } from "../src/transport-error.js";

describe("agent transport errors", () => {
  it("recognizes an upstream socket closed during a client abort", () => {
    const error = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    assert.equal(isAgentTransportDisconnect(error), true);
  });

  it("does not hide unrelated failures", () => {
    assert.equal(isAgentTransportDisconnect(new Error("database unavailable")), false);
  });
});
