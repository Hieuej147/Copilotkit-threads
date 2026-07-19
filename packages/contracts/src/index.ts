import { z } from "zod";

export const THREAD_TITLE_UPDATED_EVENT = "thread.title.updated" as const;

export const threadStatusSchema = z.enum(["active", "archived", "deleted"]);
export const titleStatusSchema = z.enum([
  "pending",
  "generating",
  "generated",
  "fallback",
  "manual",
]);

export const threadSchema = z.object({
  id: z.string().uuid(),
  namespace: z.string(),
  agentId: z.string(),
  title: z.string(),
  titleStatus: titleStatusSchema,
  status: threadStatusSchema,
  messageCount: z.number().int().nonnegative(),
  lastMessagePreview: z.string().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
});

export const threadTitleUpdatedSchema = z.object({
  threadId: z.string().uuid(),
  title: z.string().min(1).max(160),
  version: z.number().int().positive().default(1),
  model: z.string().optional(),
});

export const threadMessageSchema = z.object({
  id: z.string(),
  runId: z.string().uuid().nullable(),
  sequence: z.coerce.number().int().positive(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  kind: z.enum(["text", "tool_call", "tool_result", "activity"]),
  content: z.unknown(),
  status: z.enum(["streaming", "completed", "failed"]),
  toolCallId: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  createdAt: z.coerce.date().transform((value) => value.toISOString()).or(z.string()),
  updatedAt: z.coerce.date().transform((value) => value.toISOString()).or(z.string()),
});

export const threadPageSchema = z.object({
  items: z.array(threadSchema),
  nextCursor: z.string().nullable(),
  eventCursor: z.string().regex(/^\d+$/),
});

export const threadMessagePageSchema = z.object({
  items: z.array(threadMessageSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const threadEventTypeSchema = z.enum([
  "thread.created",
  "thread.updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
]);

export const threadEventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  type: threadEventTypeSchema,
  thread: threadSchema,
  occurredAt: z.string(),
});

export const createThreadSchema = z.object({
  requestId: z.string().uuid(),
  agentId: z.string().min(1).max(100).optional(),
});

export const renameThreadSchema = z.object({
  title: z.string().trim().min(1).max(160),
});

export type AgentThread = z.infer<typeof threadSchema>;
export type ThreadTitleUpdated = z.infer<typeof threadTitleUpdatedSchema>;
export type ThreadMessage = z.infer<typeof threadMessageSchema>;
export type ThreadPage = z.infer<typeof threadPageSchema>;
export type ThreadMessagePage = z.infer<typeof threadMessagePageSchema>;
export type ThreadEvent = z.infer<typeof threadEventSchema>;
export type ThreadEventType = z.infer<typeof threadEventTypeSchema>;
