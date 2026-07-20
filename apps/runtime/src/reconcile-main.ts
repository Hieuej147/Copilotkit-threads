import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { ThreadRepository } from "./repository.js";

const config = loadConfig();
const pool = createPool(config.POSTGRES_URL, config.POSTGRES_POOL_MAX);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on("error", (error) => {
  console.error(JSON.stringify({ level: "warn", message: "reconciler_redis_error", error: String(error) }));
});
const repository = new ThreadRepository(pool, config.AGENT_NAMESPACE, config.AGENT_ID);

try {
  const staleRuns = await repository.listStaleRuns(config.RUN_STALE_AFTER_SECONDS);
  let interrupted = 0;
  for (const run of staleRuns) {
    const lockKey = `agent:${config.AGENT_NAMESPACE}:lock:${run.threadId}`;
    if (await redis.exists(lockKey)) continue;
    await repository.interruptStaleRun(run.id);
    interrupted += 1;
  }
  const [prunedEvents, prunedTitleJobs, prunedThreadEvents, prunedMessages] = await Promise.all([
    repository.pruneEvents(config.RUN_EVENT_RETENTION_DAYS),
    repository.pruneTitleJobs(config.TITLE_JOB_RETENTION_DAYS),
    repository.pruneThreadEvents(config.THREAD_EVENT_RETENTION_DAYS),
    repository.pruneMessages(config.MESSAGE_RETENTION_DAYS),
  ]);
  const purgedThreads = await repository.purgeDeletedThreads(config.DELETED_THREAD_RETENTION_DAYS);
  const prunedRuns = await repository.pruneRuns(config.RUN_RETENTION_DAYS);
  console.log(JSON.stringify({
    level: "info",
    message: "run_reconciliation_complete",
    scanned: staleRuns.length,
    interrupted,
    prunedEvents,
    prunedTitleJobs,
    prunedThreadEvents,
    prunedMessages,
    prunedRuns,
    purgedThreads,
  }));
} finally {
  await Promise.all([pool.end(), redis.quit()]);
}
