import { useEffect, useRef, useState } from "react";
import {
  sendClaudeMessage,
  approveClaudePlan,
  onClaudeEvent,
  getActiveSession,
  loadSessionTranscript,
} from "../lib/ipc";
import type { ClaudeEvent } from "../lib/types";
import { I } from "../lib/icons";

interface Msg {
  role: "user" | "assistant" | "tool" | "plan" | "error";
  content: string;
  tool?: string;
}

export function ChatDock({
  projectPath,
  reloadKey,
  onSessionCreated,
}: {
  projectPath: string;
  reloadKey: number;
  onSessionCreated: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onSessionCreatedRef = useRef(onSessionCreated);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    onSessionCreatedRef.current = onSessionCreated;
  }, [onSessionCreated]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Transcript reload fires only on: project change, or explicit session switch (reloadKey bump).
  // system.init events must NOT reload — they'd wipe the user message we just optimistically appended.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await getActiveSession(projectPath);
      if (cancelled) return;
      setActiveId(id);
      if (id) {
        try {
          const replay = await loadSessionTranscript(projectPath, id);
          if (cancelled) return;
          setMessages(
            replay.map((m) => ({
              role: m.role as Msg["role"],
              content: m.content,
              tool: m.tool ?? undefined,
            })),
          );
        } catch {
          if (!cancelled) setMessages([]);
        }
      } else {
        setMessages([]);
      }
      setPendingPlan(false);
      setBusy(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, reloadKey]);

  // Subscribe to Claude events once per project. Await the listener promise in cleanup
  // so a rapid deps-change doesn't orphan a listener.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const p = onClaudeEvent((e: ClaudeEvent & { runId: number }) => {
      if (e.type === "system") {
        const sid = (e as unknown as { session_id?: string }).session_id;
        if (sid && sid !== activeIdRef.current) {
          const wasNew = activeIdRef.current === null;
          activeIdRef.current = sid;
          setActiveId(sid);
          if (wasNew) onSessionCreatedRef.current();
        }
      } else if (e.type === "assistant") {
        const raw = (e as unknown as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
        const text = raw?.content?.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        if (text) setMessages((m) => [...m, { role: "assistant", content: text }]);
      } else if (e.type === "tool_use") {
        const tu = e as unknown as { name?: string; input?: Record<string, unknown> };
        if (tu.name === "ExitPlanMode") {
          const plan = (tu.input?.plan as string) ?? "(plan proposed)";
          setMessages((m) => [...m, { role: "plan", content: plan }]);
          setPendingPlan(true);
        } else {
          setMessages((m) => [...m, { role: "tool", tool: tu.name, content: JSON.stringify(tu.input ?? {}) }]);
        }
      } else if (e.type === "result") {
        setBusy(false);
      } else if (e.type === "error") {
        setMessages((m) => [...m, { role: "error", content: e.content ?? "error" }]);
        setBusy(false);
      }
    });
    p.then((f) => {
      if (cancelled) f();
      else unlisten = f;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [projectPath]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    setPendingPlan(false);
    await sendClaudeMessage(projectPath, text);
  }

  async function approve() {
    setPendingPlan(false);
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: "[approved]" }]);
    await approveClaudePlan(projectPath);
  }

  return (
    <aside className="flex min-h-0 flex-1 flex-col overflow-hidden border-l border-border">
      <div className="flex items-center justify-between border-b border-border bg-panel/40 px-3 py-2 font-mono text-xs">
        <span className="flex items-center gap-1.5 text-accent">
          <I.Bot size={13} />
          <span>CLAUDE</span>
          <span className="text-muted/70">// full-access</span>
        </span>
        <span className="flex items-center gap-1 text-[10px] text-muted">
          {activeId ? (
            <>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              <span>{activeId.slice(0, 8)}</span>
            </>
          ) : (
            <>
              <span className="inline-block h-1.5 w-1.5 rounded-full border border-muted" />
              <span>new</span>
            </>
          )}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {messages.length === 0 && !busy && (
          <p className="text-muted">// ask claude to refine scripts, zooms, pacing, etc.</p>
        )}
        {messages.map((m, i) => {
          const { icon, label, cls } = roleStyle(m);
          return (
            <div key={i} className="mb-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase text-muted">
                {icon}
                <span>
                  {label}
                  {m.tool ? ` · ${m.tool}` : ""}
                </span>
              </div>
              <div className={`mt-1 whitespace-pre-wrap ${cls}`}>
                {m.role === "plan" ? (
                  <div className="rounded border border-accent/50 bg-panel p-2 text-fg">
                    {m.content}
                  </div>
                ) : (
                  m.content
                )}
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="mb-3 flex items-center gap-1.5 text-[10px] uppercase text-muted">
            <I.Loader size={10} className="animate-spin text-accent" />
            <span>thinking…</span>
          </div>
        )}
        {pendingPlan && (
          <div className="sticky bottom-0 flex gap-2 border-t border-border bg-panel py-2">
            <button
              onClick={approve}
              className="flex flex-1 items-center justify-center gap-1.5 rounded border border-accent bg-accent/10 px-2 py-1 text-accent hover:bg-accent/20"
            >
              <I.Check size={12} /> APPROVE
            </button>
            <button
              onClick={() => setPendingPlan(false)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded border border-border px-2 py-1 text-muted hover:text-fg"
            >
              <I.X size={12} /> REJECT
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-panel/40 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
          disabled={busy}
          placeholder={busy ? "waiting…" : "message claude   (↵ to send, ⇧↵ for newline)"}
          className="w-full rounded border border-border bg-panel p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="flex items-center gap-1.5 rounded border border-accent bg-accent/10 px-3 py-1 font-mono text-xs text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            <I.Send size={12} />
            <span>{busy ? "…" : "SEND"}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function roleStyle(m: Msg): { icon: React.ReactNode; label: string; cls: string } {
  switch (m.role) {
    case "user":
      return { icon: <I.User size={10} className="text-accent" />, label: "user", cls: "text-accent" };
    case "assistant":
      return { icon: <I.Bot size={10} className="text-accent/80" />, label: "assistant", cls: "text-fg" };
    case "plan":
      return {
        icon: <I.Sparkles size={10} className="text-accent" />,
        label: "plan",
        cls: "text-fg",
      };
    case "tool":
      return { icon: <I.Terminal size={10} className="text-muted" />, label: "tool", cls: "text-muted" };
    case "error":
      return { icon: <I.Zap size={10} className="text-accent2" />, label: "error", cls: "text-accent2" };
    default:
      return { icon: null, label: m.role, cls: "text-fg" };
  }
}
