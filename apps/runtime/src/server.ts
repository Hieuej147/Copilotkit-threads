import "reflect-metadata";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Redis } from "ioredis";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotExpressHandler } from "@copilotkit/runtime/v2/express";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { DurableAgentRunner } from "./durable-runner.js";
import { createThreadApi } from "./http-api.js";
import { ThreadRepository } from "./repository.js";
import { createPrincipalMiddleware } from "./auth.js";
import { createRateLimitMiddleware } from "./rate-limit.js";
import { isAgentTransportDisconnect } from "./transport-error.js";
import { PostgresAgentRegistry, CachedAgentRegistry } from "./agent-registry.js";
import { EnvironmentFileCredentialResolver } from "./credential-resolver.js";
import { createAdminApi, registryInvalidationChannel } from "./admin-api.js";
import { validateAgentUrl } from "./agent-policy.js";

const config = loadConfig();
const pool = createPool(config.POSTGRES_URL, config.POSTGRES_POOL_MAX);
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});
redis.on("error", (error) => {
  console.error(JSON.stringify({ level: "warn", message: "runtime_redis_error", error: String(error) }));
});
const registrySource = new PostgresAgentRegistry(pool, config.AGENT_NAMESPACE);
const registry = new CachedAgentRegistry(registrySource, config.AGENT_REGISTRY_CACHE_TTL_MS);
const credentials = new EnvironmentFileCredentialResolver(config.SECRET_FILE_ROOT);
const repository = new ThreadRepository(pool, config.AGENT_NAMESPACE, config.AGENT_ID, registry);
const runner = new DurableAgentRunner(repository, redis, config, registry);
const runtime = new CopilotRuntime({
  agents: async () => {
    const agents = await registry.list({ enabledOnly: true });
    const entries = await Promise.all(agents.map(async (definition) => {
      validateAgentUrl(definition.endpointUrl, config);
      const secret = await credentials.resolve(definition.credentialRef);
      const agent = new LangGraphHttpAgent({
        agentId: definition.agentId,
        url: definition.endpointUrl,
        headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
        fetch: (input, init = {}) => fetch(input, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(definition.timeoutMs)])
            : AbortSignal.timeout(definition.timeoutMs),
        }),
      });
      return [definition.agentId, agent] as const;
    }));
    if (!entries.length) throw new Error("NO_ENABLED_AGENTS");
    return Object.fromEntries(entries) as Record<string, LangGraphHttpAgent>;
  },
  runner,
});

const registrySubscriber = redis.duplicate();
registrySubscriber.on("message", () => registry.invalidate());
registrySubscriber.on("error", (error) => {
  console.error(JSON.stringify({ level: "warn", message: "registry_subscriber_error", error: String(error) }));
});
await registrySubscriber.subscribe(registryInvalidationChannel(config.AGENT_NAMESPACE));

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: config.CORS_ORIGIN.split(","), credentials: true }));
app.use((request, response, next) => {
  const requestId = request.header("x-request-id")?.slice(0, 128) || randomUUID();
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "2mb" }));

app.get("/live", (_request, response) => response.json({ status: "ok" }));

app.get("/health", async (_request, response) => {
  const [database, cache] = await Promise.all([
    pool.query("SELECT 1").then(() => "up", () => "down"),
    redis.ping().then(() => "up", () => "down"),
  ]);
  response.status(database === "up" && cache === "up" ? 200 : 503).json({
    status: database === "up" && cache === "up" ? "ok" : "degraded",
    database,
    redis: cache,
  });
});

app.get("/ready", async (_request, response) => {
  const [schema, cache] = await Promise.all([
    pool.query("SELECT 1 FROM agent_core.schema_migrations WHERE version = '006_platform_v3'")
      .then((result) => result.rowCount ? "up" : "down", () => "down"),
    redis.ping().then(() => "up", () => "down"),
  ]);
  response.status(schema === "up" && cache === "up" ? 200 : 503).json({
    status: schema === "up" && cache === "up" ? "ok" : "not_ready",
    schema,
    redis: cache,
  });
});

