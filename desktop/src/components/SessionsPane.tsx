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
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listClaudeSessions(projectPath)
      .then((s) => {
        setSessions(s);
        setLoaded(true);
      })
      .catch(() => {
        setSessions([]);
        setLoaded(true);
      });
  }, [projectPath, refreshKey]);

  async function activate(id: string) {
    await setActiveSession(projectPath, id);
    const fresh = await listClaudeSessions(projectPath);
    setSessions(fresh);
    onSessionChange(id);
  }

  async function newSession() {
    await clearActiveSession(projectPath);
    const fresh = await listClaudeSessions(projectPath);
    setSessions(fresh);
    onSessionChange(null);
    setOpen(true);
  }

  const active = sessions.find((s) => s.active);
  const others = sessions.filter((s) => !s.active);
  const showEmpty = loaded && sessions.length === 0;

  return (
    <div className="flex max-h-[40%] shrink-0 flex-col overflow-hidden border-b border-border">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 font-mono text-[11px] uppercase text-muted hover:text-fg"
        >
          <span>{open ? "▾" : "▸"}</span>
          <span>sessions</span>
          <span className="normal-case text-[10px] text-muted">
            ({sessions.length}
            {active ? ` · current ${active.id.slice(0, 8)}` : " · no current"})
          </span>
        </button>
        <button
          onClick={newSession}
          className="font-mono text-[10px] text-accent hover:underline"
          title="Start a new session — prior sessions remain available below"
        >
          + NEW
        </button>
      </div>
      {open && (
        <div className="flex-1 overflow-y-auto">
          {showEmpty && (
            <p className="px-2 py-2 font-mono text-[10px] text-muted">// no prior sessions</p>
          )}
          {active && <SessionRow session={active} onResume={activate} isActive />}
          {!active && sessions.length > 0 && (
            <p className="border-b border-border px-2 py-1 font-mono text-[10px] text-muted">
              // no active session — RESUME one below, or send a message to start fresh
            </p>
          )}
          {others.map((s) => (
            <SessionRow key={s.id} session={s} onResume={activate} isActive={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  onResume,
  isActive,
}: {
  session: SessionInfo;
  onResume: (id: string) => void;
  isActive: boolean;
}) {
  return (
    <div
      className={
        "flex items-start justify-between gap-2 border-b border-border px-2 py-1 font-mono text-[10px] " +
        (isActive ? "border-l-2 border-l-accent bg-panel" : "hover:bg-panel/50")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-fg">{session.id.slice(0, 8)}</span>
          {isActive && (
            <span className="rounded bg-accent/20 px-1 text-[9px] uppercase text-accent">
              current
            </span>
          )}
          <span className="ml-auto text-muted">
            {fmtDate(session.lastModified)} · {session.messageCount}
          </span>
        </div>
        <div className="mt-1 truncate text-muted">{session.firstMessage || "(empty)"}</div>
      </div>
      {!isActive && (
        <button
          onClick={() => onResume(session.id)}
          className="shrink-0 self-center rounded border border-border px-2 py-0.5 text-[9px] uppercase text-muted hover:border-accent hover:text-accent"
        >
          resume
        </button>
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
