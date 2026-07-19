"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import { ThreadClient, useThreadManager } from "@threads/react";
import { useCallback, useEffect, useRef } from "react";
import { ChatPanel } from "./chat-panel";
import { ThreadSidebar } from "./thread-sidebar";

const runtimeUrl = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:4000/api/copilotkit";
const threadClient = new ThreadClient({
  baseUrl: process.env.NEXT_PUBLIC_THREAD_API_URL ?? "http://localhost:4000",
  credentials: "include",
});

export function ThreadedApp() {
  const initialized = useRef(false);
  const manager = useThreadManager({ client: threadClient, agentId: "default" });

  useEffect(() => {
    if (manager.isLoading || manager.threads.length || manager.selectedThreadId || initialized.current) return;
    initialized.current = true;
    void manager.createThread();
  }, [manager.createThread, manager.isLoading, manager.selectedThreadId, manager.threads.length]);

  const handleCreate = useCallback(() => void manager.createThread(), [manager.createThread]);
  const handleArchive = useCallback((id: string) => void manager.archiveThread(id), [manager.archiveThread]);

  if (manager.isLoading) return <main className="loading-screen">Connecting to your workspace...</main>;
  if (manager.error && !manager.threads.length) {
    return <main className="loading-screen error-state">{manager.error.message}</main>;
  }
  if (!manager.selectedThreadId) return <main className="loading-screen">Creating a conversation...</main>;

  const threadId = manager.selectedThreadId;
  return (
    <CopilotKit
      key={threadId}
      runtimeUrl={runtimeUrl}
      useSingleEndpoint={false}
      agent="default"
      threadId={threadId}
    >
      <div className="shell">
        <ThreadSidebar
          threads={manager.threads}
          activeId={threadId}
          onSelect={manager.setSelectedThreadId}
          onCreate={handleCreate}
          onArchive={handleArchive}
          hasMore={manager.hasMore}
          loadingMore={manager.isFetchingMore}
          onLoadMore={manager.fetchMore}
        />
        <ChatPanel key={threadId} threadId={threadId} />
      </div>
    </CopilotKit>
  );
}
