import { useEffect, useRef, useState } from "react";
import type { ProjectState, Clip } from "../lib/types";
import { PipelineBar } from "../components/PipelineBar";
import { ClipList } from "../components/ClipList";
import { ClipDetail } from "../components/ClipDetail";
import { LogPane } from "../components/LogPane";
import { ChatDock } from "../components/ChatDock";
import { onLog, onRunDone, onProgress } from "../lib/ipc";

export function Workspace({
  project,
  onReload,
  onClose,
}: {
  project: ProjectState;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const clips: Clip[] = project.script?.clips ?? [];
  const [selected, setSelected] = useState<string | null>(clips[0]?.id ?? null);
  const [logs, setLogs] = useState<string[]>([]);
  const [activeRun, setActiveRun] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ stage: string; pct?: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    let un3: (() => void) | undefined;
    onLog((e) => setLogs((ls) => [...ls.slice(-500), `[${e.stream}] ${e.line}`])).then((f) => (un1 = f));
    onRunDone((e) => {
      setLogs((ls) => [...ls, `— run ${e.runId} exited code=${e.code} —`]);
      setActiveRun(null);
      setProgress(null);
    }).then((f) => (un2 = f));
    onProgress((e) => setProgress({ stage: e.stage, pct: e.pct })).then((f) => (un3 = f));
    return () => {
      un1?.();
      un2?.();
      un3?.();
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const selectedClip = clips.find((c) => c.id === selected) ?? null;

  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-2 font-mono text-xs">
        <div>
          <span className="text-accent">▸</span> {project.config.name ?? project.path.split("/").pop()}
          <span className="ml-3 text-muted">{project.path}</span>
        </div>
        <button onClick={onClose} className="text-muted hover:text-fg">CLOSE</button>
      </header>

      <div className="grid grid-cols-[280px_1fr_380px] overflow-hidden">
        <aside className="flex flex-col overflow-hidden border-r border-border">
          <PipelineBar
            project={project}
            activeRun={activeRun}
            setActiveRun={setActiveRun}
            onReload={onReload}
          />
          <ClipList clips={clips} selected={selected} onSelect={setSelected} />
        </aside>

        <main className="flex flex-col overflow-hidden">
          {selectedClip ? (
            <ClipDetail
              project={project}
              clip={selectedClip}
              onReload={onReload}
              activeRun={activeRun}
              setActiveRun={setActiveRun}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted font-mono text-sm">
              no clips yet — run script-init after segments exist
            </div>
          )}
          <LogPane logs={logs} progress={progress} innerRef={logRef} />
        </main>

        <ChatDock projectPath={project.path} />
      </div>

      <footer className="border-t border-border bg-panel px-4 py-1 font-mono text-[10px] text-muted">
        aspect {String(project.config.aspect ?? "?")} · fps {String(project.config.fps ?? "?")} · voice {String(project.config.voice_id ?? "?")}
      </footer>
    </div>
  );
}
