import {
  agentDefinitionSchema,
  threadEventSchema,
  threadMessagePageSchema,
  threadPageSchema,
  threadSchema,
  type AgentThread,
  type ThreadEvent,
  type ThreadMessagePage,
  type ThreadPage,
  type AgentDefinition,
  type UpsertAgentDefinition,
} from "@kiri_ikki/thread-contracts";

export type ThreadClientOptions = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
};

export type ListThreadsOptions = {
  agentId?: string;
  status?: "active" | "archived";
  limit?: number;
  cursor?: string;
};

export type CreateThreadOptions = {
  agentId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

export class ThreadApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`Thread API request failed with status ${status}`);
    this.name = "ThreadApiError";
  }
}

function requestId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("crypto.randomUUID is required");
  return globalThis.crypto.randomUUID();
}

export class ThreadClient {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof globalThis.fetch;

  constructor(private readonly options: ThreadClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  create(options: CreateThreadOptions = {}): Promise<AgentThread> {
    return this.request("/v3/threads", {
      method: "POST",
      body: JSON.stringify({
        requestId: options.requestId ?? requestId(),
        agentId: options.agentId,
        metadata: options.metadata ?? {},
      }),
    }).then((value) => threadSchema.parse(value));
  }

  async list(options: ListThreadsOptions = {}): Promise<ThreadPage> {
    const query = new URLSearchParams();
    if (options.agentId) query.set("agentId", options.agentId);
    if (options.status) query.set("status", options.status);
    if (options.limit) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    return threadPageSchema.parse(await this.request(`/v3/threads${query.size ? `?${query}` : ""}`));
  }

  get(threadId: string): Promise<AgentThread> {
    return this.request(`/v3/threads/${encodeURIComponent(threadId)}`).then((value) => threadSchema.parse(value));
  }

  async messages(
    threadId: string,
    options: { limit?: number; after?: number } = {},
  ): Promise<ThreadMessagePage> {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.after !== undefined) query.set("after", String(options.after));
    return threadMessagePageSchema.parse(await this.request(
      `/v3/threads/${encodeURIComponent(threadId)}/messages${query.size ? `?${query}` : ""}`,
    ));
  }

  rename(threadId: string, title: string): Promise<AgentThread> {
    return this.request(`/v3/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }).then((value) => threadSchema.parse(value));
  }

  archive(threadId: string): Promise<AgentThread> {
    return this.setStatus(threadId, "archive");
  }

  unarchive(threadId: string): Promise<AgentThread> {
    return this.setStatus(threadId, "unarchive");
  }

  async delete(threadId: string): Promise<void> {
    await this.request(`/v3/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  }

  subscribeToEvents(
    onEvent: (event: ThreadEvent) => void,
    options: { after?: string; onError?: (error: Error) => void } = {},
  ): () => void {
    const controller = new AbortController();
    let cursor = options.after ?? "0";
    void (async () => {
      let retry = 500;
      while (!controller.signal.aborted) {
        try {
          const headers = await this.headers();
          if (cursor !== "0") headers.set("last-event-id", cursor);
          const response = await this.requestFetch(`${this.baseUrl}/v3/thread-events`, {
            headers,
            credentials: this.options.credentials,
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new ThreadApiError(response.status, await response.text().catch(() => undefined));
          }
          retry = 500;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame.split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data) {
                const event = threadEventSchema.parse(JSON.parse(data));
                cursor = event.id;
                onEvent(event);
              }
              boundary = buffer.indexOf("\n\n");
            }
          }
        } catch (cause) {
          if (controller.signal.aborted) break;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          options.onError?.(error);
        }
        await new Promise((resolve) => setTimeout(resolve, retry));
        retry = Math.min(10_000, retry * 2);
      }
    })();
    return () => controller.abort();
  }

  private setStatus(threadId: string, action: "archive" | "unarchive"): Promise<AgentThread> {
    return this.request(`/v3/threads/${encodeURIComponent(threadId)}/${action}`, { method: "POST" })
      .then((value) => threadSchema.parse(value));
  }

  private async headers(init?: HeadersInit): Promise<Headers> {
    const headers = new Headers(init);
    const token = await this.options.getAccessToken?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = await this.headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      credentials: this.options.credentials,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* Keep the raw response. */ }
      throw new ThreadApiError(response.status, body);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }
}

export class AgentAdminClient {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof globalThis.fetch;

  constructor(private readonly options: ThreadClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async list(): Promise<AgentDefinition[]> {
    const value = await this.request("/v3/admin/agents") as { items?: unknown };
    return agentDefinitionSchema.array().parse(value.items);
  }

  get(agentId: string): Promise<AgentDefinition> {
    return this.request(`/v3/admin/agents/${encodeURIComponent(agentId)}`)
      .then((value) => agentDefinitionSchema.parse(value));
  }

  upsert(agentId: string, input: UpsertAgentDefinition): Promise<AgentDefinition> {
    return this.request(`/v3/admin/agents/${encodeURIComponent(agentId)}`, {
      method: "PUT", body: JSON.stringify(input),
    }).then((value) => agentDefinitionSchema.parse(value));
  }

  disable(agentId: string): Promise<AgentDefinition> {
    return this.request(`/v3/admin/agents/${encodeURIComponent(agentId)}/disable`, { method: "POST" })
      .then((value) => agentDefinitionSchema.parse(value));
  }

  test(agentId: string): Promise<{ ok: boolean; status: number; latencyMs: number }> {
    return this.request(`/v3/admin/agents/${encodeURIComponent(agentId)}/test`, { method: "POST" })
      .then((value) => value as { ok: boolean; status: number; latencyMs: number });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    const token = await this.options.getAccessToken?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      ...init, headers, credentials: this.options.credentials,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new ThreadApiError(response.status, body);
    }
    return response.status === 204 ? undefined : response.json();
  }
}

export type { AgentThread, ThreadEvent, ThreadMessagePage, ThreadPage };
