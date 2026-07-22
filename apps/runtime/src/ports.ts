import type { AgentDefinition, UpsertAgentDefinition } from "@kiri_ikki/thread-contracts";
import type { BaseEvent } from "@ag-ui/client";
import type { Principal } from "./auth.js";
import type {
  BeginRunInput, OperationalMetrics, PersistedEvent, PublishedThreadEvent,
  RunRecord, ThreadRecord, TitleJobRecord,
} from "./types.js";

export interface AgentRegistry {
  get(agentId: string): Promise<AgentDefinition | null>;
  list(options?: { enabledOnly?: boolean }): Promise<AgentDefinition[]>;
  upsert(agentId: string, input: UpsertAgentDefinition): Promise<AgentDefinition>;
  disable(agentId: string): Promise<AgentDefinition | null>;
}

export interface CredentialResolver {
  resolve(reference: string | null): Promise<string | null>;
}

export interface ThreadStore {
  createThread(principal: Principal, idempotencyKey: string, agentId?: string, metadata?: Record<string, unknown>): Promise<{
    thread: ThreadRecord; event: PublishedThreadEvent | null; created: boolean;
  }>; 
  getThread(principal: Principal, threadId: string): Promise<ThreadRecord | null>;
  listThreads(principal: Principal, options: {
    agentId?: string; status?: "active" | "archived"; limit: number; before?: { at: string; id: string };
  }): Promise<{ items: ThreadRecord[]; nextCursor: string | null; eventCursor: string }>;
  setStatus(principal: Principal, threadId: string, status: "active" | "archived" | "deleted", expectedVersion: number): Promise<{
    thread: ThreadRecord; event: PublishedThreadEvent;
  } | null>;
  renameThread(principal: Principal, threadId: string, title: string, expectedVersion: number): Promise<{
    thread: ThreadRecord; event: PublishedThreadEvent;
  } | null>;
  listMessages(principal: Principal, threadId: string, limit: number, afterSequence?: number): Promise<unknown[]>;
  listThreadEvents(principal: Principal, afterId: string, limit?: number): Promise<import("@kiri_ikki/thread-contracts").ThreadEvent[]>;
}

export interface RunStore {
  beginRun(input: BeginRunInput): Promise<{ run: RunRecord; titleRequired: boolean; created: boolean }>;
  appendEvents(run: RunRecord, events: BaseEvent[]): Promise<PersistedEvent[]>;
  finishRun(run: RunRecord, status: "completed" | "failed" | "cancelled" | "interrupted", error?: Error): Promise<void>;
  loadEvents(principal: Principal, threadId: string): Promise<PersistedEvent[]>;
  isRunning(principal: Principal, threadId: string): Promise<boolean>;
  cancelActiveRun(principal: Principal, threadId: string): Promise<void>;
  heartbeatRun(run: RunRecord): Promise<boolean>;
}

export interface TitleStore {
  getThreadInternal(threadId: string): Promise<ThreadRecord | null>;
  claimTitleJob(workerId: string, staleAfterMs: number): Promise<TitleJobRecord | null>;
  completeTitleJob(jobId: string): Promise<void>;
  failTitleJob(jobId: string, threadId: string, final: boolean, error: string): Promise<void>;
  completeTitle(threadId: string, title: string, model: string): Promise<PublishedThreadEvent | null>;
}

export interface MaintenanceStore {
  listStaleRuns(staleAfterSeconds: number): Promise<Array<{ id: string; threadId: string }>>;
  interruptStaleRun(runId: string, staleAfterSeconds: number): Promise<boolean>;
  pruneEvents(retentionDays: number): Promise<number>;
  pruneTitleJobs(retentionDays: number): Promise<number>;
  pruneThreadEvents(retentionDays: number): Promise<number>;
  pruneMessages(retentionDays: number): Promise<number>;
  pruneRuns(retentionDays: number): Promise<number>;
  purgeDeletedThreads(retentionDays: number, batchSize?: number): Promise<number>;
  operationalMetrics(): Promise<OperationalMetrics>;
}
