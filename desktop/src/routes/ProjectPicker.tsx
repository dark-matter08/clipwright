import { useEffect, useState } from "react";
import { pickProject, loadProject, checkClaudeAuth } from "../lib/ipc";
import type { ProjectState } from "../lib/types";

export function ProjectPicker({ onOpened }: { onOpened: (s: ProjectState) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    checkClaudeAuth().then(setAuth).catch((e) => setAuth({ ok: false, message: String(e) }));
  }, []);

  async function open() {
    setError(null);
    const path = await pickProject();
    if (!path) return;
    try {
      const state = await loadProject(path);
      onOpened(state);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6">
      <div className="text-center">
        <h1 className="font-mono text-4xl text-accent">CLIPWRIGHT</h1>
        <p className="mt-2 text-sm text-muted">// desktop refinement console</p>
      </div>
      <button
        className="rounded border border-border bg-panel px-6 py-3 font-mono text-sm hover:border-accent hover:text-accent"
        onClick={open}
      >
        OPEN PROJECT
      </button>
      {error && <p className="max-w-md text-center text-sm text-accent2">{error}</p>}
      <div className="fixed bottom-4 right-4 rounded border border-border bg-panel px-3 py-2 text-xs font-mono">
        {auth === null ? (
          <span className="text-muted">checking claude cli…</span>
        ) : auth.ok ? (
          <span className="text-accent">● claude ready — {auth.message}</span>
        ) : (
          <span className="text-accent2">● claude unavailable — run `claude login`</span>
        )}
      </div>
    </div>
  );
}
