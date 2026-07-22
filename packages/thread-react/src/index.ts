import { useCallback, useEffect, useRef, useState } from "react";
import {
  ThreadClient,
  ThreadApiError,
  type AgentThread,
  type CreateThreadOptions,
  type ThreadEvent,
} from "@kiri_ikki/thread-client";

async function mutateLatest<T>(
  client: ThreadClient,
  threadId: string,
  mutation: (version: number) => Promise<T>,
): Promise<T> {
  const current = await client.get(threadId);
  try {
    return await mutation(current.version);
  } catch (cause) {
    if (!(cause instanceof ThreadApiError) || cause.status !== 412) throw cause;
    const refreshed = await client.get(threadId);
    return mutation(refreshed.version);
  }
}

export type UseThreadManagerOptions = {
  client: ThreadClient;
  agentId: string;
  status?: "active" | "archived";
  pageSize?: number;
  selectFirst?: boolean;
};

function sortThreads(threads: AgentThread[]): AgentThread[] {
  return [...threads].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt) || right.id.localeCompare(left.id));
}

function applyEvent(
  threads: AgentThread[],
  event: ThreadEvent,
  status: "active" | "archived",
  agentId: string,
): AgentThread[] {
  const visible = event.thread.status === status && event.thread.agentId === agentId;
  const existing = threads.find((thread) => thread.id === event.thread.id);
  if (visible && existing && existing.version === event.thread.version) return threads;
  const remaining = threads.filter((thread) => thread.id !== event.thread.id);
  if (!visible && remaining.length === threads.length) return threads;
  return visible ? sortThreads([event.thread, ...remaining]) : remaining;
}

export function useThreadManager({
  client,
  agentId,
  status = "active",
  pageSize = 30,
  selectFirst = true,
}: UseThreadManagerOptions) {
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fetchingRef = useRef(false);
  const eventCursorRef = useRef("0");

  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    try {
      const page = await client.list({ agentId, status, limit: pageSize });
      setThreads(page.items);
      setNextCursor(page.nextCursor);
      eventCursorRef.current = page.eventCursor;
      setSelectedThreadId((current) => {
        if (current && page.items.some((thread) => thread.id === current)) return current;
        return selectFirst ? page.items[0]?.id ?? null : null;
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setIsLoading(false);
    }
  }, [agentId, client, pageSize, selectFirst, status]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void loadInitial().then(() => {
      if (disposed) return;
      unsubscribe = client.subscribeToEvents((event) => {
        setThreads((current) => applyEvent(current, event, status, agentId));
        if (event.thread.status !== status || event.thread.agentId !== agentId) {
          setSelectedThreadId((current) => current === event.thread.id ? null : current);
        }
      }, { after: eventCursorRef.current, onError: setError });
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [client, loadInitial, status]);

  useEffect(() => {
    if (selectFirst && !selectedThreadId && threads[0]) {
      setSelectedThreadId(threads[0].id);
    }
  }, [selectFirst, selectedThreadId, threads]);

  const fetchMore = useCallback(async () => {
    if (!nextCursor || fetchingRef.current) return;
    fetchingRef.current = true;
    setIsFetchingMore(true);
    try {
      const page = await client.list({ agentId, status, limit: pageSize, cursor: nextCursor });
      setThreads((current) => {
        const known = new Set(current.map((thread) => thread.id));
        return [...current, ...page.items.filter((thread) => !known.has(thread.id))];
      });
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      fetchingRef.current = false;
      setIsFetchingMore(false);
    }
  }, [agentId, client, nextCursor, pageSize, status]);

  const createThread = useCallback(async (
    options: Omit<CreateThreadOptions, "agentId"> = {},
  ) => {
    const thread = await client.create({ ...options, agentId });
    setThreads((current) => sortThreads([thread, ...current.filter((item) => item.id !== thread.id)]));
    setSelectedThreadId(thread.id);
    return thread;
  }, [agentId, client]);

  const renameThread = useCallback(async (threadId: string, title: string) => {
    try {
      const thread = await mutateLatest(client, threadId, (version) =>
        client.rename(threadId, title, version));
      setThreads((current) => sortThreads([thread, ...current.filter((item) => item.id !== thread.id)]));
      setError(null);
      return thread;
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      await loadInitial();
      setError(failure);
      throw failure;
    }
  }, [client, loadInitial]);

  const archiveThread = useCallback(async (threadId: string) => {
    try {
      await mutateLatest(client, threadId, (version) => client.archive(threadId, version));
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      setSelectedThreadId((selected) => selected === threadId ? null : selected);
      setError(null);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      await loadInitial();
      setError(failure);
      throw failure;
    }
  }, [client, loadInitial]);

  const deleteThread = useCallback(async (threadId: string) => {
    try {
      await mutateLatest(client, threadId, (version) => client.delete(threadId, version));
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      setSelectedThreadId((selected) => selected === threadId ? null : selected);
      setError(null);
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error(String(cause));
      await loadInitial();
      setError(failure);
      throw failure;
    }
  }, [client, loadInitial]);

  return {
    threads,
    selectedThreadId,
    setSelectedThreadId,
    isLoading,
    isFetchingMore,
    hasMore: Boolean(nextCursor),
    error,
    refetch: loadInitial,
    fetchMore,
    createThread,
    renameThread,
    archiveThread,
    deleteThread,
  };
}

export { ThreadClient };
export type { AgentThread, ThreadEvent } from "@kiri_ikki/thread-client";
