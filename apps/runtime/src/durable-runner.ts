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
import { ThreadRepository } from "./repository.js";

type ActiveRun = {
  subscription: Subscription | null;
  abort: () => void;
  token: string;
  runId: string;
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
    if (repaired.type === "RUN_FINISHED") runFinished = true;
    return repaired;
  };
}

export class DurableAgentRunner extends AgentRunner {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    private readonly repository: ThreadRepository,
    private readonly redis: Redis,
    private readonly config: RuntimeConfig,
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

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>();
    const principal = currentPrincipal();
    void this.startRun(request, subject, principal);
    return subject.asObservable();
  }

  private async startRun(
    request: AgentRunnerRunRequest,
    subject: ReplaySubject<BaseEvent>,
    principal: Principal,
  ): Promise<void> {
    const { threadId } = request;
    const token = randomUUID();
    const acquired = await this.redis.set(
      this.lockKey(threadId),
      token,
      "EX",
      this.config.THREAD_LOCK_TTL_SECONDS,
      "NX",
    );
    if (!acquired) {
      subject.error(new Error("THREAD_BUSY"));
      return;
    }

    await this.redis.del(this.cancelKey(threadId));
    const runId = request.input.runId || randomUUID();
    request.input.runId = runId;

    try {
      const { run } = await this.repository.beginRun({
        threadId,
        runId,
        agentId: request.agent.agentId || this.config.AGENT_ID,
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
      let terminal = false;
      let finalizePromise: Promise<void> | null = null;

      const finalize = (
        status: "completed" | "failed" | "cancelled",
        error?: Error,
      ): Promise<void> => {
        if (finalizePromise) return finalizePromise;
        terminal = true;
        finalizePromise = (async () => {
          try {
            await writeChain;
          } catch {
            // The original persistence error is reported through `error`.
          }
          await this.repository.finishRun(runId, status, error);
          await this.releaseLock(threadId, token);
          const active = this.activeRuns.get(threadId);
          if (active?.token === token) {
            clearInterval(active.heartbeat);
            this.activeRuns.delete(threadId);
          }
          if (status === "completed") subject.complete();
          else subject.error(error ?? new Error(status === "cancelled" ? "RUN_CANCELLED" : "RUN_FAILED"));
        })();
        return finalizePromise;
      };

      const publishEvent = (event: BaseEvent): void => {
        if (terminal) return;
        writeChain = writeChain.then(async () => {
            const persisted = await this.repository.appendEvent(run, event);
            await this.redis.xadd(
              this.streamKey(threadId),
              "*",
              "key",
              persisted.key,
              "event",
              JSON.stringify(event),
            );
            await this.redis.expire(this.streamKey(threadId), this.config.REDIS_STREAM_TTL_SECONDS);
            subject.next(event);
          });
        void writeChain.catch((failure: unknown) => {
          const normalized = failure instanceof Error ? failure : new Error(String(failure));
          agent.abortRun();
          void finalize("failed", normalized);
        });
      };

      const abort = agent.abortRun.bind(agent);
      const heartbeat = setInterval(() => {
        void this.heartbeat(threadId, token);
      }, Math.min(10_000, (this.config.THREAD_LOCK_TTL_SECONDS * 1000) / 3));
      heartbeat.unref();
      const active: ActiveRun = {
        subscription: null,
        abort,
        token,
        runId,
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
          const normalized = error instanceof Error ? error : new Error(String(error));
          void finalize("failed", normalized);
        },
        complete: () => {
          void finalize("completed").catch((error: unknown) => subject.error(error));
        },
      });
      if (this.activeRuns.get(threadId)?.token === token) active.subscription = subscription;
      else subscription.unsubscribe();
    } catch (error) {
      await this.releaseLock(threadId, token);
      subject.error(error);
    }
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let stopped = false;
      void (async () => {
        if (!await this.repository.getThread(request.threadId)) throw new Error("THREAD_NOT_FOUND");
        const streamKey = this.streamKey(request.threadId);
        const boundary = await this.redis.xrevrange(streamKey, "+", "-", "COUNT", 1);
        let redisCursor = boundary[0]?.[0] ?? "0-0";
        const persisted = await this.repository.loadEvents(request.threadId);
        const normalizeEvent = createEventNormalizer();
        const seen = new Set(persisted.map((item) => item.key));
        const finishedRuns = new Set<string>();
        for (const item of persisted) {
          if (stopped) return;
          const event = normalizeEvent(item.event);
          if (!event) continue;
          const runId = item.key.split(":", 1)[0] ?? item.key;
          if (event.type === "RUN_FINISHED") finishedRuns.add(runId);
          if (event.type === "CUSTOM" && finishedRuns.has(runId)) continue;
          subscriber.next(event);
        }

        while (!stopped) {
          const xread = this.redis.xread.bind(this.redis) as (...args: Array<string | number>) => Promise<
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
                const event = normalizeEvent(JSON.parse(values.event) as BaseEvent);
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
      })().catch((error: unknown) => subscriber.error(error));
      return () => {
        stopped = true;
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
