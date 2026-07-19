import { HttpAgent, type BaseEvent } from "@ag-ui/client";
import { randomUUID } from "node:crypto";

type EventLike = BaseEvent & { messageId?: string; toolCallId?: string };

export interface ValidationResult {
  eventCount: number;
  eventTypes: string[];
  terminalType: "RUN_FINISHED" | "RUN_ERROR";
}

export function validateEventLifecycle(events: readonly EventLike[]): ValidationResult {
  let started = false;
  let terminal = false;
  const textMessages = new Set<string>();
  const toolCalls = new Set<string>();

  for (const event of events) {
    if (terminal) throw new Error(`Event ${event.type} was emitted after the run terminated`);

    if (event.type === "RUN_STARTED") {
      if (started) throw new Error("RUN_STARTED was emitted more than once");
      started = true;
      continue;
    }
    if (!started) throw new Error(`Event ${event.type} was emitted before RUN_STARTED`);

    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      if (textMessages.size) throw new Error("Run terminated with an open text message");
      if (toolCalls.size) throw new Error("Run terminated with an open tool call");
      terminal = true;
      continue;
    }

    if (event.type === "TEXT_MESSAGE_START") {
      if (!event.messageId) throw new Error("TEXT_MESSAGE_START is missing messageId");
      if (textMessages.has(event.messageId)) throw new Error(`Text message ${event.messageId} started twice`);
      textMessages.add(event.messageId);
    }
    if (event.type === "TEXT_MESSAGE_CONTENT" || event.type === "TEXT_MESSAGE_END") {
      if (!event.messageId || !textMessages.has(event.messageId)) {
        throw new Error(`${event.type} has no matching TEXT_MESSAGE_START`);
      }
      if (event.type === "TEXT_MESSAGE_END") textMessages.delete(event.messageId);
    }

    if (event.type === "TOOL_CALL_START") {
      if (!event.toolCallId) throw new Error("TOOL_CALL_START is missing toolCallId");
      if (toolCalls.has(event.toolCallId)) throw new Error(`Tool call ${event.toolCallId} started twice`);
      toolCalls.add(event.toolCallId);
    }
    if (event.type === "TOOL_CALL_ARGS" || event.type === "TOOL_CALL_END") {
      if (!event.toolCallId || !toolCalls.has(event.toolCallId)) {
        throw new Error(`${event.type} has no matching TOOL_CALL_START`);
      }
      if (event.type === "TOOL_CALL_END") toolCalls.delete(event.toolCallId);
    }
  }

  if (!started) throw new Error("RUN_STARTED was not emitted");
  if (!terminal) throw new Error("RUN_FINISHED or RUN_ERROR was not emitted");
  const terminalType = events.at(-1)?.type;
  if (terminalType !== "RUN_FINISHED" && terminalType !== "RUN_ERROR") {
    throw new Error("Terminal event must be the final event");
  }
  return { eventCount: events.length, eventTypes: events.map((event) => event.type), terminalType };
}

export interface AgentCheckOptions {
  agentUrl: string;
  healthUrl?: string;
  prompt?: string;
  timeoutMs?: number;
  concurrency?: number;
}

async function checkHealth(url: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Health request failed with HTTP ${response.status}`);
}

async function runOnce(options: Required<Pick<AgentCheckOptions, "agentUrl" | "prompt" | "timeoutMs">>): Promise<ValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const events: EventLike[] = [];
  const agent = new HttpAgent({
    url: options.agentUrl,
    threadId: randomUUID(),
    initialMessages: [{ id: randomUUID(), role: "user", content: options.prompt }],
  });
  try {
    await agent.runAgent({ runId: randomUUID(), abortController: controller }, {
      onEvent: ({ event }) => { events.push(event as EventLike); },
    });
  } finally {
    clearTimeout(timeout);
  }
  const result = validateEventLifecycle(events);
  if (result.terminalType === "RUN_ERROR") {
    const terminal = events.at(-1) as EventLike & { message?: string };
    throw new Error(`Agent run ended with RUN_ERROR${terminal.message ? `: ${terminal.message}` : ""}`);
  }
  return result;
}

export async function checkAgent(options: AgentCheckOptions): Promise<ValidationResult[]> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const prompt = options.prompt ?? "Reply with one short greeting.";
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error("concurrency must be an integer from 1 to 10");
  }
  if (options.healthUrl) await checkHealth(options.healthUrl, timeoutMs);
  return Promise.all(Array.from({ length: concurrency }, () => runOnce({
    agentUrl: options.agentUrl,
    prompt,
    timeoutMs,
  })));
}

export async function checkRuntime(runtimeUrl: string, timeoutMs = 15_000): Promise<void> {
  const baseUrl = runtimeUrl.replace(/\/$/, "");
  const requestId = randomUUID();
  const headers = { "content-type": "application/json" };
  const create = await fetch(`${baseUrl}/v2/threads`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (create.status !== 201 && create.status !== 200) {
    throw new Error(`Thread create failed with HTTP ${create.status}`);
  }
  const thread = await create.json() as { id?: string };
  if (!thread.id) throw new Error("Thread create response did not include id");

  const idempotent = await fetch(`${baseUrl}/v2/threads`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const duplicate = await idempotent.json() as { id?: string };
  if (!idempotent.ok || duplicate.id !== thread.id) throw new Error("Thread creation is not idempotent");

  const list = await fetch(`${baseUrl}/v2/threads?limit=1`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!list.ok) throw new Error(`Thread list failed with HTTP ${list.status}`);

  const remove = await fetch(`${baseUrl}/v2/threads/${thread.id}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (remove.status !== 204) throw new Error(`Thread cleanup failed with HTTP ${remove.status}`);
}
