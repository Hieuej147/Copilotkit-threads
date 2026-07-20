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
  createThread(requestId: string, agentId?: string, metadata?: Record<string, unknown>): Promise<{
    thread: ThreadRecord; event: PublishedThreadEvent | null; created: boolean;
  }>; 
  getThread(threadId: string): Promise<ThreadRecord | null>;
  listThreads(options: {
    agentId?: string; status?: "active" | "archived"; limit: number; before?: { at: string; id: string };
  }): Promise<{ items: ThreadRecord[]; nextCursor: string | null; eventCursor: string }>;
  setStatus(threadId: string, status: "active" | "archived" | "deleted"): Promise<{
    thread: ThreadRecord; event: PublishedThreadEvent;
  } | null>;
  renameThread(threadId: string, title: string): Promise<{
    thread: ThreadRecord; event: PublishedThreadEvent;
  } | null>;
  listMessages(threadId: string, limit: number, afterSequence?: number): Promise<unknown[]>;
  listThreadEvents(afterId: string, limit?: number, principal?: Principal): Promise<import("@kiri_ikki/thread-contracts").ThreadEvent[]>;
}

export interface RunStore {
  beginRun(input: BeginRunInput): Promise<{ run: RunRecord; titleRequired: boolean }>;
  appendEvents(run: RunRecord, events: BaseEvent[]): Promise<PersistedEvent[]>;
  finishRun(runId: string, status: "completed" | "failed" | "cancelled" | "interrupted", error?: Error): Promise<void>;
  loadEvents(threadId: string): Promise<PersistedEvent[]>;
  isRunning(threadId: string): Promise<boolean>;
  cancelActiveRun(threadId: string): Promise<void>;
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
  interruptStaleRun(runId: string): Promise<void>;
  pruneEvents(retentionDays: number): Promise<number>;
  pruneTitleJobs(retentionDays: number): Promise<number>;
  pruneThreadEvents(retentionDays: number): Promise<number>;
  pruneMessages(retentionDays: number): Promise<number>;
  pruneRuns(retentionDays: number): Promise<number>;
  purgeDeletedThreads(retentionDays: number, batchSize?: number): Promise<number>;
  operationalMetrics(): Promise<OperationalMetrics>;
}
