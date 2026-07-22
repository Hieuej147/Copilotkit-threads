import { Router, type NextFunction, type Request, type Response } from "express";
import { Redis } from "ioredis";
import { agentDefinitionSchema, upsertAgentDefinitionSchema } from "@kiri_ikki/thread-contracts";
import { z } from "zod";
import { currentPrincipal } from "./auth.js";
import { validateAgentUrl } from "./agent-policy.js";
import type { RuntimeConfig } from "./config.js";
import type { AgentRegistry, CredentialResolver } from "./ports.js";
import { sendError } from "./http-error.js";

const agentIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/);

export function registryInvalidationChannel(namespace: string): string {
  return `agent:${namespace}:registry-invalidated`;
}

function requireAdmin(config: RuntimeConfig) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    const principal = currentPrincipal();
    const allowed = principal.roles.includes(config.ADMIN_ROLE)
      || (config.AUTH_MODE === "development" && config.ADMIN_DEVELOPMENT_ENABLED);
    if (!allowed) {
      sendError(response, 403, "ADMIN_ROLE_REQUIRED", "Administrator role is required");
      return;
    }
    next();
  };
}

export function createAdminApi(options: {
  registry: AgentRegistry;
  credentials: CredentialResolver;
  redis: Redis;
  config: RuntimeConfig;
}): Router {
  const { registry, credentials, redis, config } = options;
  const router = Router();
  router.use(requireAdmin(config));

  router.get("/agents", async (_request, response) => {
    response.json({ items: (await registry.list()).map((agent) => agentDefinitionSchema.parse(agent)) });
  });

  router.get("/agents/:agentId", async (request, response) => {
    const agent = await registry.get(agentIdSchema.parse(request.params.agentId));
    if (!agent) return sendError(response, 404, "AGENT_NOT_FOUND", "Agent was not found");
    return response.json(agentDefinitionSchema.parse(agent));
  });

  router.put("/agents/:agentId", async (request, response) => {
    const agentId = agentIdSchema.parse(request.params.agentId);
    const input = upsertAgentDefinitionSchema.parse(request.body);
    validateAgentUrl(input.endpointUrl, config);
    if (input.healthUrl) validateAgentUrl(input.healthUrl, config);
    const existing = await registry.get(agentId);
    const agent = await registry.upsert(agentId, input);
    await redis.publish(registryInvalidationChannel(config.AGENT_NAMESPACE), agentId);
    return response.status(existing ? 200 : 201).json(agentDefinitionSchema.parse(agent));
  });

  router.post("/agents/:agentId/disable", async (request, response) => {
    const agentId = agentIdSchema.parse(request.params.agentId);
    const agent = await registry.disable(agentId);
    if (!agent) return sendError(response, 404, "AGENT_NOT_FOUND", "Agent was not found");
    await redis.publish(registryInvalidationChannel(config.AGENT_NAMESPACE), agentId);
    return response.json(agentDefinitionSchema.parse(agent));
  });

  router.post("/agents/:agentId/test", async (request, response) => {
    const agent = await registry.get(agentIdSchema.parse(request.params.agentId));
    if (!agent) return sendError(response, 404, "AGENT_NOT_FOUND", "Agent was not found");
    const endpoint = validateAgentUrl(agent.healthUrl ?? new URL("/health", agent.endpointUrl).toString(), config);
    const secret = await credentials.resolve(agent.credentialRef);
    const startedAt = performance.now();
    const upstream = await fetch(endpoint, {
      headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
      signal: AbortSignal.timeout(Math.min(agent.timeoutMs, 30_000)),
    });
    return response.status(upstream.ok ? 200 : 502).json({
      ok: upstream.ok,
      status: upstream.status,
      latencyMs: Math.round(performance.now() - startedAt),
    });
  });

  return router;
}
