import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { ThreadRepository } from "./repository.js";
import { TitleQueueWorker } from "./title-queue.js";
import { OpenAICompatibleTitleWorker } from "./title-worker.js";
import { PostgresAgentRegistry, CachedAgentRegistry } from "./agent-registry.js";
import { EnvironmentFileCredentialResolver } from "./credential-resolver.js";
import { registryInvalidationChannel } from "./admin-api.js";

const config = loadConfig();
const pool = createPool(config.POSTGRES_URL, config.POSTGRES_POOL_MAX);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (error) => {
  console.error(JSON.stringify({ level: "warn", message: "title_worker_redis_error", error: String(error) }));
});
const registry = new CachedAgentRegistry(
  new PostgresAgentRegistry(pool, config.AGENT_NAMESPACE),
  config.AGENT_REGISTRY_CACHE_TTL_MS,
);
const credentials = new EnvironmentFileCredentialResolver(config.SECRET_FILE_ROOT);
const registrySubscriber = redis.duplicate();
registrySubscriber.on("message", () => registry.invalidate());
registrySubscriber.on("error", (error) => {
  console.error(JSON.stringify({ level: "warn", message: "registry_subscriber_error", error: String(error) }));
});
await registrySubscriber.subscribe(registryInvalidationChannel(config.AGENT_NAMESPACE));
const repository = new ThreadRepository(pool, config.AGENT_NAMESPACE, config.AGENT_ID, registry);
const worker = new TitleQueueWorker(
  redis,
  repository,
  config,
  registry,
  credentials,
  new OpenAICompatibleTitleWorker({
    baseUrl: config.TITLE_BASE_URL,
    apiKey: config.TITLE_API_KEY,
    model: config.TITLE_MODEL,
    timeoutMs: config.TITLE_TIMEOUT_MS,
  }),
);

async function shutdown(signal: string): Promise<void> {
  console.log(`Title worker received ${signal}`);
  worker.stop();
  registrySubscriber.disconnect();
  redis.disconnect();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

worker.start().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", message: "title_worker_failed", error: String(error) }));
  process.exitCode = 1;
});
