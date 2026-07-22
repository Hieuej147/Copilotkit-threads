"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import { ThreadClient, useThreadManager } from "@kiri_ikki/thread-react";
import { useCallback, useState } from "react";
import { ChatPanel, type PendingChatMessage } from "./chat-panel";
import { DraftChatPanel } from "./draft-chat-panel";
import { ThreadSidebar } from "./thread-sidebar";
import { agentId } from "../lib/config";

const runtimeUrl = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:4000/api/copilotkit";
const threadClient = new ThreadClient({
  baseUrl: process.env.NEXT_PUBLIC_THREAD_API_URL ?? "http://localhost:4000",
  credentials: "include",
});

export function ThreadedApp() {
  const manager = useThreadManager({ client: threadClient, agentId });
  const [draftMode, setDraftMode] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [draftError, setDraftError] = useState<Error | null>(null);
  const [pendingMessage, setPendingMessage] = useState<PendingChatMessage | null>(null);

  const handleCreate = useCallback(() => {
    setDraftMode(true);
    setDraftError(null);
    setPendingMessage(null);
  }, []);
  const handleArchive = useCallback((id: string) => {
    void manager.archiveThread(id).catch(() => undefined);
  }, [manager.archiveThread]);
  const handleSelect = useCallback((id: string) => {
    setDraftMode(false);
    setDraftError(null);
    setPendingMessage(null);
    manager.setSelectedThreadId(id);
  }, [manager.setSelectedThreadId]);
  const handleDraftSubmit = useCallback(async (content: string) => {
    if (isCreating) return;
    setIsCreating(true);
    setDraftError(null);
    try {
      const thread = await manager.createThread();
      setPendingMessage({ id: crypto.randomUUID(), content });
      setDraftMode(false);
      manager.setSelectedThreadId(thread.id);
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setIsCreating(false);
    }
  }, [isCreating, manager.createThread, manager.setSelectedThreadId]);
  const handlePendingMessageDispatched = useCallback((messageId: string) => {
    setPendingMessage((current) => current?.id === messageId ? null : current);
  }, []);

  if (manager.isLoading) return <main className="loading-screen">Connecting to your workspace...</main>;
  const showDraft = draftMode || !manager.selectedThreadId;

  if (showDraft) {
    return (
      <div className="shell">
        <ThreadSidebar
          threads={manager.threads}
          activeId={null}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onArchive={handleArchive}
          hasMore={manager.hasMore}
          loadingMore={manager.isFetchingMore}
          onLoadMore={manager.fetchMore}
        />
        <DraftChatPanel
          isCreating={isCreating}
          error={draftError ?? manager.error}
          onSubmit={handleDraftSubmit}
        />
      </div>
    );
  }

  const threadId = manager.selectedThreadId!;
  return (
    <CopilotKit
      key={threadId}
      runtimeUrl={runtimeUrl}
      useSingleEndpoint={false}
      agent={agentId}
      threadId={threadId}
    >
      <div className="shell">
        <ThreadSidebar
          threads={manager.threads}
          activeId={threadId}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onArchive={handleArchive}
          hasMore={manager.hasMore}
          loadingMore={manager.isFetchingMore}
          onLoadMore={manager.fetchMore}
        />
        <ChatPanel
          key={threadId}
          threadId={threadId}
          pendingMessage={pendingMessage}
          onPendingMessageDispatched={handlePendingMessageDispatched}
          threadError={manager.error}
        />
      </div>
    </CopilotKit>
  );
}
