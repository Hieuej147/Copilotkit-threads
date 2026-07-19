import { Router, type Request, type Response } from "express";
import { Redis } from "ioredis";
import {
  createThreadSchema,
  renameThreadSchema,
  threadMessagePageSchema,
  threadPageSchema,
  threadSchema,
} from "@threads/contracts";
import { z } from "zod";
import { currentPrincipal } from "./auth.js";
import { ThreadRepository, type PublishedThreadEvent } from "./repository.js";
import { publishThreadEvent, threadEventChannel } from "./thread-events.js";

const uuid = z.string().uuid();
const eventId = z.string().regex(/^\d+$/);

function decodeCursor(value: unknown): { at: string; id: string } | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return z.object({ at: z.string().datetime(), id: uuid }).parse(parsed);
  } catch {
    throw new Error("INVALID_CURSOR");
  }
}

async function notify(redis: Redis, namespace: string, event: PublishedThreadEvent | null): Promise<void> {
  await publishThreadEvent(redis, namespace, event).catch((error: unknown) => {
    console.error(JSON.stringify({ level: "warn", message: "thread_event_publish_failed", error: String(error) }));
  });
}

export function createThreadApi(repository: ThreadRepository, redis: Redis, namespace: string): Router {
  const router = Router();

  router.post("/threads", async (request: Request, response: Response) => {
    const body = createThreadSchema.parse(request.body ?? {});
    const result = await repository.createThread(body.requestId, body.agentId);
    await notify(redis, namespace, result.event);
    response.status(result.created ? 201 : 200).json(threadSchema.parse(result.thread));
  });

  router.get("/threads", async (request: Request, response: Response) => {
    const query = z.object({
      agentId: z.string().optional(),
      status: z.enum(["active", "archived"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(request.query);
    response.json(threadPageSchema.parse(await repository.listThreads({
      ...query,
      before: decodeCursor(request.query.cursor),
    })));
  });

  router.get("/thread-events", async (request: Request, response: Response) => {
    const principal = currentPrincipal();
    const initialId = eventId.parse(
      request.header("last-event-id") ?? request.query.after ?? "0",
    );
    const subscriber = redis.duplicate();
    const channel = threadEventChannel(namespace, principal.tenantId, principal.userId);
    let cursor = initialId;
    let closed = false;
    let pump = Promise.resolve();

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const catchUp = (): void => {
      pump = pump.then(async () => {
        while (!closed) {
          const events = await repository.listThreadEvents(cursor, 200, principal);
          if (!events.length) return;
          for (const event of events) {
            if (closed || BigInt(event.id) <= BigInt(cursor)) continue;
            response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.id;
          }
          if (events.length < 200) return;
        }
      }).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "warn", message: "thread_event_stream_failed", error: String(error) }));
        response.end();
      });
    };

    subscriber.on("message", () => catchUp());
    subscriber.on("error", (error) => {
      console.error(JSON.stringify({ level: "warn", message: "thread_event_subscriber_error", error: String(error) }));
    });
    await subscriber.subscribe(channel);
    catchUp();
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();

    request.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      subscriber.disconnect();
    });
  });

  router.get("/threads/:threadId", async (request: Request, response: Response) => {
    const thread = await repository.getThread(uuid.parse(request.params.threadId));
    if (!thread) return response.status(404).json({ error: "THREAD_NOT_FOUND" });
    return response.json(threadSchema.parse(thread));
  });

  router.get("/threads/:threadId/messages", async (request: Request, response: Response) => {
    const threadId = uuid.parse(request.params.threadId);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      after: z.coerce.number().int().nonnegative().default(0),
    }).parse(request.query);
    if (!await repository.getThread(threadId)) {
      return response.status(404).json({ error: "THREAD_NOT_FOUND" });
    }
    const items = await repository.listMessages(threadId, query.limit, query.after);
    const last = items.at(-1) as { sequence?: number } | undefined;
    return response.json(threadMessagePageSchema.parse({
      items,
      nextCursor: items.length === query.limit ? last?.sequence ?? null : null,
    }));
  });

  router.patch("/threads/:threadId", async (request: Request, response: Response) => {
    const body = renameThreadSchema.parse(request.body);
    const result = await repository.renameThread(uuid.parse(request.params.threadId), body.title);
    if (!result) return response.status(404).json({ error: "THREAD_NOT_FOUND" });
    await notify(redis, namespace, result.event);
    return response.json(threadSchema.parse(result.thread));
  });

  router.post("/threads/:threadId/archive", async (request: Request, response: Response) => {
    const result = await repository.setStatus(uuid.parse(request.params.threadId), "archived");
    if (!result) return response.status(404).json({ error: "THREAD_NOT_FOUND" });
    await notify(redis, namespace, result.event);
    return response.json(threadSchema.parse(result.thread));
  });

  router.post("/threads/:threadId/unarchive", async (request: Request, response: Response) => {
    const result = await repository.setStatus(uuid.parse(request.params.threadId), "active");
    if (!result) return response.status(404).json({ error: "THREAD_NOT_FOUND" });
    await notify(redis, namespace, result.event);
    return response.json(threadSchema.parse(result.thread));
  });

  router.delete("/threads/:threadId", async (request: Request, response: Response) => {
    const result = await repository.setStatus(uuid.parse(request.params.threadId), "deleted");
    if (!result) return response.status(404).json({ error: "THREAD_NOT_FOUND" });
    await notify(redis, namespace, result.event);
    return response.status(204).send();
  });

  return router;
}
