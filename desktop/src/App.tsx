import { useEffect, useState } from "react";
import { ProjectPicker } from "./routes/ProjectPicker";
import { Workspace } from "./routes/Workspace";
import type { ProjectState } from "./lib/types";
import { loadProject, startWatcher, onArtifactChange } from "./lib/ipc";

export default function App() {
  const [project, setProject] = useState<ProjectState | null>(null);

  useEffect(() => {
    if (!project) return;
    let unlisten: (() => void) | undefined;
    startWatcher(project.path);
    onArtifactChange(async () => {
      const fresh = await loadProject(project.path);
      setProject(fresh);
    }).then((fn) => (unlisten = fn));
    return () => {
      unlisten?.();
    };
  }, [project?.path]);

  return (
    <div className="h-full w-full bg-bg text-fg">
      {project ? (
        <Workspace project={project} onReload={async () => setProject(await loadProject(project.path))} onClose={() => setProject(null)} />
      ) : (
        <ProjectPicker onOpened={setProject} />
      )}
    </div>
  );
}
