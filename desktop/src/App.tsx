import { useEffect, useState } from "react";
import { ProjectPicker } from "./routes/ProjectPicker";
import { Workspace } from "./routes/Workspace";
import { ProjectRail } from "./components/ProjectRail";
import type { ProjectState } from "./lib/types";
import { loadProject, startWatcher, onArtifactChange } from "./lib/ipc";
import { I } from "./lib/icons";

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
      {project && (
        <ProjectRail
          activePath={project.path}
          onOpen={openByPath}
          onNew={() => setPickerOpen(true)}
          refreshKey={railKey}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {project ? (
          <Workspace
            project={project}
            onReload={async () => setProject(await loadProject(project.path))}
            onClose={() => setProject(null)}
          />
        ) : (
          <ProjectPicker
            onOpened={(s) => {
              setProject(s);
              setPickerOpen(false);
              setRailKey((k) => k + 1);
            }}
          />
        )}
      </div>

      {pickerOpen && project && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="relative max-h-[90vh] w-full max-w-5xl overflow-auto rounded border border-border bg-bg shadow-2xl">
            <button
              onClick={() => setPickerOpen(false)}
              className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded border border-border px-2 py-1 font-mono text-[10px] uppercase text-muted hover:border-accent hover:text-accent"
            >
              <I.X size={11} /> close
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
