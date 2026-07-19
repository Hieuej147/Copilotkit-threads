import { Redis } from "ioredis";
import type { RuntimeConfig } from "./config.js";
import { ThreadRepository, type TitleJobRecord } from "./repository.js";
import { publishThreadEvent } from "./thread-events.js";
import type { TitleWorker } from "./title-worker.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TitleQueueWorker {
  private stopped = false;
  private readonly consumer = `${process.env.HOSTNAME ?? "local"}-${process.pid}`;

  constructor(
    private readonly redis: Redis,
    private readonly repository: ThreadRepository,
    private readonly titleWorker: TitleWorker,
    private readonly config: RuntimeConfig,
  ) {}

  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        const job = await this.repository.claimTitleJob(this.consumer, this.config.TITLE_JOB_CLAIM_IDLE_MS);
        if (!job) {
          await sleep(1_000);
          continue;
        }
        await this.process(job);
      } catch (error) {
        console.error(JSON.stringify({
          level: "warn",
          message: "title_worker_dependency_retry",
          error: String(error),
        }));
        await sleep(2_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async process(job: TitleJobRecord): Promise<void> {
    try {
      const thread = await this.repository.getThreadInternal(job.threadId);
      if (!thread || thread.titleStatus !== "generating") {
        await this.repository.completeTitleJob(job.id);
        return;
      }
      const generated = await this.titleWorker.generate(job.source);
      const event = await this.repository.completeTitle(job.threadId, generated.title, generated.model);
      await publishThreadEvent(this.redis, this.config.AGENT_NAMESPACE, event);
      await this.repository.completeTitleJob(job.id);
    } catch (error) {
      await this.repository.failTitleJob(
        job.id,
        job.threadId,
        job.attempts >= this.config.TITLE_JOB_MAX_ATTEMPTS,
        String(error).slice(0, 2_000),
      );
    }
  }
}
