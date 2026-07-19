"use client";

import { CopilotChat } from "@copilotkit/react-core/v2";
import { memo } from "react";
import { WeatherToolRenderer } from "./weather-tool-renderer";
import { PurchaseApprovalInterrupt } from "./purchase-approval-interrupt";

const chatLabels = {
  chatInputPlaceholder: "Message the agent...",
  welcomeMessageText: "What would you like to work on?",
};

export const ChatPanel = memo(function ChatPanel({
  threadId,
}: {
  threadId: string;
}) {
  return (
    <main className="chat-shell">
      <header className="chat-head">
        <div>
          <div className="eyebrow"><span className="status-light" /> Agent online</div>
          <h1>Conversation</h1>
        </div>
        <div className="thread-id">{threadId.slice(0, 8)}</div>
      </header>
      <WeatherToolRenderer />
      <PurchaseApprovalInterrupt />
      <div className="copilot-chat-host">
        <CopilotChat
          key={threadId}
          agentId="default"
          threadId={threadId}
          labels={chatLabels}
        />
      </div>
    </main>
  );
});
