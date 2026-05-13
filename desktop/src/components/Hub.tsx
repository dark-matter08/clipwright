// Project Hub — SRS §8.3. Landing view: list recents, offer New / Open.
//
// P1.1 ships only "Open Existing"; the "New Project" wizard lands in P1.2.

import { useEffect, useState } from "react";
import { listRecents, openProject, pickProjectDir } from "../lib/tauri";
import type { RecentProject } from "../lib/types";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { NewProjectDialog } from "./NewProjectDialog";

export function Hub() {
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [busy, setBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    listRecents().then(setRecents).catch(() => setRecents([]));
  }, []);

  // Refresh recents after a New Project flow closes (it may have added one).
  useEffect(() => {
    if (!newOpen) listRecents().then(setRecents).catch(() => {});
  }, [newOpen]);

  async function open(path: string) {
    setBusy(true);
    try {
      const state = await openProject(path);
      loadProject(state);
      const fresh = await listRecents();
      setRecents(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPick() {
    const path = await pickProjectDir();
    if (path) await open(path);
  }

  return (
    <div className="flex h-full w-full items-start justify-center overflow-y-auto bg-bg">
      <div className="flex w-full max-w-2xl flex-col gap-8 px-8 pb-16 pt-16">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-medium tracking-tight">
            Clipwright Studio
          </h1>
          <span className="font-mono text-xs text-fg-muted">v0.1.0</span>
        </header>

        <div className="grid grid-cols-2 gap-3">
          <ActionCard
            label="New Project"
            sub="Record or upload"
            onClick={() => setNewOpen(true)}
            disabled={busy}
          />
          <ActionCard
            label="Open Existing"
            sub="Pick a directory"
            onClick={onPick}
            disabled={busy}
          />
        </div>

        {newOpen && <NewProjectDialog onClose={() => setNewOpen(false)} />}

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-fg-muted">
            Recent
          </h2>
          <div className="rounded border border-border-subtle bg-bg-subtle">
            {recents.length === 0 ? (
              <p className="px-4 py-3 text-sm text-fg-muted">
                No recent projects yet. Open one to get started.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {recents.map((r) => (
                  <li key={r.project_dir}>
                    <button
                      type="button"
                      onClick={() => open(r.project_dir)}
                      disabled={busy}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm",
                        "transition-colors hover:bg-bg-raised disabled:cursor-not-allowed disabled:opacity-50",
                      )}
                    >
                      <span className="text-fg">{r.title || "(untitled)"}</span>
                      <span className="ml-auto truncate font-mono text-xs text-fg-muted">
                        {r.project_dir}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <footer className="text-xs text-fg-muted">
          A project is a plain directory. Open one containing{" "}
          <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono">
            project.json
          </code>
          .
        </footer>
      </div>
    </div>
  );
}

interface ActionCardProps {
  label: string;
  sub: string;
  onClick?: () => void;
  disabled?: boolean;
}

function ActionCard({ label, sub, onClick, disabled }: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group relative flex flex-col items-start gap-1 rounded border border-border-subtle bg-bg-subtle p-5 text-left transition-colors",
        "hover:border-border hover:bg-bg-raised",
        "disabled:cursor-not-allowed disabled:opacity-60",
        !disabled && "focus:focus-ring",
      )}
    >
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-fg-muted">{sub}</span>
    </button>
  );
}
