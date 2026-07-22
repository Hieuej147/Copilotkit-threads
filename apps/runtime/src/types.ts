import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import type { ThreadEvent, ThreadEventType } from "@kiri_ikki/thread-contracts";
import type { Principal } from "./auth.js";

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
  metadata: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  threadId: string;
  lastEventSeq: number;
  status: string;
  fencingToken: number;
}

export interface PersistedEvent {
  key: string;
  event: BaseEvent;
}

export interface BeginRunInput {
  principal: Principal;
  threadId: string;
  runId: string;
  agentId: string;
  messages: Message[];
  rawInput: RunAgentInput;
  fencingToken: number;
}

export type PublishedThreadEvent = {
  tenantId: string;
  ownerId: string;
  event: ThreadEvent;
};

export type TitleJobRecord = {
  id: string;
  threadId: string;
  agentId: string;
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

export type ThreadEventRow = {
  id: string;
  event_type: ThreadEventType;
  payload: { thread: ThreadRecord };
  created_at: Date;
  tenant_id: string;
  owner_id: string;
};
