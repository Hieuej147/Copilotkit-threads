import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const required = {
  POSTGRES_URL: "postgresql://localhost/threads",
  REDIS_URL: "redis://localhost",
};

describe("runtime configuration", () => {
  it("requires complete JWT verification settings", () => {
    assert.throws(() => loadConfig({ ...required, AUTH_MODE: "jwt" }), /JWT_ISSUER/);
    const config = loadConfig({
      ...required,
      AUTH_MODE: "jwt",
      JWT_ISSUER: "https://identity.example.com/",
      JWT_AUDIENCE: "threads",
      JWT_JWKS_URL: "https://identity.example.com/.well-known/jwks.json",
      AGENT_ALLOWED_HOSTS: "agent.internal",
    });
    assert.equal(config.AUTH_MODE, "jwt");
  });

  it("requires an agent host allowlist outside development", () => {
    assert.throws(
      () => loadConfig({ ...required, AUTH_MODE: "gateway" }),
      /AGENT_ALLOWED_HOSTS/,
    );
  });

  it("accepts an OpenAI-compatible title endpoint", () => {
    const config = loadConfig({
      ...required,
      TITLE_BASE_URL: "https://models.internal/v1",
      TITLE_MODEL: "small-title-model",
      RATE_LIMIT_REQUESTS_PER_MINUTE: "0",
      DELETED_THREAD_RETENTION_DAYS: "14",
    });
    assert.equal(config.TITLE_MODEL, "small-title-model");
    assert.equal(config.RATE_LIMIT_REQUESTS_PER_MINUTE, 0);
    assert.equal(config.DELETED_THREAD_RETENTION_DAYS, 14);
  });

  it("allows deleted threads to be purged on the next reconciliation", () => {
    assert.equal(loadConfig({
      ...required,
      DELETED_THREAD_RETENTION_DAYS: "0",
    }).DELETED_THREAD_RETENTION_DAYS, 0);
  });

  it("separates retention and durable batching defaults", () => {
    const config = loadConfig(required);
    assert.equal(config.RUN_EVENT_RETENTION_DAYS, 7);
    assert.equal(config.THREAD_EVENT_RETENTION_DAYS, 7);
    assert.equal(config.MESSAGE_RETENTION_DAYS, 365);
    assert.equal(config.EVENT_BATCH_MAX_DELAY_MS, 50);
    assert.equal(config.EVENT_BATCH_MAX_SIZE, 32);
  });
});
