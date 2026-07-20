import type { BaseEvent } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { Redis } from "ioredis";
import { Observable, ReplaySubject, type Subscription } from "rxjs";
import { randomUUID } from "node:crypto";
import { currentPrincipal, type Principal } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import type { AgentRegistry, RunStore, ThreadStore } from "./ports.js";

type ActiveRun = {
  subscription: Subscription | null;
  abort: () => void;
  token: string;
  runId: string;
  agentId: string;
  heartbeat: NodeJS.Timeout;
  finalize: (status: "completed" | "failed" | "cancelled", error?: Error) => Promise<void>;
};

function isInternalTitleMessageEvent(event: BaseEvent): boolean {
  if (!["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"].includes(event.type)) {
    return false;
  }
  const rawEvent = (event as BaseEvent & {
    rawEvent?: { metadata?: { langgraph_node?: unknown } };
  }).rawEvent;
  return rawEvent?.metadata?.langgraph_node === "title";
}

function rawChunkMessageId(event: BaseEvent): string | undefined {
  const value = event as BaseEvent & {
    rawEvent?: { data?: { chunk?: { id?: unknown } } };
  };
  const id = value.rawEvent?.data?.chunk?.id;
  return typeof id === "string" ? id : undefined;
}

function repairMessageId(event: BaseEvent): BaseEvent {
  if (!["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"].includes(event.type)) {
    return event;
  }
  const chunkId = rawChunkMessageId(event);
  const currentId = (event as BaseEvent & { messageId?: unknown }).messageId;
  if (!chunkId || currentId === chunkId) return event;
  return { ...event, messageId: chunkId } as BaseEvent;
}

function textMessageId(event: BaseEvent): string | undefined {
  const value = event as BaseEvent & { messageId?: unknown };
  return typeof value.messageId === "string" ? value.messageId : undefined;
}

export function createEventNormalizer(): (event: BaseEvent) => BaseEvent | null {
  const started = new Set<string>();
  const completed = new Set<string>();
  let runFinished = false;
  return (event) => {
    if (runFinished) return null;
    const repaired = repairMessageId(event);
    if (isInternalTitleMessageEvent(repaired)) return null;
    const id = textMessageId(repaired);
    if (repaired.type === "TEXT_MESSAGE_START" && id) {
      if (started.has(id) || completed.has(id)) return null;
      started.add(id);
    } else if (repaired.type === "TEXT_MESSAGE_CONTENT" && id) {
      if (!started.has(id)) return null;
    } else if (repaired.type === "TEXT_MESSAGE_END" && id) {
      if (!started.has(id) || completed.has(id)) return null;
      started.delete(id);
      completed.add(id);
    }
    if (repaired.type === "RUN_FINISHED" || repaired.type === "RUN_ERROR") runFinished = true;
    return repaired;
  };
}

