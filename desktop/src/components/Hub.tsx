// Project Hub — SRS §8.3. Landing view: list recents, offer New / Open.
//
// P1.1 ships only "Open Existing"; the "New Project" wizard lands in P1.2.

import { useEffect, useState } from "react";
import { FolderOpen, Sparkles } from "lucide-react";
import { listRecents, openProject, pickProjectDir } from "../lib/tauri";
import type { RecentProject } from "../lib/types";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { HubBackground } from "./HubBackground";
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
    <div className="relative flex h-full w-full items-start justify-center overflow-y-auto bg-bg">
      {/* Editing-motif background — film strips, timeline ruler,
       *  waveform line, scattered keyframe diamonds. Pointer-
       *  events disabled, sits behind the content. Theme-aware via
       *  the design-system tokens. */}
      <HubBackground />
      <div className="relative z-10 flex w-full max-w-2xl flex-col gap-8 px-8 pb-16 pt-16">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-medium tracking-tight">
            Clipwright Studio
          </h1>
          <span className="font-mono text-xs text-fg-muted">v0.1.0</span>
        </header>

        <div className="grid grid-cols-2 gap-3">
          <ActionCard
            icon={<Sparkles size={22} strokeWidth={1.75} />}
            label="New Project"
            sub="Record or upload"
            onClick={() => setNewOpen(true)}
            disabled={busy}
          />
          <ActionCard
            icon={<FolderOpen size={22} strokeWidth={1.75} />}
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
  icon?: React.ReactNode;
  label: string;
  sub: string;
  onClick?: () => void;
  disabled?: boolean;
}

function ActionCard({ icon, label, sub, onClick, disabled }: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        // The action cards lift OFF the page now — `bg-surface` is
        // the pure-white card token in light mode, distinct from
        // the slate-tinted page bg below. A 1px accent border
        // shows up on hover, replacing the v2 "everything is gray"
        // hover state with a clear color signal.
        "group relative flex flex-col items-start gap-2 rounded border border-border-subtle bg-surface p-5 text-left shadow-sm transition-all",
        "hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md",
        "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:border-border-subtle disabled:hover:shadow-sm",
        !disabled && "focus:focus-ring",
      )}
    >
      {icon && (
        // Icon swatch — accent-tinted circle that the icon sits
        // inside. Adds a real spot of brand color to the card
        // instead of the previous "gray icon on gray card."
        <span className="flex h-10 w-10 items-center justify-center rounded bg-accent/10 text-accent transition-colors group-hover:bg-accent/15 group-hover:text-accent-hover">
          {icon}
        </span>
      )}
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-fg-muted">{sub}</span>
    </button>
  );
}