app.get("/metrics", async (_request, response) => {
  const metrics = await repository.operationalMetrics();
  const runMetrics = runner.metrics();
  const namespace = config.AGENT_NAMESPACE.replace(/["\\\n]/g, "_");
  const label = `{namespace="${namespace}"}`;
  response.type("text/plain; version=0.0.4").send([
    "# HELP thread_platform_active_runs Active queued or running agent runs.",
    "# TYPE thread_platform_active_runs gauge",
    `thread_platform_active_runs${label} ${metrics.activeRuns}`,
    "# HELP thread_platform_title_jobs Title outbox jobs by status.",
    "# TYPE thread_platform_title_jobs gauge",
    `thread_platform_title_jobs${label.slice(0, -1)},status="pending"} ${metrics.titlePending}`,
    `thread_platform_title_jobs${label.slice(0, -1)},status="running"} ${metrics.titleRunning}`,
    `thread_platform_title_jobs${label.slice(0, -1)},status="dead"} ${metrics.titleDead}`,
    "# HELP thread_platform_oldest_title_job_seconds Age of the oldest unfinished title job.",
    "# TYPE thread_platform_oldest_title_job_seconds gauge",
    `thread_platform_oldest_title_job_seconds${label} ${metrics.oldestTitleJobSeconds}`,
    "# TYPE thread_platform_event_batches_total counter",
    `thread_platform_event_batches_total${label} ${runMetrics.eventBatches}`,
    "# TYPE thread_platform_events_persisted_total counter",
    `thread_platform_events_persisted_total${label} ${runMetrics.eventsPersisted}`,
    "# TYPE thread_platform_event_batch_failures_total counter",
    `thread_platform_event_batch_failures_total${label} ${runMetrics.batchFailures}`,
    "# TYPE thread_platform_agent_capacity_rejected_total counter",
    `thread_platform_agent_capacity_rejected_total${label} ${runMetrics.capacityRejected}`,
    "# HELP process_resident_memory_bytes Resident memory used by the Runtime process.",
    "# TYPE process_resident_memory_bytes gauge",
    `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    "",
  ].join("\n"));
});

app.use(createPrincipalMiddleware(config));
app.use(createRateLimitMiddleware(redis, config.RATE_LIMIT_REQUESTS_PER_MINUTE));
app.use("/v3", createThreadApi(repository, redis, config.AGENT_NAMESPACE));
app.use("/v3/admin", createAdminApi({ registry, credentials, redis, config }));
app.use(createCopilotExpressHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "multi-route",
  cors: false,
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "VALIDATION_ERROR", details: error.issues });
    return;
  }
  const normalized = error instanceof Error ? error : new Error(String(error));
  const status = normalized.message === "THREAD_NOT_FOUND" ? 404
    : normalized.message === "THREAD_BUSY" ? 409
      : normalized.message === "AGENT_NOT_CONFIGURED" ? 400
        : normalized.message === "INVALID_CURSOR" ? 400
      : normalized.message === "AUTH_CONTEXT_MISSING" ? 401
        : normalized.message === "THREAD_AGENT_MISMATCH" ? 409
          : normalized.message.includes("AGENT_HOST_NOT_ALLOWED") ? 400
      : 500;
  console.error(JSON.stringify({ level: "error", message: normalized.message, stack: normalized.stack }));
  response.status(status).json({ error: normalized.message });
});

const server = app.listen(config.RUNTIME_PORT, () => {
  console.log(`Runtime listening on http://localhost:${config.RUNTIME_PORT}`);
});

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  const drained = new Promise<void>((resolve) => server.close(() => resolve()));
  await runner.shutdown();
  await Promise.race([
    drained,
    new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
  ]);
  server.closeAllConnections();
  registrySubscriber.disconnect();
  await Promise.all([pool.end(), redis.quit()]);
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  if (isAgentTransportDisconnect(reason)) {
    console.warn(JSON.stringify({
      level: "warn",
      message: "agent_transport_disconnected",
      error: reason instanceof Error ? reason.message : String(reason),
    }));
    return;
  }
  console.error(JSON.stringify({
    level: "fatal",
    message: "unhandled_rejection",
    error: reason instanceof Error ? reason.message : String(reason),
  }));
  void shutdown("UNHANDLED_REJECTION", 1);
});
