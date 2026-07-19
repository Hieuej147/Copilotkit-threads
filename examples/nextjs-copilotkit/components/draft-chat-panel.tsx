"use client";

import { ArrowUp, MessageSquareText } from "lucide-react";
import { FormEvent, KeyboardEvent, useState } from "react";

export function DraftChatPanel({
  isCreating,
  error,
  onSubmit,
}: {
  isCreating: boolean;
  error: Error | null;
  onSubmit: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");

  const submit = async () => {
    const content = message.trim();
    if (!content || isCreating) return;
    await onSubmit(content);
    setMessage("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <main className="chat-shell draft-chat-shell">
      <header className="chat-head">
        <div>
          <div className="eyebrow"><span className="status-light" /> Agent online</div>
          <h1>New conversation</h1>
        </div>
      </header>
      <div className="draft-chat-body">
        <section className="empty-chat">
          <div className="empty-icon"><MessageSquareText size={22} /></div>
          <h2>What would you like to work on?</h2>
        </section>
        {error && <div className="run-error">{error.message}</div>}
      </div>
      <form className="draft-composer-wrap" onSubmit={handleSubmit}>
        <div className="composer">
          <textarea
            autoFocus
            aria-label="Message the agent"
            disabled={isCreating}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent..."
            rows={1}
            value={message}
          />
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            disabled={!message.trim() || isCreating}
          >
            <ArrowUp size={17} />
          </button>
        </div>
        <div className="composer-note">{isCreating ? "Starting conversation..." : ""}</div>
      </form>
    </main>
  );
}
