import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";

export interface ThreadRecord {
  id: string;
  namespace: string;
  agentId: string;
  title: string;
  titleStatus: "pending" | "generating" | "generated" | "fallback" | "manual";
  status: "active" | "archived" | "deleted";
  messageCount: number;
  lastMessagePreview: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface RunRecord {
  id: string;
  threadId: string;
  lastEventSeq: number;
  status: string;
}

export interface PersistedEvent {
  key: string;
  event: BaseEvent;
}

export interface BeginRunInput {
  threadId: string;
  runId: string;
  agentId: string;
  messages: Message[];
  rawInput: RunAgentInput;
}
