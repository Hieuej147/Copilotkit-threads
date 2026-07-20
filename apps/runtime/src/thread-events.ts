import type { Redis } from "ioredis";
import type { PublishedThreadEvent } from "./types.js";

export function threadEventChannel(namespace: string, tenantId: string, ownerId: string): string {
  return `agent:${namespace}:thread-events:${tenantId}:${ownerId}`;
}

export async function publishThreadEvent(
  redis: Redis,
  namespace: string,
  published: PublishedThreadEvent | null,
): Promise<void> {
  if (!published) return;
  await redis.publish(
    threadEventChannel(namespace, published.tenantId, published.ownerId),
    published.event.id,
  );
}
