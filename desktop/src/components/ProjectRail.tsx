import { useEffect, useState } from "react";
import { listKnownProjects, forgetProject, type KnownProject } from "../lib/ipc";
import { I } from "../lib/icons";

export function ProjectRail({
  activePath,
  onOpen,
  onNew,
  refreshKey,
}: {
  activePath: string | null;
  onOpen: (path: string) => void;
  onNew: () => void;
  refreshKey: number;
}) {
  const [projects, setProjects] = useState<KnownProject[]>([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    listKnownProjects().then(setProjects).catch(() => setProjects([]));
  }, [refreshKey, activePath]);

  async function forget(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    await forgetProject(path);
    setProjects(await listKnownProjects());
  }

  const width = expanded ? "w-56" : "w-12";

  return (
    <aside
      className={`${width} flex shrink-0 flex-col overflow-hidden border-r border-border bg-panel/40 transition-[width]`}
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-2">
        {expanded && (
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted">
            <I.Layers size={12} strokeWidth={1.75} className="text-accent/70" />
            <span>projects</span>
          </span>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center rounded p-1 text-muted hover:bg-panel hover:text-fg"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <I.PanelLeftClose size={14} /> : <I.PanelLeft size={14} />}
        </button>
      </div>

      <button
        onClick={onNew}
        className="m-2 flex items-center gap-2 rounded border border-border px-2 py-1.5 text-left font-mono text-[11px] text-accent hover:border-accent hover:bg-accent/5"
        title="New or open project"
      >
        <I.FolderPlus size={14} className="shrink-0" />
        {expanded && <span>NEW / OPEN</span>}
      </button>

      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 && expanded && (
          <p className="px-2 py-2 font-mono text-[10px] text-muted">// no recent projects</p>
        )}
        {projects.map((p) => {
          const isActive = p.path === activePath;
          return (
            <button
              key={p.path}
              onClick={() => p.exists && onOpen(p.path)}
              disabled={!p.exists}
              className={
                "group relative flex w-full items-center gap-2 border-b border-border/50 px-2 py-2 text-left font-mono text-[11px] " +
                (isActive
                  ? "border-l-2 border-l-accent bg-panel text-fg"
                  : "text-muted hover:bg-panel/50 hover:text-fg") +
                (p.exists ? "" : " opacity-40")
              }
              title={expanded ? p.path : `${p.name} — ${p.path}`}
            >
              {isActive ? (
                <I.FolderOpen size={13} className="shrink-0 text-accent" />
              ) : (
                <I.Folder size={13} className="shrink-0 text-accent/70" />
              )}
              {expanded && (
                <>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {!p.exists && <span className="text-[9px] text-accent2">missing</span>}
                  <button
                    onClick={(e) => forget(e, p.path)}
                    className="hidden shrink-0 rounded p-0.5 text-muted hover:bg-accent2/10 hover:text-accent2 group-hover:inline-flex"
                    title="Forget this project (does not delete files)"
                  >
                    <I.X size={11} />
                  </button>
                </>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
