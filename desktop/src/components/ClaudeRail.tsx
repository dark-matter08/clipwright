// Claude rail — SRS §8.5.5 + §9.
//
// Mode A: persistent chat. Each turn invokes `claude --print --continue`
//         under the project directory, with the project-scoped system
//         prompt from `clipwright agent prompt`.
//
// Mode B: per-segment scoped invocation, triggered by the timeline's
//         "Ask Claude…" context menu item. We surface the active segment
//         id under the input so the user always knows what's in scope.
//
// History is persisted to `<project>/chat/sessions/<date>.jsonl` by Rust
// so the UI can repopulate on app restart.

import { useEffect, useRef, useState } from "react";
import {
  claudeChat,
  claudeDoctor,
  loadChatHistory,
  type ChatHistoryEntry,
} from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";

interface ClaudeRailProps {
  collapsed: boolean;
}

export function ClaudeRail({ collapsed }: ClaudeRailProps) {
  const project = useApp((s) => s.project);
  const toggle = useApp((s) => s.toggleClaudeRail);
  const setError = useApp((s) => s.setError);
  const askSegId = useApp((s) => s.pendingAskSegmentId);
  const clearAsk = useApp((s) => s.clearPendingAsk);

  const [history, setHistory] = useState<ChatHistoryEntry[]>([]);
  const [pending, setPending] = useState<{ role: "user"; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    claudeDoctor().then((r) => setInstalled(r.installed)).catch(() => setInstalled(false));
  }, []);

  useEffect(() => {
    if (!project?.video) {
      setHistory([]);
      return;
    }
    loadChatHistory(project.project_dir, project.video.video_id)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [project?.project_dir, project?.video?.video_id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, pending, busy]);

  async function send() {
    if (!project?.video || !draft.trim()) return;
    const message = draft.trim();
    const segId = askSegId;
    const videoId = project.video.video_id;
    setDraft("");
    setPending({ role: "user", text: message });
    setBusy(true);
    try {
      const res = await claudeChat(project.project_dir, { message, videoId, segId });
      const now = new Date().toISOString();
      setHistory((h) => [
        ...h,
        { ts: now, role: "user", text: message },
        { ts: now, role: "assistant", text: res.reply },
      ]);
      setPending(null);
      if (segId) clearAsk();
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Open Claude rail (⌘\\)"
        className="flex h-full w-full flex-col items-center justify-start gap-3 pt-3 text-fg-muted transition-colors hover:text-fg"
      >
        <span className="text-base">⌘</span>
        <span className="rotate-180 [writing-mode:vertical-rl] text-xs">Claude</span>
      </button>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Claude
        </span>
        <div className="flex items-center gap-2">
          {installed === false && (
            <span
              className="rounded bg-warn/20 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn"
              title="The `claude` CLI is not on PATH. Install Claude Code to enable chat."
            >
              CLI missing
            </span>
          )}
          <button
            type="button"
            onClick={toggle}
            title="Collapse rail (⌘\\)"
            className="text-fg-muted transition-colors hover:text-fg"
          >
            ◀
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {history.length === 0 && !pending && (
          <p className="text-xs text-fg-muted">
            Ask Claude anything about this project. Right-click a segment for a
            scoped ask.
          </p>
        )}
        <div className="flex flex-col gap-3 text-sm">
          {history.map((m, i) => (
            <ChatBubble key={i} role={m.role} text={m.text} />
          ))}
          {pending && <ChatBubble role={pending.role} text={pending.text} />}
          {busy && <ChatBubble role="assistant" text="…" muted />}
        </div>
        <div ref={bottomRef} />
      </div>

      <div className="flex flex-col gap-1 border-t border-border-subtle p-2">
        {askSegId && (
          <div className="flex items-center justify-between rounded bg-accent/10 px-2 py-1 text-[11px] text-accent">
            <span>
              Scoped to <span className="font-mono">{askSegId}</span>
            </span>
            <button
              type="button"
              onClick={clearAsk}
              className="text-fg-muted hover:text-fg"
            >
              clear ✕
            </button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={
            installed === false
              ? "Install Claude Code to enable chat"
              : askSegId
                ? `Ask Claude about ${askSegId}…  (⌘⏎)`
                : "Ask Claude about this project…  (⌘⏎)"
          }
          disabled={installed === false || busy}
          className="w-full resize-none rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}

function ChatBubble({
  role,
  text,
  muted,
}: {
  role: "user" | "assistant";
  text: string;
  muted?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div
      className={cn(
        "rounded px-2.5 py-2 text-sm",
        isUser
          ? "self-end max-w-[90%] bg-accent/15 text-fg"
          : "max-w-full bg-bg-inset text-fg-subtle",
        muted && "italic text-fg-muted",
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        {role}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}
