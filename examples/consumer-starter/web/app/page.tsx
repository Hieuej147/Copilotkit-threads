"use client";

import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2";
import { ThreadClient, useThreadManager } from "@kiri_ikki/thread-react";
import { useEffect, useMemo, useRef } from "react";

const runtimeUrl = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:4000/api/copilotkit";

export default function Page() {
  const initialized = useRef(false);
  const client = useMemo(() => new ThreadClient({
    baseUrl: process.env.NEXT_PUBLIC_THREAD_API_URL ?? "http://localhost:4000",
    credentials: "include",
  }), []);
  const manager = useThreadManager({ client, agentId: "default" });

  useEffect(() => {
    if (!manager.isLoading && !manager.threads.length && !initialized.current) {
      initialized.current = true;
      void manager.createThread();
    }
  }, [manager.createThread, manager.isLoading, manager.threads.length]);

  if (!manager.selectedThreadId) return <main className="center">Preparing conversation...</main>;
  const threadId = manager.selectedThreadId;
  return (
    <CopilotKit key={threadId} runtimeUrl={runtimeUrl} useSingleEndpoint={false} agent="default" threadId={threadId}>
      <div className="shell">
        <aside>
          <button className="new" onClick={() => void manager.createThread()}>New conversation</button>
          <nav>
            {manager.threads.map((thread) => (
              <button className={thread.id === threadId ? "active" : ""} key={thread.id} onClick={() => manager.setSelectedThreadId(thread.id)}>
                {thread.title}
              </button>
            ))}
            {manager.hasMore && <button onClick={() => void manager.fetchMore()}>Load more</button>}
          </nav>
        </aside>
        <main><CopilotChat key={threadId} agentId="default" threadId={threadId} /></main>
      </div>
    </CopilotKit>
  );
}