export function createThreadEventNormalizer(): (key: string, event: BaseEvent) => BaseEvent | null {
  const normalizers = new Map<string, ReturnType<typeof createEventNormalizer>>();
  return (key, event) => {
    const separator = key.indexOf(":");
    const runId = separator >= 0 ? key.slice(0, separator) : key;
    let normalize = normalizers.get(runId);
    if (!normalize) {
      normalize = createEventNormalizer();
      normalizers.set(runId, normalize);
    }
    return normalize(event);
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function runErrorEvent(error: Error): BaseEvent {
  return {
    type: "RUN_ERROR",
    message: error.message || "Agent run failed",
  } as BaseEvent;
}

export function createBlockingStreamReader(redis: Redis): Redis {
  // Blocking Redis commands monopolize their connection. Keep XREAD off the
  // command connection used for locks, heartbeats, and event publication.
  return redis.duplicate({ maxRetriesPerRequest: null });
}

export function isDurableFlushEvent(event: BaseEvent): boolean {
  return event.type === "TEXT_MESSAGE_END"
    || event.type === "TOOL_CALL_END"
    || event.type === "TOOL_CALL_RESULT"
    || event.type === "RUN_FINISHED"
    || event.type === "RUN_ERROR"
    || event.type === "CUSTOM";
}

export class DurableAgentRunner extends AgentRunner {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly counters = { eventBatches: 0, eventsPersisted: 0, batchFailures: 0, capacityRejected: 0 };

  constructor(
    private readonly repository: RunStore & Pick<ThreadStore, "getThread">,
    private readonly redis: Redis,
    private readonly config: RuntimeConfig,
    private readonly agentRegistry?: AgentRegistry,
  ) {
    super();
  }

  private lockKey(threadId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:lock:${threadId}`;
  }

  private cancelKey(threadId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:cancel:${threadId}`;
  }

  private streamKey(threadId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:events:${threadId}`;
  }

  private semaphoreKey(agentId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:capacity:${agentId}`;
  }

  private async acquireAgentSlot(agentId: string, token: string, limit: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + this.config.THREAD_LOCK_TTL_SECONDS * 1_000;
    const result = await this.redis.eval(
      `redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
       if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
       redis.call('zadd', KEYS[1], ARGV[2], ARGV[4])
       redis.call('expire', KEYS[1], ARGV[5])
       return 1`,
      1, this.semaphoreKey(agentId), now, expiresAt, limit, token,
      this.config.THREAD_LOCK_TTL_SECONDS,
    );
    return Number(result) === 1;
  }

  private async releaseAgentSlot(agentId: string, token: string): Promise<void> {
    await this.redis.zrem(this.semaphoreKey(agentId), token);
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>();
    const principal = currentPrincipal();
    void this.startRun(request, subject, principal).catch((error: unknown) => {
      const normalized = normalizeError(error);
      console.error(JSON.stringify({
        level: "error",
        message: "agent_run_start_failed",
        threadId: request.threadId,
        error: normalized.message,
      }));
      subject.next(runErrorEvent(normalized));
      subject.complete();
    });
    return subject.asObservable();
  }

  private async startRun(
    request: AgentRunnerRunRequest,
    subject: ReplaySubject<BaseEvent>,
    principal: Principal,
  ): Promise<void> {
    const { threadId } = request;
    const token = randomUUID();
    const agentId = request.agent.agentId || this.config.AGENT_ID;
    const definition = await this.agentRegistry?.get(agentId);
    if (this.agentRegistry && !definition?.enabled) {
      subject.next(runErrorEvent(new Error("AGENT_NOT_CONFIGURED")));
      subject.complete();
      return;
    }
    try {
      const acquired = await this.redis.set(
        this.lockKey(threadId),
        token,
        "EX",
        this.config.THREAD_LOCK_TTL_SECONDS,
        "NX",
      );
      if (!acquired) {
        subject.next(runErrorEvent(new Error("THREAD_BUSY")));
        subject.complete();
        return;
      }
      const slotAcquired = await this.acquireAgentSlot(
        agentId,
        token,
        definition?.maxConcurrentRuns ?? this.config.AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
      );
      if (!slotAcquired) {
        this.counters.capacityRejected += 1;
        await this.releaseLock(threadId, token);
        subject.next(runErrorEvent(new Error("AGENT_CAPACITY_EXCEEDED")));
        subject.complete();
        return;
      }

      await this.redis.del(this.cancelKey(threadId));
      const runId = request.input.runId || randomUUID();
      request.input.runId = runId;
      const { run } = await this.repository.beginRun({
        threadId,
        runId,
        agentId,
        messages: request.input.messages,
        rawInput: request.input,
      });
      const input = {
        ...request.input,
        forwardedProps: {
          ...(request.input.forwardedProps ?? {}),
          threadPlatform: principal,
        },
      };
      const agent = request.agent.clone();
      const normalizeEvent = createEventNormalizer();
      let writeChain = Promise.resolve();
      let eventBuffer: BaseEvent[] = [];
      let eventBufferBytes = 0;
      let flushTimer: NodeJS.Timeout | null = null;
      let terminal = false;
      let terminalEventPublished = false;
      let finalizePromise: Promise<void> | null = null;

      const flushEvents = (): Promise<void> => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!eventBuffer.length) return writeChain;
        const batch = eventBuffer;
        eventBuffer = [];
        eventBufferBytes = 0;
        writeChain = writeChain.then(async () => {
          const persisted = await this.repository.appendEvents(run, batch);
          this.counters.eventBatches += 1;
          this.counters.eventsPersisted += persisted.length;
          const pipeline = this.redis.pipeline();
          for (const item of persisted) {
            pipeline.xadd(
              this.streamKey(threadId), "*", "key", item.key, "event", JSON.stringify(item.event),
            );
          }
          pipeline.expire(this.streamKey(threadId), this.config.REDIS_STREAM_TTL_SECONDS);
          const redisResults = await pipeline.exec();
          const redisFailure = redisResults?.find(([failure]) => failure)?.[0];
          if (redisFailure) throw redisFailure;
          for (const item of persisted) subject.next(item.event);
          if (batch.some((item) => item.type === "RUN_FINISHED" || item.type === "RUN_ERROR")) {
            terminalEventPublished = true;
          }
        });
        return writeChain;
      };

      const finalize = (
        status: "completed" | "failed" | "cancelled",
        error?: Error,
      ): Promise<void> => {
        if (finalizePromise) return finalizePromise;
        terminal = true;
        finalizePromise = (async () => {
          let terminalError = error;
          try {
            await flushEvents();
            await this.repository.finishRun(runId, status, error);
            await Promise.all([
              this.releaseLock(threadId, token),
              this.releaseAgentSlot(agentId, token),
            ]);
          } catch (failure) {
            terminalError ??= normalizeError(failure);
            console.error(JSON.stringify({
              level: "error",
              message: "agent_run_finalize_failed",
              threadId,
              runId,
              error: terminalError.message,
            }));
            try {
              await Promise.all([
                this.releaseLock(threadId, token),
                this.releaseAgentSlot(agentId, token),
              ]);
            } catch {
              // Lock TTL is the final fallback when Redis is unavailable.
            }
          } finally {
            const active = this.activeRuns.get(threadId);
            if (active?.token === token) {
              clearInterval(active.heartbeat);
              this.activeRuns.delete(threadId);
            }
          }

          if ((status !== "completed" || terminalError) && !terminalEventPublished) {
            subject.next(runErrorEvent(terminalError ?? new Error(
              status === "cancelled" ? "RUN_CANCELLED" : "RUN_FAILED",
            )));
          }
          subject.complete();
        })();
        return finalizePromise;
      };

      const publishEvent = (event: BaseEvent): void => {
        if (terminal) return;
        eventBuffer.push(event);
        eventBufferBytes += Buffer.byteLength(JSON.stringify(event));
        const force = isDurableFlushEvent(event);
        if (force || eventBuffer.length >= this.config.EVENT_BATCH_MAX_SIZE
          || eventBufferBytes >= this.config.EVENT_BATCH_MAX_BYTES) {
          void flushEvents().catch((failure: unknown) => {
            this.counters.batchFailures += 1;
            const normalized = normalizeError(failure);
            agent.abortRun();
            void finalize("failed", normalized);
          });
        } else if (!flushTimer) {
          flushTimer = setTimeout(() => void flushEvents().catch((failure: unknown) => {
          this.counters.batchFailures += 1;
          const normalized = normalizeError(failure);
          agent.abortRun();
          void finalize("failed", normalized);
          }), this.config.EVENT_BATCH_MAX_DELAY_MS);
          flushTimer.unref();
        }
      };

      const abort = agent.abortRun.bind(agent);
      const heartbeat = setInterval(() => {
        void this.heartbeat(threadId, token).catch((failure: unknown) => {
          const current = this.activeRuns.get(threadId);
          if (current?.token !== token) return;
          current.abort();
          current.subscription?.unsubscribe();
          void current.finalize("failed", normalizeError(failure));
        });
      }, Math.min(10_000, (this.config.THREAD_LOCK_TTL_SECONDS * 1000) / 3));
      heartbeat.unref();
      const active: ActiveRun = {
        subscription: null,
        abort,
        token,
        runId,
        agentId,
        heartbeat,
        finalize,
      };
      this.activeRuns.set(threadId, active);

      const subscription = agent.run(input).subscribe({
        next: (event: BaseEvent) => {
          const normalizedEvent = normalizeEvent(event);
          if (!normalizedEvent) return;
          publishEvent(normalizedEvent);
        },
        error: (error: unknown) => {
          const normalized = normalizeError(error);
          void finalize("failed", normalized);
        },
        complete: () => {
          void finalize("completed");
        },
      });
      if (this.activeRuns.get(threadId)?.token === token) active.subscription = subscription;
      else subscription.unsubscribe();
    } catch (error) {
      try {
        await Promise.all([
          this.releaseLock(threadId, token),
          this.releaseAgentSlot(agentId, token),
        ]);
      } catch {
        // Lock TTL is the final fallback when Redis is unavailable.
      }
      subject.next(runErrorEvent(normalizeError(error)));
      subject.complete();
    }
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let stopped = false;
      const streamReader = createBlockingStreamReader(this.redis);
      void (async () => {
        if (!await this.repository.getThread(request.threadId)) throw new Error("THREAD_NOT_FOUND");
        const streamKey = this.streamKey(request.threadId);
        const boundary = await this.redis.xrevrange(streamKey, "+", "-", "COUNT", 1);
        let redisCursor = boundary[0]?.[0] ?? "0-0";
        const persisted = await this.repository.loadEvents(request.threadId);
        const normalizeEvent = createThreadEventNormalizer();
        const seen = new Set(persisted.map((item) => item.key));
        const finishedRuns = new Set<string>();
        for (const item of persisted) {
          if (stopped) return;
          const event = normalizeEvent(item.key, item.event);
          if (!event) continue;
          const runId = item.key.split(":", 1)[0] ?? item.key;
          if (event.type === "RUN_FINISHED") finishedRuns.add(runId);
          if (event.type === "CUSTOM" && finishedRuns.has(runId)) continue;
          subscriber.next(event);
        }

        while (!stopped) {
          const xread = streamReader.xread.bind(streamReader) as (...args: Array<string | number>) => Promise<
            Array<[string, Array<[string, string[]]>]> | null
          >;
          const batches = await xread(
            "BLOCK",
            1_000,
            "COUNT",
            100,
            "STREAMS",
            streamKey,
            redisCursor,
          );
          if (batches) {
            for (const [, entries] of batches) {
              for (const [id, fields] of entries) {
                redisCursor = id;
                const values = Object.fromEntries(
                  Array.from({ length: fields.length / 2 }, (_, index) => [
                    fields[index * 2]!,
                    fields[index * 2 + 1]!,
                  ]),
                );
                if (!values.key || !values.event || seen.has(values.key)) continue;
                seen.add(values.key);
                const event = normalizeEvent(values.key, JSON.parse(values.event) as BaseEvent);
                if (!event) continue;
                const runId = values.key.split(":", 1)[0] ?? values.key;
                if (event.type === "RUN_FINISHED") finishedRuns.add(runId);
                if (event.type === "CUSTOM" && finishedRuns.has(runId)) continue;
                subscriber.next(event);
              }
            }
          }
          if (!(await this.isRunning({ threadId: request.threadId }))) {
            subscriber.complete();
            return;
          }
        }
      })().catch((error: unknown) => {
        if (!stopped) subscriber.error(error);
      });
      return () => {
        stopped = true;
        streamReader.disconnect();
      };
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    if (!await this.repository.getThread(request.threadId)) throw new Error("THREAD_NOT_FOUND");
    if (await this.redis.exists(this.lockKey(request.threadId))) return true;
    return this.repository.isRunning(request.threadId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    if (!await this.repository.getThread(request.threadId)) throw new Error("THREAD_NOT_FOUND");
    await this.redis.set(
      this.cancelKey(request.threadId),
      "1",
      "EX",
      this.config.THREAD_LOCK_TTL_SECONDS,
    );
    const active = this.activeRuns.get(request.threadId);
    if (active) {
      active.abort();
      active.subscription?.unsubscribe();
      await active.finalize("cancelled", new Error("RUN_CANCELLED"));
    } else {
      await this.repository.cancelActiveRun(request.threadId);
    }
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.activeRuns.values()).map(async (active) => {
      active.abort();
      active.subscription?.unsubscribe();
      await active.finalize("cancelled", new Error("RUNTIME_SHUTDOWN"));
    }));
  }

  metrics(): Readonly<typeof this.counters> {
    return this.counters;
  }

  private async heartbeat(threadId: string, token: string): Promise<void> {
    if (await this.redis.exists(this.cancelKey(threadId))) {
      const active = this.activeRuns.get(threadId);
      if (active?.token === token) {
        active.abort();
        active.subscription?.unsubscribe();
        await active.finalize("cancelled", new Error("RUN_CANCELLED"));
      }
      return;
    }
    await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then
         return redis.call('expire', KEYS[1], ARGV[2])
       end
       return 0`,
      1,
      this.lockKey(threadId),
      token,
      String(this.config.THREAD_LOCK_TTL_SECONDS),
    );
    const active = this.activeRuns.get(threadId);
    if (active?.token === token) {
      await this.redis.zadd(
        this.semaphoreKey(active.agentId),
        Date.now() + this.config.THREAD_LOCK_TTL_SECONDS * 1_000,
        token,
      );
      await this.redis.expire(
        this.semaphoreKey(active.agentId),
        this.config.THREAD_LOCK_TTL_SECONDS,
      );
    }
  }

  private async releaseLock(threadId: string, token: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then
         return redis.call('del', KEYS[1])
       end
       return 0`,
      1,
      this.lockKey(threadId),
      token,
    );
  }
}
