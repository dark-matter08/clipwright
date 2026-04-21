import { useEffect, useState } from "react";
import {
  listClaudeSessions,
  setActiveSession,
  clearActiveSession,
  type SessionInfo,
} from "../lib/ipc";

export function SessionsPane({
  projectPath,
  onSessionChange,
  refreshKey,
}: {
  projectPath: string;
  onSessionChange: (id: string | null) => void;
  refreshKey: number;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    listClaudeSessions(projectPath).then(setSessions).catch(() => setSessions([]));
  }, [projectPath, refreshKey]);

  async function activate(id: string) {
    await setActiveSession(projectPath, id);
    const fresh = await listClaudeSessions(projectPath);
    setSessions(fresh);
    onSessionChange(id);
    setOpen(false);
  }

  async function newSession() {
    await clearActiveSession(projectPath);
    const fresh = await listClaudeSessions(projectPath);
    setSessions(fresh);
    onSessionChange(null);
    setOpen(false);
  }

  const active = sessions.find((s) => s.active);

  return (
    <div className={"flex shrink-0 flex-col overflow-hidden border-b border-border " + (open ? "max-h-56" : "")}>
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 font-mono text-[11px] uppercase text-muted hover:text-fg"
        >
          <span>{open ? "▾" : "▸"}</span>
          <span>sessions</span>
          <span className="normal-case text-[10px] text-muted">
            ({sessions.length}
            {active ? ` · ◉ ${active.id.slice(0, 8)}` : ""})
          </span>
        </button>
        <button
          onClick={newSession}
          className="font-mono text-[10px] text-accent hover:underline"
        >
          + NEW
        </button>
      </div>
      {open && (
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 && (
          <p className="px-2 py-2 font-mono text-[10px] text-muted">// no prior sessions</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => activate(s.id)}
            className={
              "block w-full border-b border-border px-2 py-1 text-left font-mono text-[10px] hover:bg-panel/50 " +
              (s.active ? "border-l-2 border-l-accent bg-panel" : "")
            }
          >
            <div className="flex justify-between">
              <span className="text-fg">{s.id.slice(0, 8)}</span>
              <span className="text-muted">{fmtDate(s.lastModified)} · {s.messageCount}</span>
            </div>
            <div className="mt-1 truncate text-muted">{s.firstMessage || "(empty)"}</div>
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

function fmtDate(unix: number): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
