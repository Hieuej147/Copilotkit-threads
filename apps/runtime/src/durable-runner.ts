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
import { runCancelChannel, runEventChannel } from "./run-events.js";
import type { RunRecord } from "./types.js";

type ActiveRun = {
  subscription: Subscription | null;
  abort: () => void;
  token: string;
  run: RunRecord;
  agentId: string;
  heartbeat: NodeJS.Timeout;
  finalize: (status: "completed" | "failed" | "cancelled" | "interrupted", error?: Error) => Promise<void>;
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

export type EventNormalizer = ((event: BaseEvent) => BaseEvent | null) & {
  terminalStatus(): "completed" | "failed" | null;
  terminalError(): Error | undefined;
  validateComplete(): Error | null;
};

export function createEventNormalizer(): EventNormalizer {
  const started = new Set<string>();
  const completed = new Set<string>();
  let terminal: "completed" | "failed" | null = null;
  let failure: Error | undefined;
  const normalize = ((event: BaseEvent) => {
    if (terminal) return null;
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
    if (repaired.type === "RUN_FINISHED") terminal = "completed";
    if (repaired.type === "RUN_ERROR") {
      terminal = "failed";
      const message = (repaired as BaseEvent & { message?: unknown }).message;
      failure = new Error(typeof message === "string" && message ? message : "Agent run failed");
    }
    return repaired;
  }) as EventNormalizer;
  normalize.terminalStatus = () => terminal;
  normalize.terminalError = () => failure;
  normalize.validateComplete = () => {
    if (started.size) return new Error("AGENT_PROTOCOL_ERROR");
    if (!terminal) return new Error("AGENT_PROTOCOL_ERROR");
    return null;
  };
  return normalize;
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
  private readonly cancelSubscriber: Redis;
  private readonly counters = { eventBatches: 0, eventsPersisted: 0, batchFailures: 0, capacityRejected: 0 };

  constructor(
    private readonly repository: RunStore & Pick<ThreadStore, "getThread">,
    private readonly redis: Redis,
    private readonly config: RuntimeConfig,
    private readonly agentRegistry?: AgentRegistry,
  ) {
    super();
    this.cancelSubscriber = redis.duplicate({ maxRetriesPerRequest: null });
    this.cancelSubscriber.on("message", (_channel, threadId) => {
      const active = this.activeRuns.get(threadId);
      if (!active) return;
      active.abort();
      active.subscription?.unsubscribe();
      void active.finalize("cancelled", new Error("RUN_CANCELLED"));
    });
    this.cancelSubscriber.on("error", (error) => {
      console.warn(JSON.stringify({
        level: "warn",
        message: "run_cancel_subscriber_error",
        error: String(error),
      }));
    });
    void this.cancelSubscriber.subscribe(runCancelChannel(config.AGENT_NAMESPACE)).catch((error: unknown) => {
      console.warn(JSON.stringify({
        level: "warn",
        message: "run_cancel_subscribe_failed",
        error: String(error),
      }));
    });
  }

  private lockKey(threadId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:lock:${threadId}`;
  }

  private cancelKey(threadId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:cancel:${threadId}`;
  }

  private fenceKey(threadId: string): string {
    return `agent:${this.config.AGENT_NAMESPACE}:fence:${threadId}`;
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
      const fencingToken = await this.redis.incr(this.fenceKey(threadId));
      const runId = request.input.runId || randomUUID();
      request.input.runId = runId;
      const { run, created } = await this.repository.beginRun({
        principal,
        threadId,
        runId,
        agentId,
        messages: request.input.messages,
        rawInput: request.input,
        fencingToken,
      });
      if (!created) {
        const replay = await this.repository.loadEvents(principal, threadId);
        for (const item of replay) {
          if (item.key.startsWith(`${run.id}:`)) subject.next(item.event);
        }
        await Promise.all([
          this.releaseLock(threadId, token),
          this.releaseAgentSlot(agentId, token),
        ]);
        subject.complete();
        return;
      }
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
          if (persisted.length) {
            await this.redis.publish(
              runEventChannel(this.config.AGENT_NAMESPACE, threadId),
              persisted.at(-1)!.key,
            ).catch((error: unknown) => {
              console.warn(JSON.stringify({
                level: "warn",
                message: "run_event_wakeup_failed",
                threadId,
                error: String(error),
              }));
            });
          }
          for (const item of persisted) subject.next(item.event);
          if (batch.some((item) => item.type === "RUN_FINISHED" || item.type === "RUN_ERROR")) {
            terminalEventPublished = true;
          }
        });
        return writeChain;
      };

      const finalize = (
        status: "completed" | "failed" | "cancelled" | "interrupted",
        error?: Error,
      ): Promise<void> => {
        if (finalizePromise) return finalizePromise;
        terminal = true;
        finalizePromise = (async () => {
          let terminalError = error;
          try {
            await flushEvents();
            await this.repository.finishRun(run, status, error);
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
        run,
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
          const protocolError = normalizeEvent.validateComplete();
          if (protocolError) {
            void finalize("failed", protocolError);
            return;
          }
          const status = normalizeEvent.terminalStatus() === "failed" ? "failed" : "completed";
          void finalize(status, normalizeEvent.terminalError());
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
    const principal = currentPrincipal();
    return new Observable<BaseEvent>((subscriber) => {
      let stopped = false;
      let completed = false;
      const wakeups = this.redis.duplicate({ maxRetriesPerRequest: null });
      const channel = runEventChannel(this.config.AGENT_NAMESPACE, request.threadId);
      const seen = new Set<string>();
      const normalizeEvent = createThreadEventNormalizer();
      const finishedRuns = new Set<string>();
      let pumpChain = Promise.resolve();

      const pump = (): Promise<void> => {
        pumpChain = pumpChain.then(async () => {
          if (stopped || completed) return;
          const persisted = await this.repository.loadEvents(principal, request.threadId);
          for (const item of persisted) {
            if (stopped || seen.has(item.key)) continue;
            seen.add(item.key);
            const event = normalizeEvent(item.key, item.event);
            if (!event) continue;
            const runId = item.key.split(":", 1)[0] ?? item.key;
            if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
              finishedRuns.add(runId);
            }
            if (event.type === "CUSTOM" && finishedRuns.has(runId)) continue;
            subscriber.next(event);
          }
          if (!(await this.repository.isRunning(principal, request.threadId))) {
            completed = true;
            subscriber.complete();
          }
        });
        return pumpChain;
      };

      void (async () => {
        if (!await this.repository.getThread(principal, request.threadId)) throw new Error("THREAD_NOT_FOUND");
        wakeups.on("message", () => void pump().catch((error) => subscriber.error(error)));
        await wakeups.subscribe(channel);
        await pump();
      })().catch((error: unknown) => {
        if (!stopped) subscriber.error(error);
      });
      const catchUp = setInterval(() => {
        void pump().catch((error: unknown) => {
          if (!stopped) subscriber.error(error);
        });
      }, 2_000);
      catchUp.unref();
      return () => {
        stopped = true;
        clearInterval(catchUp);
        wakeups.disconnect();
      };
    });
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const principal = currentPrincipal();
    if (!await this.repository.getThread(principal, request.threadId)) throw new Error("THREAD_NOT_FOUND");
    if (await this.redis.exists(this.lockKey(request.threadId))) return true;
    return this.repository.isRunning(principal, request.threadId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const principal = currentPrincipal();
    if (!await this.repository.getThread(principal, request.threadId)) throw new Error("THREAD_NOT_FOUND");
    await this.redis.set(
      this.cancelKey(request.threadId),
      "1",
      "EX",
      this.config.THREAD_LOCK_TTL_SECONDS,
    );
    await this.redis.publish(runCancelChannel(this.config.AGENT_NAMESPACE), request.threadId);
    const active = this.activeRuns.get(request.threadId);
    if (active) {
      active.abort();
      active.subscription?.unsubscribe();
      await active.finalize("cancelled", new Error("RUN_CANCELLED"));
    } else {
      await this.repository.cancelActiveRun(principal, request.threadId);
    }
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all(Array.from(this.activeRuns.values()).map(async (active) => {
      active.abort();
      active.subscription?.unsubscribe();
      await active.finalize("interrupted", new Error("RUNTIME_SHUTDOWN"));
    }));
    this.cancelSubscriber.disconnect();
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
    const renewed = await this.redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then
         return redis.call('expire', KEYS[1], ARGV[2])
       end
       return 0`,
      1,
      this.lockKey(threadId),
      token,
      String(this.config.THREAD_LOCK_TTL_SECONDS),
    );
    if (Number(renewed) !== 1) throw new Error("RUN_FENCE_LOST");
    const active = this.activeRuns.get(threadId);
    if (active?.token === token) {
      if (!await this.repository.heartbeatRun(active.run)) throw new Error("RUN_FENCE_LOST");
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
