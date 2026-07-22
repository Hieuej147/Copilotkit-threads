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
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const messagePartTypeSchema = z.enum([
  "text",
  "tool_call",
  "tool_result",
  "activity",
  "interrupt",
]);

export const messagePartSchema = z.object({
  index: z.number().int().nonnegative(),
  type: messagePartTypeSchema,
  content: z.unknown(),
  status: z.enum(["streaming", "completed", "failed"]),
  toolCallId: z.string().nullable(),
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
  parts: z.array(messagePartSchema).default([]),
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
  agentId: z.string().min(1).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}).refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16 * 1024,
    "metadata must not exceed 16 KiB",
  ),
});

export const idempotencyKeySchema = z.string().trim().min(1).max(128)
  .regex(/^[\x21-\x7E]+$/, "idempotency key must contain visible ASCII characters only");

export const errorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "INVALID_CURSOR",
  "AUTH_PRINCIPAL_REQUIRED",
  "AUTH_TOKEN_INVALID",
  "RATE_LIMITED",
  "ADMIN_ROLE_REQUIRED",
  "AGENT_NOT_FOUND",
  "THREAD_NOT_FOUND",
  "THREAD_BUSY",
  "THREAD_VERSION_REQUIRED",
  "THREAD_VERSION_CONFLICT",
  "THREAD_AGENT_MISMATCH",
  "AGENT_NOT_CONFIGURED",
  "AGENT_CAPACITY_EXCEEDED",
  "AGENT_PROTOCOL_ERROR",
  "AGENT_CONFIGURATION_INVALID",
  "RUN_CANCELLED",
  "RUN_INTERRUPTED",
  "INTERNAL_ERROR",
]);

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

const credentialReferenceSchema = z.string().max(512).refine((value) => {
  if (/^env:[A-Z][A-Z0-9_]{0,127}$/.test(value)) return true;
  if (!value.startsWith("file:")) return false;
  const path = value.slice(5);
  return path.length > 0 && path.split("/").every((part) =>
    part !== "." && part !== ".." && /^[a-zA-Z0-9._-]+$/.test(part));
}, "credential reference must use env:NAME or a safe file:relative/path");

export const agentDefinitionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().min(1).max(100),
  displayName: z.string().min(1).max(160),
  endpointUrl: z.string().url(),
  healthUrl: z.string().url().nullable(),
  credentialRef: credentialReferenceSchema.nullable(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  maxConcurrentRuns: z.number().int().min(1).max(10_000),
  titleEnabled: z.boolean(),
  titleBaseUrl: z.string().url().nullable(),
  titleModel: z.string().nullable(),
  titleCredentialRef: credentialReferenceSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const upsertAgentDefinitionSchema = agentDefinitionSchema.pick({
  displayName: true,
  endpointUrl: true,
  credentialRef: true,
  enabled: true,
  timeoutMs: true,
  maxConcurrentRuns: true,
  titleEnabled: true,
}).extend({
  healthUrl: z.string().url().nullable().optional(),
  titleBaseUrl: z.string().url().nullable().optional(),
  titleModel: z.string().min(1).max(160).nullable().optional(),
  titleCredentialRef: z.string().nullable().optional(),
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
export type MessagePart = z.infer<typeof messagePartSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type UpsertAgentDefinition = z.infer<typeof upsertAgentDefinitionSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
