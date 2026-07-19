import type { BaseEvent, Message } from "@ag-ui/client";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  type ThreadEvent,
  type ThreadEventType,
} from "@threads/contracts";
import type {
  BeginRunInput,
  PersistedEvent,
  RunRecord,
  ThreadRecord,
} from "./types.js";
import { currentPrincipal } from "./auth.js";

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
};

export type TitleJobRecord = {
  id: string;
  threadId: string;
  source: string;
  attempts: number;
};

export type OperationalMetrics = {
  activeRuns: number;
  titlePending: number;
  titleRunning: number;
  titleDead: number;
  oldestTitleJobSeconds: number;
};

type ThreadEventRow = {
  id: string;
  event_type: ThreadEventType;
  payload: { thread: ThreadRecord };
  created_at: Date;
  tenant_id: string;
  owner_id: string;
};

export type PublishedThreadEvent = {
  tenantId: string;
  ownerId: string;
  event: ThreadEvent;
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
  };
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
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

export class ThreadRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly namespace: string,
    private readonly defaultAgentId: string,
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
  ): Promise<{ thread: ThreadRecord; event: PublishedThreadEvent | null; created: boolean }> {
    const principal = currentPrincipal();
    if (agentId !== this.defaultAgentId) throw new Error("AGENT_NOT_CONFIGURED");
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
           (id, namespace, agent_id, tenant_id, owner_id, creation_request_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [randomUUID(), this.namespace, agentId, principal.tenantId, principal.userId, requestId],
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
      const firstInput = input.messages.find((message) => message.role === "user");

      // `pending` is the only state allowed to create the durable title job.
      // `fallback` means that job exhausted its retry budget.
      const titleRequired = thread.title_status === "pending";
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
        const text = messageText(message);
        const inserted = await client.query(
          `INSERT INTO agent_core.agent_messages
             (id, thread_id, run_id, sequence, role, content, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'completed')
           ON CONFLICT (thread_id, id) DO NOTHING`,
          [message.id, input.threadId, input.runId, sequence, message.role, JSON.stringify(message.content)],
        );
        if (inserted.rowCount) {
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

  async appendEvent(run: RunRecord, event: BaseEvent): Promise<PersistedEvent> {
    const sequence = run.lastEventSeq + 1;
    const eventType = String(event.type);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_core.agent_run_events
           (run_id, sequence, thread_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (run_id, sequence) DO NOTHING`,
        [run.id, sequence, run.threadId, eventType, JSON.stringify(event)],
      );
      await client.query(
        `UPDATE agent_core.agent_runs SET last_event_seq = GREATEST(last_event_seq, $2)
         WHERE id = $1`,
        [run.id, sequence],
      );
      await this.projectEvent(client, run, event);
      await client.query("COMMIT");
      run.lastEventSeq = sequence;
      return { key: `${run.id}:${sequence}`, event };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async projectEvent(client: pg.PoolClient, run: RunRecord, event: BaseEvent): Promise<void> {
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
    } else if (event.type === "TEXT_MESSAGE_CONTENT") {
      await client.query(
        `UPDATE agent_core.agent_messages
         SET content = to_jsonb(COALESCE(content #>> '{}', '') || $3::text), updated_at = now()
         WHERE thread_id = $1 AND id = $2`,
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
    }
  }

  async finishRun(runId: string, status: "completed" | "failed" | "cancelled" | "interrupted", error?: Error): Promise<void> {
    await this.pool.query(
      `UPDATE agent_core.agent_runs
       SET status = $2, finished_at = now(), error_code = $3, error_detail = $4
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [runId, status, error?.name ?? null, error?.message.slice(0, 2000) ?? null],
    );
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
        source: string;
      }>(
        `SELECT j.id, j.thread_id, j.source
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
      return { id: row.id, threadId: row.thread_id, source: row.source, attempts: claimed.rows[0]!.attempts };
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
    const result = await this.pool.query<{ run_id: string; sequence: string; payload: BaseEvent }>(
      `SELECT e.run_id, e.sequence, e.payload
       FROM agent_core.agent_run_events e
       JOIN agent_core.agent_runs r ON r.id = e.run_id
       JOIN agent_core.agent_threads t ON t.id = e.thread_id
       WHERE e.thread_id = $1 AND t.namespace = $2 AND t.tenant_id = $3 AND t.owner_id = $4
         AND t.deleted_at IS NULL
         AND NOT (
           e.event_type IN ('TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END')
           AND e.payload #>> '{rawEvent,metadata,langgraph_node}' = 'title'
         )
       ORDER BY r.created_at, e.sequence`,
      [threadId, this.namespace, principal.tenantId, principal.userId],
    );
    if (result.rows.length === 0 && !await this.getThread(threadId)) throw new Error("THREAD_NOT_FOUND");
    return result.rows.map((row) => ({
      key: `${row.run_id}:${row.sequence}`,
      event: row.payload,
    }));
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
              m.created_at AS "createdAt", m.updated_at AS "updatedAt"
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
