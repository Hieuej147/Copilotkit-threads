import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { ThreadRepository } from "./repository.js";
import { TitleQueueWorker } from "./title-queue.js";
import { OpenAICompatibleTitleWorker } from "./title-worker.js";

const config = loadConfig();
const pool = createPool(config.POSTGRES_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (error) => {
  console.error(JSON.stringify({ level: "warn", message: "title_worker_redis_error", error: String(error) }));
});
const repository = new ThreadRepository(pool, config.AGENT_NAMESPACE, config.AGENT_ID);
const worker = new TitleQueueWorker(
  redis,
  repository,
  new OpenAICompatibleTitleWorker({
    baseUrl: config.TITLE_BASE_URL,
    apiKey: config.TITLE_API_KEY,
    model: config.TITLE_MODEL,
    timeoutMs: config.TITLE_TIMEOUT_MS,
  }),
  config,
);

async function shutdown(signal: string): Promise<void> {
  console.log(`Title worker received ${signal}`);
  worker.stop();
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
