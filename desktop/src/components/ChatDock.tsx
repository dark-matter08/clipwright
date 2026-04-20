import { useEffect, useRef, useState } from "react";
import { sendClaudeMessage, approveClaudePlan, onClaudeEvent } from "../lib/ipc";
import type { ClaudeEvent } from "../lib/types";

interface Msg {
  role: "user" | "assistant" | "tool" | "plan" | "error";
  content: string;
  tool?: string;
}

export function ChatDock({ projectPath }: { projectPath: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    onClaudeEvent((e: ClaudeEvent & { runId: number }) => {
      if (e.type === "assistant") {
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
    }).then((f) => (un = f));
    return () => {
      un?.();
    };
  }, []);

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
    <aside className="flex flex-col overflow-hidden border-l border-border">
      <div className="border-b border-border px-3 py-2 font-mono text-xs text-accent">CLAUDE // plan-mode</div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
        {messages.length === 0 && (
          <p className="text-muted">// ask claude to refine scripts, zooms, pacing, etc.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className="mb-3">
            <div className="text-[10px] uppercase text-muted">
              {m.role}{m.tool ? ` · ${m.tool}` : ""}
            </div>
            <div
              className={
                m.role === "plan"
                  ? "mt-1 whitespace-pre-wrap rounded border border-accent/50 bg-panel p-2 text-fg"
                  : m.role === "user"
                  ? "mt-1 whitespace-pre-wrap text-accent"
                  : m.role === "error"
                  ? "mt-1 whitespace-pre-wrap text-accent2"
                  : m.role === "tool"
                  ? "mt-1 whitespace-pre-wrap text-muted"
                  : "mt-1 whitespace-pre-wrap text-fg"
              }
            >
              {m.content}
            </div>
          </div>
        ))}
        {pendingPlan && (
          <div className="sticky bottom-0 flex gap-2 border-t border-border bg-panel py-2">
            <button
              onClick={approve}
              className="flex-1 rounded border border-accent bg-accent/10 px-2 py-1 text-accent hover:bg-accent/20"
            >
              APPROVE
            </button>
            <button
              onClick={() => setPendingPlan(false)}
              className="flex-1 rounded border border-border px-2 py-1 text-muted hover:text-fg"
            >
              REJECT
            </button>
          </div>
        )}
      </div>
      <div className="border-t border-border p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
          disabled={busy}
          placeholder={busy ? "waiting…" : "message claude   (⌘↵)"}
          className="w-full rounded border border-border bg-panel p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50"
        />
      </div>
    </aside>
  );
}
