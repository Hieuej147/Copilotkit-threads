"use client";

import {
  CopilotChat,
  CopilotChatConfigurationProvider,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { memo, useEffect, useRef } from "react";
import { HookLab } from "./hook-lab";

const chatLabels = {
  chatInputPlaceholder: "Message the agent...",
  welcomeMessageText: "What would you like to work on?",
};

export type PendingChatMessage = { id: string; content: string };

function PendingMessageDispatcher({
  message,
  onDispatched,
}: {
  message: PendingChatMessage | null;
  onDispatched: (messageId: string) => void;
}) {
  const { agent } = useAgent({ agentId: "default" });
  const { copilotkit } = useCopilotKit();
  const dispatchedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!message || dispatchedRef.current === message.id) return;
    dispatchedRef.current = message.id;
    agent.addMessage({ id: message.id, role: "user", content: message.content });
    onDispatched(message.id);
    void copilotkit.runAgent({ agent });
  }, [agent, copilotkit, message, onDispatched]);

  return null;
}

export const ChatPanel = memo(function ChatPanel({
  threadId,
  pendingMessage,
  onPendingMessageDispatched,
}: {
  threadId: string;
  pendingMessage: PendingChatMessage | null;
  onPendingMessageDispatched: (messageId: string) => void;
}) {
  return (
    <CopilotChatConfigurationProvider agentId="default" threadId={threadId}>
      <main className="chat-shell">
        <PendingMessageDispatcher
          message={pendingMessage}
          onDispatched={onPendingMessageDispatched}
        />
        <header className="chat-head">
          <div>
            <div className="eyebrow"><span className="status-light" /> Agent online</div>
            <h1>Conversation</h1>
          </div>
          <div className="thread-id">{threadId.slice(0, 8)}</div>
        </header>
        <HookLab expectedThreadId={threadId} />
        <div className="copilot-chat-host">
          <CopilotChat
            key={threadId}
            agentId="default"
            threadId={threadId}
            labels={chatLabels}
          />
        </div>
      </main>
    </CopilotChatConfigurationProvider>
  );
});
