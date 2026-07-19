"use client";

import type { AgentThread } from "@kiri_ikki/thread-contracts";
import { Archive, LoaderCircle, MessageSquarePlus, MoreHorizontal, PanelLeft } from "lucide-react";
import { memo, useEffect, useRef } from "react";

interface Props {
  threads: AgentThread[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export const ThreadSidebar = memo(function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onCreate,
  onArchive,
  hasMore,
  loadingMore,
  onLoadMore,
}: Props) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !loadingMore) onLoadMore();
      },
      { root: target.closest(".thread-list"), rootMargin: "120px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand-mark"><PanelLeft size={16} /></div>
        <span>Workspace</span>
        <button className="icon-button subtle" aria-label="Sidebar options" title="Sidebar options">
          <MoreHorizontal size={17} />
        </button>
      </div>
      <button className="new-thread" onClick={onCreate}>
        <MessageSquarePlus size={17} />
        <span>New conversation</span>
      </button>
      <div className="section-label">Conversations</div>
      <nav className="thread-list" aria-label="Conversations">
        {threads.map((thread) => (
          <div key={thread.id} className={`thread-row ${thread.id === activeId ? "selected" : ""}`}>
            <button className="thread-select" onClick={() => onSelect(thread.id)}>
              <span className="thread-dot" />
              <span className="thread-title">{thread.title}</span>
            </button>
            <button
              className="icon-button row-action"
              aria-label={`Archive ${thread.title}`}
              title="Archive conversation"
              onClick={() => onArchive(thread.id)}
            >
              <Archive size={15} />
            </button>
          </div>
        ))}
        {hasMore && (
          <div ref={loadMoreRef} className="thread-list-sentinel" aria-hidden="true">
            {loadingMore && <LoaderCircle className="spin" size={16} />}
          </div>
        )}
      </nav>
      <div className="sidebar-footer">Self-hosted agent runtime</div>
    </aside>
  );
});
