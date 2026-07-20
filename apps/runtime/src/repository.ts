import type { BaseEvent, Message } from "@ag-ui/client";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  type ThreadEvent,
  type ThreadEventType,
} from "@kiri_ikki/thread-contracts";
import type {
  BeginRunInput,
  OperationalMetrics,
  PersistedEvent,
  PublishedThreadEvent,
  RunRecord,
  ThreadEventRow,
  ThreadRecord,
  TitleJobRecord,
} from "./types.js";
import { currentPrincipal } from "./auth.js";
import type { AgentRegistry } from "./ports.js";

type ThreadRow = {
  id: string;
  namespace: string;
  agent_id: string;
  title: string;
  title_status: ThreadRecord["titleStatus"];
  status: ThreadRecord["status"];
  message_count: number;
  last_message_preview: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  metadata: Record<string, unknown>;
};

function mapThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    agentId: row.agent_id,
    title: row.title,
    titleStatus: row.title_status,
    status: row.status,
    messageCount: row.message_count,
    lastMessagePreview: row.last_message_preview,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    metadata: row.metadata ?? {},
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text);
      }
      return "";
    })
    .join(" ")
    .trim();
}

function messageText(message: Message): string {
  return contentText(message.content);
}

export class ThreadRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly namespace: string,
    private readonly defaultAgentId: string,
    private readonly agentRegistry?: AgentRegistry,
  ) {}

  private async appendThreadEvent(
    client: pg.PoolClient,
    thread: ThreadRecord,
    type: ThreadEventType,
    principal: { tenantId: string; userId: string },
  ): Promise<PublishedThreadEvent> {
    const result = await client.query<ThreadEventRow>(
      `INSERT INTO agent_core.agent_thread_events
         (thread_id, tenant_id, owner_id, namespace, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id::text, event_type, payload, created_at, tenant_id, owner_id`,
      [
        thread.id,
        principal.tenantId,
        principal.userId,
        this.namespace,
        type,
        JSON.stringify({ thread }),
      ],
    );
    const row = result.rows[0]!;
    return {
      tenantId: row.tenant_id,
      ownerId: row.owner_id,
      event: {
        id: row.id,
        type: row.event_type,
        thread: row.payload.thread,
        occurredAt: row.created_at.toISOString(),
      },
    };
  }

  async createThread(
    requestId: string,
    agentId = this.defaultAgentId,
    metadata: Record<string, unknown> = {},
  ): Promise<{ thread: ThreadRecord; event: PublishedThreadEvent | null; created: boolean }> {
    const principal = currentPrincipal();
    if (this.agentRegistry) {
      const agent = await this.agentRegistry.get(agentId);
      if (!agent?.enabled) throw new Error("AGENT_NOT_CONFIGURED");
    } else if (agentId !== this.defaultAgentId) {
      throw new Error("AGENT_NOT_CONFIGURED");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<ThreadRow>(
        `SELECT * FROM agent_core.agent_threads
         WHERE namespace = $1 AND tenant_id = $2 AND owner_id = $3
           AND creation_request_id = $4`,
        [this.namespace, principal.tenantId, principal.userId, requestId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { thread: mapThread(existing.rows[0]), event: null, created: false };
      }
      const result = await client.query<ThreadRow>(
        `INSERT INTO agent_core.agent_threads
           (id, namespace, agent_id, tenant_id, owner_id, creation_request_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING *`,
        [randomUUID(), this.namespace, agentId, principal.tenantId, principal.userId,
          requestId, JSON.stringify(metadata)],
      );
      const thread = mapThread(result.rows[0]!);
      const event = await this.appendThreadEvent(client, thread, "thread.created", principal);
      await client.query("COMMIT");
      return { thread, event, created: true };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        const result = await this.pool.query<ThreadRow>(
          `SELECT * FROM agent_core.agent_threads
           WHERE namespace = $1 AND tenant_id = $2 AND owner_id = $3
             AND creation_request_id = $4`,
          [this.namespace, principal.tenantId, principal.userId, requestId],
        );
        if (result.rows[0]) return { thread: mapThread(result.rows[0]), event: null, created: false };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    const principal = currentPrincipal();
    const result = await this.pool.query<ThreadRow>(
      `SELECT * FROM agent_core.agent_threads
       WHERE id = $1 AND namespace = $2 AND tenant_id = $3 AND owner_id = $4
         AND deleted_at IS NULL`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
    return result.rows[0] ? mapThread(result.rows[0]) : null;
  }

  async getThreadInternal(threadId: string): Promise<ThreadRecord | null> {
    const result = await this.pool.query<ThreadRow>(
      `SELECT * FROM agent_core.agent_threads
       WHERE id = $1 AND namespace = $2 AND deleted_at IS NULL`,
      [threadId, this.namespace],
    );
    return result.rows[0] ? mapThread(result.rows[0]) : null;
  }

  async listThreads(options: {
    agentId?: string;
    status?: "active" | "archived";
    limit: number;
    before?: { at: string; id: string };
  }): Promise<{ items: ThreadRecord[]; nextCursor: string | null; eventCursor: string }> {
    const principal = currentPrincipal();
    // Capture the event boundary before reading rows. A concurrent event may be
    // returned both in this snapshot and SSE replay, but can never be missed.
    const eventBoundary = await this.pool.query<{ id: string }>(
      `SELECT COALESCE(MAX(id), 0)::text AS id
       FROM agent_core.agent_thread_events
       WHERE tenant_id = $1 AND owner_id = $2 AND namespace = $3`,
      [principal.tenantId, principal.userId, this.namespace],
    );
    const status = options.status ?? "active";
    const agentId = options.agentId ?? this.defaultAgentId;
    const params: unknown[] = [
      this.namespace, principal.tenantId, principal.userId, agentId, status, options.limit + 1,
    ];
    let cursorClause = "";
    if (options.before) {
      params.push(options.before.at, options.before.id);
      cursorClause = "AND (last_activity_at, id) < ($7::timestamptz, $8::uuid)";
    }
    const result = await this.pool.query<ThreadRow>(
      `SELECT * FROM agent_core.agent_threads
       WHERE namespace = $1 AND tenant_id = $2 AND owner_id = $3
         AND agent_id = $4 AND status = $5 AND deleted_at IS NULL
       ${cursorClause}
       ORDER BY last_activity_at DESC, id DESC
       LIMIT $6`,
      params,
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ at: last.last_activity_at.toISOString(), id: last.id })).toString("base64url")
      : null;
    return {
      items: rows.map(mapThread),
      nextCursor,
      eventCursor: eventBoundary.rows[0]?.id ?? "0",
    };
  }

  async setStatus(
    threadId: string,
    status: "active" | "archived" | "deleted",
  ): Promise<{ thread: ThreadRecord; event: PublishedThreadEvent } | null> {
    const principal = currentPrincipal();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ThreadRow>(
        `UPDATE agent_core.agent_threads
         SET status = $5::text,
             deleted_at = CASE WHEN $5::text = 'deleted' THEN now() ELSE NULL END,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND namespace = $2 AND tenant_id = $3 AND owner_id = $4
           AND deleted_at IS NULL
         RETURNING *`,
        [threadId, this.namespace, principal.tenantId, principal.userId, status],
      );
      if (!result.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const thread = mapThread(result.rows[0]);
      const type = status === "archived" ? "thread.archived"
        : status === "active" ? "thread.unarchived"
          : "thread.deleted";
      const event = await this.appendThreadEvent(client, thread, type, principal);
      await client.query("COMMIT");
      return { thread, event };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async renameThread(
    threadId: string,
    title: string,
  ): Promise<{ thread: ThreadRecord; event: PublishedThreadEvent } | null> {
    const principal = currentPrincipal();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ThreadRow>(
        `UPDATE agent_core.agent_threads
         SET title = $5, title_status = 'manual', title_model = NULL,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND namespace = $2 AND tenant_id = $3 AND owner_id = $4
           AND deleted_at IS NULL
         RETURNING *`,
        [threadId, this.namespace, principal.tenantId, principal.userId, title],
      );
      if (!result.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE agent_core.agent_title_jobs
         SET status = 'completed', completed_at = now(), locked_at = NULL,
             locked_by = NULL, updated_at = now()
         WHERE thread_id = $1 AND status IN ('pending', 'running')`,
        [threadId],
      );
      const thread = mapThread(result.rows[0]);
      const event = await this.appendThreadEvent(client, thread, "thread.updated", principal);
      await client.query("COMMIT");
      return { thread, event };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginRun(input: BeginRunInput): Promise<{ run: RunRecord; titleRequired: boolean }> {
    const principal = currentPrincipal();
    const agentDefinition = await this.agentRegistry?.get(input.agentId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const threadResult = await client.query<ThreadRow>(
        `SELECT * FROM agent_core.agent_threads
         WHERE id = $1 AND namespace = $2 AND tenant_id = $3 AND owner_id = $4
           AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [input.threadId, this.namespace, principal.tenantId, principal.userId],
      );
      const thread = threadResult.rows[0];
      if (!thread) throw new Error("THREAD_NOT_FOUND");
      if (thread.agent_id !== input.agentId) throw new Error("THREAD_AGENT_MISMATCH");
      const firstInput = input.messages.find((message) => message.role === "user");

      // `pending` is the only state allowed to create the durable title job.
      // `fallback` means that job exhausted its retry budget.
      const titleRequired = Boolean(firstInput)
        && thread.title_status === "pending"
        && (agentDefinition?.titleEnabled ?? true);
      if (thread.title_status === "pending" && agentDefinition?.titleEnabled === false) {
        await client.query(
          `UPDATE agent_core.agent_threads SET title_status = 'fallback', updated_at = now() WHERE id = $1`,
          [input.threadId],
        );
      }
      if (titleRequired) {
        await client.query(
          `UPDATE agent_core.agent_threads
           SET title_status = 'generating', updated_at = now()
           WHERE id = $1`,
          [input.threadId],
        );
        await client.query(
          `INSERT INTO agent_core.agent_title_jobs (id, thread_id, source)
           VALUES ($1, $2, $3)
           ON CONFLICT (thread_id) DO NOTHING`,
          [randomUUID(), input.threadId, firstInput ? messageText(firstInput) : ""],
        );
      }

      await client.query(
        `INSERT INTO agent_core.agent_runs
           (id, thread_id, agent_id, client_request_id, input_message_id, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', now())`,
        [input.runId, input.threadId, input.agentId, input.runId, firstInput?.id ?? null],
      );

      let sequenceResult = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
         FROM agent_core.agent_messages WHERE thread_id = $1`,
        [input.threadId],
      );
      let sequence = Number(sequenceResult.rows[0]!.next);
      let insertedCount = 0;
      let preview: string | null = null;
      for (const message of input.messages) {
        if (!["user", "system", "assistant", "tool"].includes(message.role)) continue;
        const toolCalls = message.role === "assistant" && "toolCalls" in message
          ? message.toolCalls : undefined;
        // Tool-call assistant messages are already projected from TOOL_CALL_* events.
        // Reconnected clients send them back with no text content and a different
        // presentation ID, so inserting them again would create an empty duplicate.
        if (toolCalls?.length && !messageText(message)) continue;
        const text = messageText(message);
        const serializedContent = JSON.stringify(message.content ?? "");
        const inserted = await client.query(
          `INSERT INTO agent_core.agent_messages
             (id, thread_id, run_id, sequence, role, content, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'completed')
           ON CONFLICT (thread_id, id) DO NOTHING`,
          [message.id, input.threadId, input.runId, sequence, message.role, serializedContent],
        );
        if (inserted.rowCount) {
          await client.query(
            `INSERT INTO agent_core.agent_message_parts
               (thread_id, message_id, part_index, part_type, content, status, tool_call_id)
             VALUES ($1, $2, 0, $3, $4::jsonb, 'completed', $5)
             ON CONFLICT (thread_id, message_id, part_index) DO NOTHING`,
            [input.threadId, message.id,
              message.role === "tool" ? "tool_result" : "text",
              serializedContent,
              "toolCallId" in message ? String(message.toolCallId ?? "") || null : null],
          );
          insertedCount += 1;
          sequence += 1;
          if (message.role === "user") preview = text.slice(0, 240);
        }
      }
      if (insertedCount > 0) {
        await client.query(
          `UPDATE agent_core.agent_threads
           SET message_count = message_count + $2,
               last_message_preview = COALESCE($3, last_message_preview),
               last_activity_at = now(), updated_at = now(), version = version + 1
           WHERE id = $1`,
          [input.threadId, insertedCount, preview],
        );
      }
      await client.query("COMMIT");
      return {
        run: { id: input.runId, threadId: input.threadId, lastEventSeq: 0, status: "running" },
        titleRequired,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendEvents(run: RunRecord, events: BaseEvent[]): Promise<PersistedEvent[]> {
    if (!events.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const entries = events.map((event, index) => ({
        sequence: run.lastEventSeq + index + 1,
        eventType: String(event.type),
        payload: event,
      }));
      const inserted = await client.query<{ sequence: string }>(
        `INSERT INTO agent_core.agent_run_events
           (run_id, sequence, thread_id, event_type, payload)
         SELECT $1, entry.sequence, $2, entry.event_type, entry.payload
         FROM jsonb_to_recordset($3::jsonb)
           AS entry(sequence bigint, event_type text, payload jsonb)
         ON CONFLICT (run_id, sequence) DO NOTHING
         RETURNING sequence`,
        [run.id, run.threadId, JSON.stringify(entries.map((entry) => ({
          sequence: entry.sequence,
          event_type: entry.eventType,
          payload: entry.payload,
        })))],
      );
      const insertedSequences = new Set(inserted.rows.map((row) => Number(row.sequence)));
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!;
        if (!insertedSequences.has(entry.sequence)) continue;
        const value = entry.payload as BaseEvent & Record<string, unknown>;
        if (entry.payload.type === "TEXT_MESSAGE_CONTENT" || entry.payload.type === "TOOL_CALL_ARGS") {
          let delta = String(value.delta ?? "");
          let lastSequence = entry.sequence;
          while (index + 1 < entries.length) {
            const next = entries[index + 1]!;
            const nextValue = next.payload as BaseEvent & Record<string, unknown>;
            const sameTarget = entry.payload.type === "TEXT_MESSAGE_CONTENT"
              ? nextValue.messageId === value.messageId
              : nextValue.toolCallId === value.toolCallId;
            if (next.payload.type !== entry.payload.type || !sameTarget
              || !insertedSequences.has(next.sequence)) break;
            delta += String(nextValue.delta ?? "");
            lastSequence = next.sequence;
            index += 1;
          }
          await this.projectEvent(client, run, { ...entry.payload, delta } as BaseEvent, lastSequence);
          continue;
        }
        await this.projectEvent(client, run, entry.payload, entry.sequence);
      }
      const sequence = entries.at(-1)!.sequence;
      await client.query(
        `UPDATE agent_core.agent_runs SET last_event_seq = GREATEST(last_event_seq, $2)
         WHERE id = $1`,
        [run.id, sequence],
      );
      await client.query("COMMIT");
      run.lastEventSeq = sequence;
      return entries.map((entry) => ({ key: `${run.id}:${entry.sequence}`, event: entry.payload }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async projectEvent(
    client: pg.PoolClient,
    run: RunRecord,
    event: BaseEvent,
    eventSequence: number,
  ): Promise<void> {
    const value = event as BaseEvent & Record<string, unknown>;
    if (event.type === "TEXT_MESSAGE_START") {
      const sequenceResult = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
         FROM agent_core.agent_messages WHERE thread_id = $1`,
        [run.threadId],
      );
      await client.query(
        `INSERT INTO agent_core.agent_messages
           (id, thread_id, run_id, sequence, role, content, status, parent_message_id)
         VALUES ($1, $2, $3, $4, $5, '""'::jsonb, 'streaming', $6)
         ON CONFLICT (thread_id, id) DO NOTHING`,
        [
          value.messageId,
          run.threadId,
          run.id,
          Number(sequenceResult.rows[0]!.next),
          value.role ?? "assistant",
          value.parentMessageId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO agent_core.agent_message_parts
           (thread_id, message_id, part_index, part_type, content, status)
         VALUES ($1, $2, 0, 'text', '""'::jsonb, 'streaming')
         ON CONFLICT (thread_id, message_id, part_index) DO NOTHING`,
        [run.threadId, value.messageId],
      );
    } else if (event.type === "TEXT_MESSAGE_CONTENT") {
      await client.query(
        `UPDATE agent_core.agent_messages
         SET content = to_jsonb(COALESCE(content #>> '{}', '') || $3::text), updated_at = now()
         WHERE thread_id = $1 AND id = $2`,
        [run.threadId, value.messageId, String(value.delta ?? "")],
      );
      await client.query(
        `UPDATE agent_core.agent_message_parts
         SET content = to_jsonb(COALESCE(content #>> '{}', '') || $3::text), updated_at = now()
         WHERE thread_id = $1 AND message_id = $2 AND part_index = 0`,
        [run.threadId, value.messageId, String(value.delta ?? "")],
      );
    } else if (event.type === "TEXT_MESSAGE_END") {
      const completed = await client.query<{ preview: string }>(
        `UPDATE agent_core.agent_messages
         SET status = 'completed', updated_at = now()
         WHERE thread_id = $1 AND id = $2
         RETURNING LEFT(content #>> '{}', 240) AS preview`,
        [run.threadId, value.messageId],
      );
      await client.query(
        `UPDATE agent_core.agent_message_parts SET status = 'completed', updated_at = now()
         WHERE thread_id = $1 AND message_id = $2 AND part_index = 0`,
        [run.threadId, value.messageId],
      );
      if (completed.rowCount) {
        await client.query(
          `UPDATE agent_core.agent_threads
           SET message_count = message_count + 1,
               last_message_preview = COALESCE($2, last_message_preview),
               last_activity_at = now(), updated_at = now(), version = version + 1
           WHERE id = $1`,
          [run.threadId, completed.rows[0]?.preview ?? null],
        );
      }
    } else if (event.type === "TOOL_CALL_START") {
      const toolCallId = String(value.toolCallId ?? "");
      if (!toolCallId) return;
      const messageId = `tool-call:${toolCallId}`;
      const sequenceResult = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_core.agent_messages WHERE thread_id = $1`,
        [run.threadId],
      );
      await client.query(
        `INSERT INTO agent_core.agent_messages
           (id, thread_id, run_id, sequence, role, kind, content, status, tool_call_id, parent_message_id)
         VALUES ($1,$2,$3,$4,'assistant','tool_call',$5::jsonb,'streaming',$6,$7)
         ON CONFLICT (thread_id, id) DO NOTHING`,
        [messageId, run.threadId, run.id, Number(sequenceResult.rows[0]!.next),
          JSON.stringify({ name: value.toolCallName ?? null, args: "" }), toolCallId,
          value.parentMessageId ?? null],
      );
      await client.query(
        `INSERT INTO agent_core.agent_message_parts
           (thread_id, message_id, part_index, part_type, content, status, tool_call_id)
         VALUES ($1,$2,0,'tool_call',$3::jsonb,'streaming',$4)
         ON CONFLICT (thread_id, message_id, part_index) DO NOTHING`,
        [run.threadId, messageId, JSON.stringify({ name: value.toolCallName ?? null, args: "" }), toolCallId],
      );
    } else if (event.type === "TOOL_CALL_ARGS") {
      const toolCallId = String(value.toolCallId ?? "");
      const messageId = `tool-call:${toolCallId}`;
      await client.query(
        `UPDATE agent_core.agent_message_parts
         SET content = jsonb_set(content, '{args}', to_jsonb(COALESCE(content->>'args','') || $3::text)), updated_at = now()
         WHERE thread_id = $1 AND message_id = $2 AND part_index = 0`,
        [run.threadId, messageId, String(value.delta ?? "")],
      );
    } else if (event.type === "TOOL_CALL_END") {
      const toolCallId = String(value.toolCallId ?? "");
      const messageId = `tool-call:${toolCallId}`;
      await client.query(
        `UPDATE agent_core.agent_message_parts SET status = 'completed', updated_at = now()
         WHERE thread_id = $1 AND message_id = $2 AND part_index = 0`,
        [run.threadId, messageId],
      );
      await client.query(
        `UPDATE agent_core.agent_messages m SET content = p.content, status = 'completed', updated_at = now()
         FROM agent_core.agent_message_parts p
         WHERE m.thread_id = $1 AND m.id = $2 AND p.thread_id = m.thread_id
           AND p.message_id = m.id AND p.part_index = 0`,
        [run.threadId, messageId],
      );
    } else if (event.type === "TOOL_CALL_RESULT") {
      const toolCallId = String(value.toolCallId ?? "");
      const messageId = String(value.messageId ?? `tool-result:${toolCallId}`);
      const sequenceResult = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_core.agent_messages WHERE thread_id = $1`,
        [run.threadId],
      );
      const content = value.content ?? value.result ?? null;
      await client.query(
        `INSERT INTO agent_core.agent_messages
           (id, thread_id, run_id, sequence, role, kind, content, status, tool_call_id)
         VALUES ($1,$2,$3,$4,'tool','tool_result',$5::jsonb,'completed',$6)
         ON CONFLICT (thread_id, id) DO NOTHING`,
        [messageId, run.threadId, run.id, Number(sequenceResult.rows[0]!.next), JSON.stringify(content), toolCallId],
      );
      await client.query(
        `INSERT INTO agent_core.agent_message_parts
           (thread_id, message_id, part_index, part_type, content, status, tool_call_id)
         VALUES ($1,$2,0,'tool_result',$3::jsonb,'completed',$4)
         ON CONFLICT (thread_id, message_id, part_index) DO NOTHING`,
        [run.threadId, messageId, JSON.stringify(content), toolCallId],
      );
    } else if (event.type === "CUSTOM") {
      const messageId = String(value.messageId ?? value.id ?? `event:${run.id}:${eventSequence}`);
      const customName = String(value.name ?? value.type ?? "").toLowerCase();
      const partType = customName.includes("interrupt") || customName.includes("human_in_the_loop")
        ? "interrupt" : "activity";
      const sequenceResult = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_core.agent_messages WHERE thread_id = $1`,
        [run.threadId],
      );
      await client.query(
        `INSERT INTO agent_core.agent_messages
           (id, thread_id, run_id, sequence, role, kind, content, status)
         VALUES ($1,$2,$3,$4,'system','activity',$5::jsonb,'completed')
         ON CONFLICT (thread_id, id) DO NOTHING`,
        [messageId, run.threadId, run.id, Number(sequenceResult.rows[0]!.next), JSON.stringify(event)],
      );
      await client.query(
        `INSERT INTO agent_core.agent_message_parts
           (thread_id, message_id, part_index, part_type, content, status)
         VALUES ($1,$2,0,$3,$4::jsonb,'completed')
         ON CONFLICT (thread_id, message_id, part_index) DO NOTHING`,
        [run.threadId, messageId, partType, JSON.stringify(event)],
      );
    } else if (["STATE_SNAPSHOT", "MESSAGES_SNAPSHOT", "ACTIVITY_SNAPSHOT"].includes(event.type)) {
      const snapshotKey = event.type === "ACTIVITY_SNAPSHOT"
        ? `${event.type}:${String(value.messageId ?? value.activityType ?? "default")}`
        : event.type;
      await client.query(
        `INSERT INTO agent_core.agent_run_snapshots (run_id, thread_id, snapshot_key, event_type, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (run_id, snapshot_key) DO UPDATE SET
           event_type = EXCLUDED.event_type, payload = EXCLUDED.payload, updated_at = now()`,
        [run.id, run.threadId, snapshotKey, event.type, JSON.stringify(event)],
      );
    }
  }

  async finishRun(runId: string, status: "completed" | "failed" | "cancelled" | "interrupted", error?: Error): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE agent_core.agent_runs
         SET status = $2, finished_at = now(), error_code = $3, error_detail = $4
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [runId, status, error?.name ?? null, error?.message.slice(0, 2000) ?? null],
      );
      if (status !== "completed") {
        await client.query(
          `UPDATE agent_core.agent_messages SET status = 'failed', updated_at = now()
           WHERE run_id = $1 AND status = 'streaming'`,
          [runId],
        );
        await client.query(
          `UPDATE agent_core.agent_message_parts p SET status = 'failed', updated_at = now()
           FROM agent_core.agent_messages m
           WHERE m.run_id = $1 AND p.thread_id = m.thread_id AND p.message_id = m.id
             AND p.status = 'streaming'`,
          [runId],
        );
      }
      await client.query("COMMIT");
    } catch (failure) {
      await client.query("ROLLBACK");
      throw failure;
    } finally {
      client.release();
    }
  }

  async completeTitle(
    threadId: string,
    title: string,
    model: string,
  ): Promise<PublishedThreadEvent | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ThreadRow & { tenant_id: string; owner_id: string }>(
        `UPDATE agent_core.agent_threads
         SET title = $3, title_status = 'generated', title_model = $4,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND namespace = $2 AND title_status = 'generating'
         RETURNING *`,
        [threadId, this.namespace, title, model],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const event = await this.appendThreadEvent(
        client,
        mapThread(row),
        "thread.updated",
        { tenantId: row.tenant_id, userId: row.owner_id },
      );
      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimTitleJob(workerId: string, staleAfterMs: number): Promise<TitleJobRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        id: string;
        thread_id: string;
        agent_id: string;
        source: string;
      }>(
        `SELECT j.id, j.thread_id, t.agent_id, j.source
         FROM agent_core.agent_title_jobs j
         JOIN agent_core.agent_threads t ON t.id = j.thread_id
         WHERE t.namespace = $1 AND (
           (j.status = 'pending' AND j.available_at <= now()) OR
           (j.status = 'running' AND j.locked_at < now() - ($2::text || ' milliseconds')::interval)
         )
         ORDER BY j.available_at, j.created_at
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1`,
        [this.namespace, staleAfterMs],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = await client.query<{ attempts: number }>(
        `UPDATE agent_core.agent_title_jobs
         SET status = 'running', attempts = attempts + 1, locked_at = now(),
             locked_by = $2, updated_at = now()
         WHERE id = $1
         RETURNING attempts`,
        [row.id, workerId],
      );
      await client.query("COMMIT");
      return {
        id: row.id,
        threadId: row.thread_id,
        agentId: row.agent_id,
        source: row.source,
        attempts: claimed.rows[0]!.attempts,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeTitleJob(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_core.agent_title_jobs
       SET status = 'completed', completed_at = now(), locked_at = NULL,
           locked_by = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [jobId],
    );
  }

  async failTitleJob(jobId: string, threadId: string, final: boolean, error: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE agent_core.agent_title_jobs
         SET status = CASE WHEN $2 THEN 'dead' ELSE 'pending' END,
             available_at = CASE WHEN $2 THEN available_at
               ELSE now() + make_interval(secs => LEAST(60, power(2, attempts)::integer)) END,
             locked_at = NULL, locked_by = NULL, last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [jobId, final, error],
      );
      if (final) {
        await client.query(
          `UPDATE agent_core.agent_threads
           SET title_status = 'fallback', updated_at = now()
           WHERE id = $1 AND namespace = $2 AND title_status = 'generating'`,
          [threadId, this.namespace],
        );
      }
      await client.query("COMMIT");
    } catch (failure) {
      await client.query("ROLLBACK");
      throw failure;
    } finally {
      client.release();
    }
  }

  async loadEvents(threadId: string): Promise<PersistedEvent[]> {
    const principal = currentPrincipal();
    const runs = await this.pool.query<{
      run_id: string;
      status: string;
      error_detail: string | null;
      message_id: string | null;
      parent_message_id: string | null;
      role: string | null;
      content: unknown;
      parts: Array<{ index: number; type: string; content: unknown; status: string; toolCallId: string | null }> | null;
    }>(
      `SELECT r.id AS run_id, r.status, r.error_detail, m.id AS message_id,
              m.parent_message_id, m.role, m.content,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'index', p.part_index, 'type', p.part_type, 'content', p.content,
                'status', p.status, 'toolCallId', p.tool_call_id
              ) ORDER BY p.part_index)
              FROM agent_core.agent_message_parts p
              WHERE p.thread_id = m.thread_id AND p.message_id = m.id), '[]'::jsonb) AS parts
       FROM agent_core.agent_runs r
       JOIN agent_core.agent_threads t ON t.id = r.thread_id
       LEFT JOIN agent_core.agent_messages m ON m.run_id = r.id
       WHERE r.thread_id = $1 AND t.namespace = $2 AND t.tenant_id = $3 AND t.owner_id = $4
         AND t.deleted_at IS NULL AND r.status NOT IN ('queued', 'running')
       ORDER BY r.created_at, m.sequence`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
    const replay: PersistedEvent[] = [];
    const snapshots = await this.pool.query<{ run_id: string; payload: BaseEvent }>(
      `SELECT DISTINCT ON (s.snapshot_key) s.run_id, s.payload
       FROM agent_core.agent_run_snapshots s
       JOIN agent_core.agent_runs r ON r.id = s.run_id
       JOIN agent_core.agent_threads t ON t.id = s.thread_id
       WHERE s.thread_id = $1 AND t.namespace = $2 AND t.tenant_id = $3 AND t.owner_id = $4
         AND r.status NOT IN ('queued', 'running') AND s.event_type <> 'MESSAGES_SNAPSHOT'
       ORDER BY s.snapshot_key, s.updated_at DESC`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
    const snapshotsByRun = new Map<string, BaseEvent[]>();
    for (const row of snapshots.rows) {
      const values = snapshotsByRun.get(row.run_id) ?? [];
      values.push(row.payload);
      snapshotsByRun.set(row.run_id, values);
    }
    let currentRun = "";
    let syntheticSequence = 0;
    const finishRun = (row: { run_id: string; status: string; error_detail: string | null }): void => {
      for (const snapshot of snapshotsByRun.get(row.run_id) ?? []) {
        replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: snapshot });
      }
      const event = row.status === "completed"
        ? { type: "RUN_FINISHED", threadId, runId: row.run_id }
        : { type: "RUN_ERROR", message: row.error_detail ?? `Run ${row.status}` };
      replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: event as BaseEvent });
    };
    let previous: (typeof runs.rows)[number] | null = null;
    for (const row of runs.rows) {
      if (row.run_id !== currentRun) {
        if (previous) finishRun(previous);
        currentRun = row.run_id;
        syntheticSequence = 0;
        replay.push({
          key: `${row.run_id}:canonical:${syntheticSequence++}`,
          event: { type: "RUN_STARTED", threadId, runId: row.run_id } as BaseEvent,
        });
      }
      previous = row;
      if (!row.message_id || !row.role) continue;
      const parts = row.parts?.length ? row.parts : [{
        index: 0, type: "text", content: row.content, status: "completed", toolCallId: null,
      }];
      for (const part of parts) {
        if (part.type === "text") {
          const content = contentText(part.content);
          replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TEXT_MESSAGE_START", messageId: row.message_id, role: row.role,
          } as BaseEvent });
          if (content) replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TEXT_MESSAGE_CONTENT", messageId: row.message_id, delta: content,
          } as BaseEvent });
          replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TEXT_MESSAGE_END", messageId: row.message_id,
          } as BaseEvent });
        } else if (part.type === "tool_call" && part.toolCallId) {
          const tool = part.content && typeof part.content === "object"
            ? part.content as { name?: unknown; args?: unknown } : {};
          replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TOOL_CALL_START", toolCallId: part.toolCallId,
            toolCallName: typeof tool.name === "string" ? tool.name : "tool",
            ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
          } as BaseEvent });
          const args = typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args ?? {});
          if (args) replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TOOL_CALL_ARGS", toolCallId: part.toolCallId, delta: args,
          } as BaseEvent });
          replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TOOL_CALL_END", toolCallId: part.toolCallId,
          } as BaseEvent });
        } else if (part.type === "tool_result" && part.toolCallId) {
          replay.push({ key: `${row.run_id}:canonical:${syntheticSequence++}`, event: {
            type: "TOOL_CALL_RESULT", messageId: row.message_id,
            toolCallId: part.toolCallId,
            content: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? null),
          } as BaseEvent });
        } else if ((part.type === "activity" || part.type === "interrupt")
          && part.content && typeof part.content === "object" && "type" in part.content) {
          replay.push({
            key: `${row.run_id}:canonical:${syntheticSequence++}`,
            event: part.content as BaseEvent,
          });
        }
      }
    }
    if (previous) finishRun(previous);

    const active = await this.pool.query<{ run_id: string; sequence: string; payload: BaseEvent }>(
      `SELECT e.run_id, e.sequence, e.payload
       FROM agent_core.agent_run_events e
       JOIN agent_core.agent_runs r ON r.id = e.run_id
       JOIN agent_core.agent_threads t ON t.id = e.thread_id
       WHERE e.thread_id = $1 AND t.namespace = $2 AND t.tenant_id = $3 AND t.owner_id = $4
         AND t.deleted_at IS NULL AND r.status IN ('queued', 'running')
         AND NOT (
           e.event_type IN ('TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END')
           AND e.payload #>> '{rawEvent,metadata,langgraph_node}' = 'title'
         )
       ORDER BY r.created_at, e.sequence`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
    if (!runs.rows.length && !active.rows.length && !await this.getThread(threadId)) throw new Error("THREAD_NOT_FOUND");
    return replay.concat(active.rows.map((row) => ({
      key: `${row.run_id}:${row.sequence}`,
      event: row.payload,
    })));
  }

  async isRunning(threadId: string): Promise<boolean> {
    const principal = currentPrincipal();
    const result = await this.pool.query(
      `SELECT 1 FROM agent_core.agent_runs r
       JOIN agent_core.agent_threads t ON t.id = r.thread_id
       WHERE r.thread_id = $1 AND t.namespace = $2 AND t.tenant_id = $3 AND t.owner_id = $4
         AND r.status IN ('queued', 'running')
       LIMIT 1`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
    return Boolean(result.rowCount);
  }

  async cancelActiveRun(threadId: string): Promise<void> {
    const principal = currentPrincipal();
    await this.pool.query(
      `UPDATE agent_core.agent_runs r
       SET status = 'cancelled', finished_at = now()
       FROM agent_core.agent_threads t
       WHERE r.thread_id = $1 AND r.thread_id = t.id AND t.namespace = $2
         AND t.tenant_id = $3 AND t.owner_id = $4
         AND r.status IN ('queued', 'running')`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
  }

  async listStaleRuns(staleAfterSeconds: number): Promise<Array<{ id: string; threadId: string }>> {
    const result = await this.pool.query<{ id: string; thread_id: string }>(
      `SELECT r.id, r.thread_id
       FROM agent_core.agent_runs r
       JOIN agent_core.agent_threads t ON t.id = r.thread_id
       WHERE t.namespace = $1 AND r.status IN ('queued', 'running')
         AND COALESCE(r.started_at, r.created_at) < now() - make_interval(secs => $2)`,
      [this.namespace, staleAfterSeconds],
    );
    return result.rows.map((row) => ({ id: row.id, threadId: row.thread_id }));
  }

  async interruptStaleRun(runId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE agent_core.agent_runs
         SET status = 'interrupted', finished_at = now(), error_code = 'POD_LOST',
             error_detail = 'Run reconciled after its distributed lock expired'
         WHERE id = $1 AND status IN ('queued', 'running')`,
        [runId],
      );
      await client.query(
        `UPDATE agent_core.agent_messages
         SET status = 'failed', updated_at = now()
         WHERE run_id = $1 AND status = 'streaming'`,
        [runId],
      );
      await client.query(
        `UPDATE agent_core.agent_message_parts p
         SET status = 'failed', updated_at = now()
         FROM agent_core.agent_messages m
         WHERE m.run_id = $1 AND p.thread_id = m.thread_id AND p.message_id = m.id
           AND p.status = 'streaming'`,
        [runId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listMessages(threadId: string, limit: number, afterSequence = 0): Promise<unknown[]> {
    const principal = currentPrincipal();
    const result = await this.pool.query(
      `SELECT m.id, m.run_id AS "runId", m.sequence, m.role, m.kind, m.content,
              m.status, m.tool_call_id AS "toolCallId", m.parent_message_id AS "parentMessageId",
              m.created_at AS "createdAt", m.updated_at AS "updatedAt",
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'index', p.part_index, 'type', p.part_type, 'content', p.content,
                  'status', p.status, 'toolCallId', p.tool_call_id
                ) ORDER BY p.part_index)
                FROM agent_core.agent_message_parts p
                WHERE p.thread_id = m.thread_id AND p.message_id = m.id
              ), '[]'::jsonb) AS parts
       FROM agent_core.agent_messages m
       JOIN agent_core.agent_threads t ON t.id = m.thread_id
       WHERE m.thread_id = $1 AND t.namespace = $2 AND t.tenant_id = $3 AND t.owner_id = $4
         AND t.deleted_at IS NULL AND m.sequence > $5
       ORDER BY m.sequence LIMIT $6`,
      [threadId, this.namespace, principal.tenantId, principal.userId, afterSequence, limit],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      ...row,
      sequence: Number(row.sequence),
    }));
  }

  async listThreadEvents(
    afterId: string,
    limit = 200,
    principal = currentPrincipal(),
  ): Promise<ThreadEvent[]> {
    const result = await this.pool.query<ThreadEventRow>(
      `SELECT id::text, event_type, payload, created_at, tenant_id, owner_id
       FROM agent_core.agent_thread_events
       WHERE tenant_id = $1 AND owner_id = $2 AND namespace = $3 AND id > $4::bigint
       ORDER BY id
       LIMIT $5`,
      [principal.tenantId, principal.userId, this.namespace, afterId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      thread: row.payload.thread,
      occurredAt: row.created_at.toISOString(),
    }));
  }

  async pruneEvents(retentionDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM agent_core.agent_run_events e
       USING agent_core.agent_runs r, agent_core.agent_threads t
       WHERE e.run_id = r.id AND r.thread_id = t.id AND t.namespace = $1
         AND r.finished_at < now() - make_interval(days => $2)
         AND r.status IN ('completed', 'failed', 'cancelled', 'interrupted')`,
      [this.namespace, retentionDays],
    );
    return result.rowCount ?? 0;
  }

  async pruneTitleJobs(retentionDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM agent_core.agent_title_jobs j
       USING agent_core.agent_threads t
       WHERE j.thread_id = t.id AND t.namespace = $1
         AND j.status IN ('completed', 'dead')
         AND j.updated_at < now() - make_interval(days => $2)`,
      [this.namespace, retentionDays],
    );
    return result.rowCount ?? 0;
  }

  async pruneThreadEvents(retentionDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM agent_core.agent_thread_events
       WHERE namespace = $1 AND created_at < now() - make_interval(days => $2)`,
      [this.namespace, retentionDays],
    );
    return result.rowCount ?? 0;
  }

  async pruneMessages(retentionDays: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const removed = await client.query<{ thread_id: string }>(
        `DELETE FROM agent_core.agent_messages m
         USING agent_core.agent_threads t
         WHERE m.thread_id = t.id AND t.namespace = $1
           AND m.created_at < now() - make_interval(days => $2)
           AND NOT EXISTS (
             SELECT 1 FROM agent_core.agent_runs r
             WHERE r.id = m.run_id AND r.status IN ('queued', 'running')
           )
         RETURNING m.thread_id`,
        [this.namespace, retentionDays],
      );
      const threadIds = [...new Set(removed.rows.map((row) => row.thread_id))];
      if (threadIds.length) {
        await client.query(
          `UPDATE agent_core.agent_threads t SET
             message_count = (SELECT COUNT(*)::integer FROM agent_core.agent_messages m WHERE m.thread_id = t.id),
             last_message_preview = (
               SELECT LEFT(m.content #>> '{}', 240)
               FROM agent_core.agent_messages m
               WHERE m.thread_id = t.id AND m.kind = 'text'
               ORDER BY m.sequence DESC LIMIT 1
             ),
             updated_at = now(), version = version + 1
           WHERE t.id = ANY($1::uuid[])`,
          [threadIds],
        );
      }
      await client.query("COMMIT");
      return removed.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneRuns(retentionDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM agent_core.agent_runs r
       USING agent_core.agent_threads t
       WHERE r.thread_id = t.id AND t.namespace = $1
         AND r.finished_at < now() - make_interval(days => $2)
         AND r.status IN ('completed', 'failed', 'cancelled', 'interrupted')
         AND NOT EXISTS (SELECT 1 FROM agent_core.agent_messages m WHERE m.run_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM agent_core.agent_run_events e WHERE e.run_id = r.id)`,
      [this.namespace, retentionDays],
    );
    return result.rowCount ?? 0;
  }

  async purgeDeletedThreads(retentionDays: number, batchSize = 1_000): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{ id: string }>(
        `SELECT t.id
         FROM agent_core.agent_threads t
         WHERE t.namespace = $1 AND t.status = 'deleted'
           AND t.deleted_at <= now() - make_interval(days => $2)
           AND NOT EXISTS (
             SELECT 1 FROM agent_core.agent_runs r
             WHERE r.thread_id = t.id AND r.status IN ('queued', 'running')
           )
         ORDER BY t.deleted_at, t.id
         LIMIT $3
         FOR UPDATE SKIP LOCKED`,
        [this.namespace, retentionDays, batchSize],
      );
      const ids = candidates.rows.map((row) => row.id);
      if (!ids.length) {
        await client.query("COMMIT");
        return 0;
      }

      // The bundled LangGraph example shares this database. These tables are
      // optional because consumers may keep checkpoints in a separate store.
      for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"] as const) {
        const exists = await client.query<{ relation: string | null }>(
          "SELECT to_regclass($1) AS relation",
          [`public.${table}`],
        );
        if (exists.rows[0]?.relation) {
          await client.query(`DELETE FROM public.${table} WHERE thread_id = ANY($1::text[])`, [ids]);
        }
      }

      const removed = await client.query(
        `DELETE FROM agent_core.agent_threads
         WHERE namespace = $1 AND id = ANY($2::uuid[]) AND status = 'deleted'`,
        [this.namespace, ids],
      );
      await client.query("COMMIT");
      return removed.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async operationalMetrics(): Promise<OperationalMetrics> {
    const result = await this.pool.query<{
      active_runs: string;
      title_pending: string;
      title_running: string;
      title_dead: string;
      oldest_title_job_seconds: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM agent_core.agent_runs r
          JOIN agent_core.agent_threads t ON t.id = r.thread_id
          WHERE t.namespace = $1 AND r.status IN ('queued', 'running')) AS active_runs,
         COUNT(*) FILTER (WHERE j.status = 'pending') AS title_pending,
         COUNT(*) FILTER (WHERE j.status = 'running') AS title_running,
         COUNT(*) FILTER (WHERE j.status = 'dead') AS title_dead,
         COALESCE(MAX(EXTRACT(EPOCH FROM now() - j.created_at))
           FILTER (WHERE j.status IN ('pending', 'running')), 0) AS oldest_title_job_seconds
       FROM agent_core.agent_title_jobs j
       JOIN agent_core.agent_threads t ON t.id = j.thread_id
       WHERE t.namespace = $1`,
      [this.namespace],
    );
    const row = result.rows[0]!;
    return {
      activeRuns: Number(row.active_runs),
      titlePending: Number(row.title_pending),
      titleRunning: Number(row.title_running),
      titleDead: Number(row.title_dead),
      oldestTitleJobSeconds: Number(row.oldest_title_job_seconds),
    };
  }
}
