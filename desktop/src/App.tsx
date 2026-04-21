import { useEffect, useState } from "react";
import { ProjectPicker } from "./routes/ProjectPicker";
import { Workspace } from "./routes/Workspace";
import { ProjectRail } from "./components/ProjectRail";
import type { ProjectState } from "./lib/types";
import { loadProject, startWatcher, onArtifactChange } from "./lib/ipc";

export default function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [railKey, setRailKey] = useState(0);

  useEffect(() => {
    if (!project) return;
    let unlisten: (() => void) | undefined;
    startWatcher(project.path);
    onArtifactChange(async (_ev) => {
      const fresh = await loadProject(project.path);
      setProject(fresh);
    }).then((fn) => (unlisten = fn));
    return () => {
      unlisten?.();
    };
  }, [project?.path]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setPickerOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function openByPath(path: string) {
    try {
      const state = await loadProject(path);
      setProject(state);
      setPickerOpen(false);
      setRailKey((k) => k + 1);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="flex h-full w-full bg-bg text-fg">
      <ProjectRail
        activePath={project?.path ?? null}
        onOpen={openByPath}
        onNew={() => setPickerOpen(true)}
        refreshKey={railKey}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {project ? (
          <Workspace
            project={project}
            onReload={async () => setProject(await loadProject(project.path))}
            onClose={() => setProject(null)}
          />
        ) : (
          <EmptyState onNew={() => setPickerOpen(true)} />
        )}
      </div>

      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="relative max-h-[90vh] w-full max-w-3xl overflow-auto rounded border border-border bg-bg p-4 shadow-2xl">
            <button
              onClick={() => setPickerOpen(false)}
              className="absolute right-3 top-3 font-mono text-xs text-muted hover:text-fg"
            >
              CLOSE ✕
            </button>
            <ProjectPicker
              onOpened={(s) => {
                setProject(s);
                setPickerOpen(false);
                setRailKey((k) => k + 1);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-bg">
      <div className="text-center">
        <h1 className="font-mono text-4xl text-accent">CLIPWRIGHT</h1>
        <p className="mt-2 font-mono text-xs text-muted">
          // open or create a project to begin
        </p>
      </div>
      <button
        onClick={onNew}
        className="rounded border border-border bg-panel px-6 py-3 font-mono text-sm hover:border-accent hover:text-accent"
      >
        NEW / OPEN PROJECT
      </button>
      <p className="font-mono text-[10px] text-muted">⌘O to open anytime</p>
    </div>
  );
}
