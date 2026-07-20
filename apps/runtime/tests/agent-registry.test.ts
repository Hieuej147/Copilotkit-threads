import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  upsertAgentDefinitionSchema,
  type AgentDefinition,
  type UpsertAgentDefinition,
} from "@kiri_ikki/thread-contracts";
import { CachedAgentRegistry } from "../src/agent-registry.js";
import { validateAgentUrl } from "../src/agent-policy.js";
import { EnvironmentFileCredentialResolver } from "../src/credential-resolver.js";
import { loadConfig } from "../src/config.js";
import type { AgentRegistry } from "../src/ports.js";

const agent: AgentDefinition = {
  id: "65c823b6-4a31-46e4-9cf8-89ef64394c11",
  agentId: "support",
  displayName: "Support",
  endpointUrl: "http://support.internal:8000/agent",
  healthUrl: "http://support.internal:8000/health",
  credentialRef: null,
  enabled: true,
  timeoutMs: 120000,
  maxConcurrentRuns: 25,
  titleEnabled: true,
  titleBaseUrl: null,
  titleModel: null,
  titleCredentialRef: null,
  version: 1,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

describe("agent registry", () => {
  it("caches reads and invalidates after writes", async () => {
    let reads = 0;
    const source: AgentRegistry = {
      get: async () => agent,
      list: async () => { reads += 1; return [agent]; },
      upsert: async (_id: string, _input: UpsertAgentDefinition) => ({ ...agent, version: 2 }),
      disable: async () => ({ ...agent, enabled: false }),
    };
    const registry = new CachedAgentRegistry(source, 60_000);
    await registry.list();
    await registry.list();
    assert.equal(reads, 1);
    await registry.disable("support");
    await registry.list();
    assert.equal(reads, 2);
  });

  it("allows configured internal hosts and rejects metadata endpoints", () => {
    const config = loadConfig({
      POSTGRES_URL: "postgresql://localhost/threads",
      REDIS_URL: "redis://localhost",
      AUTH_MODE: "gateway",
      AGENT_URL: "http://legacy.internal/agent",
      AGENT_ALLOWED_HOSTS: "*.internal",
    });
    assert.equal(validateAgentUrl("http://support.internal:8000/agent", config).hostname, "support.internal");
    assert.throws(() => validateAgentUrl("http://169.254.169.254/latest", config), /NOT_ALLOWED/);
    assert.throws(() => validateAgentUrl("http://public.example.com/agent", config), /NOT_ALLOWED/);
    const exactConfig = loadConfig({
      POSTGRES_URL: "postgresql://localhost/threads",
      REDIS_URL: "redis://localhost",
      AUTH_MODE: "gateway",
      AGENT_URL: "http://legacy.internal/agent",
      AGENT_ALLOWED_HOSTS: "support.internal",
    });
    assert.throws(() => validateAgentUrl("http://legacy.internal/agent", exactConfig), /NOT_ALLOWED/);
  });

  it("rejects plaintext and unsafe credential references at the contract boundary", () => {
    const input = {
      displayName: "Support",
      endpointUrl: "http://support.internal/agent",
      credentialRef: "plain-secret",
      enabled: true,
      timeoutMs: 120000,
      maxConcurrentRuns: 25,
      titleEnabled: true,
    };
    assert.throws(() => upsertAgentDefinitionSchema.parse(input), /credential reference/);
    assert.throws(() => upsertAgentDefinitionSchema.parse({
      ...input,
      credentialRef: "file:../../etc/passwd",
    }), /credential reference/);
    assert.doesNotThrow(() => upsertAgentDefinitionSchema.parse({
      ...input,
      credentialRef: "file:agents/support-token",
      titleCredentialRef: "env:TITLE_MODEL_TOKEN",
    }));
  });

  it("resolves environment references without exposing arbitrary names", async () => {
    process.env.TEST_THREAD_AGENT_TOKEN = "secret";
    const resolver = new EnvironmentFileCredentialResolver("/tmp/thread-platform-secrets");
    assert.equal(await resolver.resolve("env:TEST_THREAD_AGENT_TOKEN"), "secret");
    await assert.rejects(() => resolver.resolve("env:bad-name"), /INVALID_CREDENTIAL_REFERENCE/);
    await assert.rejects(() => resolver.resolve("file:../../etc/passwd"), /INVALID_CREDENTIAL_REFERENCE/);
    delete process.env.TEST_THREAD_AGENT_TOKEN;
  });
});
