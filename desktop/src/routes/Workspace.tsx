import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectState, VideoState, Clip } from "../lib/types";
import { PipelineBar } from "../components/PipelineBar";
import { ClipList } from "../components/ClipList";
import { ClipDetail } from "../components/ClipDetail";
import { LogPane } from "../components/LogPane";
import { ChatDock } from "../components/ChatDock";
import { FilesPane } from "../components/FilesPane";
import { SessionsPane } from "../components/SessionsPane";
import { FileViewer } from "../components/FileViewer";
import { VideoRail } from "../components/VideoRail";
import { loadVideo, onLog, onRunDone, onProgress } from "../lib/ipc";

export function Workspace({
  project,
  onReload,
  onClose,
}: {
  project: ProjectState;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [activeSlug, setActiveSlug] = useState<string | null>(project.videos[0]?.slug ?? null);
  const [activeVideo, setActiveVideo] = useState<VideoState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [activeRun, setActiveRun] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ stage: string; pct?: number } | null>(null);
  const [sessionsListKey, setSessionsListKey] = useState(0);
  const [chatReloadKey, setChatReloadKey] = useState(0);
  const [openFile, setOpenFile] = useState<{ abs: string; rel: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeSlug && project.videos.length > 0) {
      setActiveSlug(project.videos[0].slug);
    }
    if (activeSlug && !project.videos.find((v) => v.slug === activeSlug)) {
      setActiveSlug(project.videos[0]?.slug ?? null);
    }
  }, [project.videos, activeSlug]);

  useEffect(() => {
    let alive = true;
    if (!activeSlug) {
      setActiveVideo(null);
      return;
    }
    loadVideo(project.path, activeSlug).then((v) => {
      if (!alive) return;
      setActiveVideo(v);
      const firstClip = v.script?.clips?.[0]?.id ?? null;
      setSelected(firstClip);
    }).catch(() => {
      if (alive) setActiveVideo(null);
    });
    return () => {
      alive = false;
    };
  }, [project.path, activeSlug, project.videos]);

  const reloadActive = async () => {
    await onReload();
    if (activeSlug) {
      try {
        const v = await loadVideo(project.path, activeSlug);
        setActiveVideo(v);
      } catch {
        /* ignore */
      }
    }
  };

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

  const clips: Clip[] = activeVideo?.script?.clips ?? [];
  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selected) ?? null,
    [clips, selected],
  );

  return (
    <div className="grid h-full grid-rows-[auto_auto_1fr_auto]">
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-2 font-mono text-xs">
        <div>
          <span className="text-accent">▸</span> {project.config.name ?? project.path.split("/").pop()}
          <span className="ml-3 text-muted">{project.path}</span>
        </div>
        <button onClick={onClose} className="text-muted hover:text-fg">CLOSE</button>
      </header>

      <VideoRail
        projectPath={project.path}
        videos={project.videos}
        activeSlug={activeSlug}
        onSelect={setActiveSlug}
        onReload={onReload}
      />

      <div className="grid grid-cols-[280px_1fr_380px] overflow-hidden">
        <aside className="flex flex-col overflow-hidden border-r border-border">
          {activeVideo && (
            <PipelineBar
              projectPath={project.path}
              video={activeVideo}
              activeRun={activeRun}
              setActiveRun={setActiveRun}
              onReload={reloadActive}
            />
          )}
          {clips.length > 0 && (
            <ClipList
              clips={clips}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                setOpenFile(null);
              }}
            />
          )}
          <FilesPane
            projectPath={project.path}
            onOpenFile={(abs, rel) => {
              setOpenFile({ abs, rel });
              setSelected(null);
            }}
          />
        </aside>

        <main className="flex flex-col overflow-hidden">
          {openFile ? (
            <FileViewer
              absPath={openFile.abs}
              rel={openFile.rel}
              onClose={() => setOpenFile(null)}
            />
          ) : selectedClip && activeSlug ? (
            <ClipDetail
              projectPath={project.path}
              videoSlug={activeSlug}
              clip={selectedClip}
              onReload={reloadActive}
              activeRun={activeRun}
              setActiveRun={setActiveRun}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted font-mono text-sm">
              {project.videos.length === 0
                ? "no videos yet — click + NEW VIDEO above"
                : "click a file on the left, or run script-init after segments exist"}
            </div>
          )}
          <LogPane logs={logs} progress={progress} innerRef={logRef} />
        </main>

        <div className="flex flex-col overflow-hidden">
          <SessionsPane
            projectPath={project.path}
            refreshKey={sessionsListKey}
            onSessionChange={() => {
              setSessionsListKey((k) => k + 1);
              setChatReloadKey((k) => k + 1);
            }}
          />
          <ChatDock
            projectPath={project.path}
            reloadKey={chatReloadKey}
            onSessionCreated={() => setSessionsListKey((k) => k + 1)}
          />
        </div>
      </div>

      <footer className="border-t border-border bg-panel px-4 py-1 font-mono text-[10px] text-muted">
        aspect {String(project.config.aspect ?? "?")} · fps {String(project.config.fps ?? "?")} · voice {String(project.config.voice_id ?? "?")}
      </footer>
    </div>
  );
}
