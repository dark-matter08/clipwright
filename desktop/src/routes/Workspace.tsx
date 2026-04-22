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
import { FinalRenderPane } from "../components/FinalRenderPane";
import { TimelineMode } from "../components/timeline/TimelineMode";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { loadVideo, onLog, onRunDone, onProgress } from "../lib/ipc";
import { I } from "../lib/icons";

type Mode = "detail" | "timeline";

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
  const [mode, setMode] = useState<Mode>("detail");
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

  // Timeline mode requires segments — if they disappear (video switched to one
  // that hasn't been recorded yet) bounce back to detail mode so the user isn't
  // stuck staring at a blank editor.
  useEffect(() => {
    if (mode === "timeline" && activeVideo && !activeVideo.hasSegments) {
      setMode("detail");
    }
  }, [mode, activeVideo]);

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

  // ⌘E / Ctrl-E flips between detail and timeline. Escape from timeline bounces
  // back to detail — makes it feel like a peek-and-return sub-mode, not a route.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (!activeVideo?.hasSegments) return;
        setMode((m) => (m === "detail" ? "timeline" : "detail"));
      }
      if (e.key === "Escape" && mode === "timeline") {
        setMode("detail");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, activeVideo?.hasSegments]);

  function openEditor(slug: string) {
    setActiveSlug(slug);
    setOpenFile(null);
    setMode("timeline");
  }

  const clips: Clip[] = activeVideo?.script?.clips ?? [];
  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selected) ?? null,
    [clips, selected],
  );

  const projName = project.config.name ?? project.path.split("/").pop() ?? "project";
  const aspect = String(project.config.aspect ?? "9:16");

  // Center-column routing. Priority: file viewer > timeline mode > clip detail
  // > final render pane (if this video has a final.mp4) > empty coach state.
  const centerKind: "file" | "timeline" | "clip" | "final" | "empty" =
    openFile
      ? "file"
      : mode === "timeline" && activeVideo && activeVideo.hasSegments && activeSlug
        ? "timeline"
        : selectedClip && activeSlug
          ? "clip"
          : activeVideo?.hasFinal
            ? "final"
            : "empty";

  return (
    <div className="grid h-full grid-rows-[auto_auto_1fr_auto]">
      {/* Titlebar */}
      <header className="flex items-center justify-between border-b border-border bg-panel px-4 py-2 font-mono text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <I.Clapperboard size={14} className="shrink-0 text-accent" />
          <span className="text-fg">{projName}</span>
          <span className="text-muted/60">//</span>
          <span className="truncate text-muted">{project.path}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* DETAIL | TIMELINE segmented toggle. Timeline is gated on hasSegments. */}
          {activeVideo && (
            <div className="flex overflow-hidden rounded border border-border text-[10px] uppercase">
              <button
                onClick={() => setMode("detail")}
                className={`flex items-center gap-1 px-2 py-0.5 transition-colors ${
                  mode === "detail"
                    ? "bg-accent/10 text-accent"
                    : "text-muted hover:text-fg"
                }`}
                title="Detail view (⌘E to toggle)"
              >
                <I.Layers size={10} /> detail
              </button>
              <button
                onClick={() => setMode("timeline")}
                disabled={!activeVideo.hasSegments}
                className={`flex items-center gap-1 border-l border-border px-2 py-0.5 transition-colors disabled:opacity-40 ${
                  mode === "timeline"
                    ? "bg-accent2/10 text-accent2"
                    : "text-muted hover:text-fg"
                }`}
                title={
                  activeVideo.hasSegments
                    ? "Timeline editor (⌘E to toggle)"
                    : "Build segments first to enable the editor"
                }
              >
                <I.Video size={10} /> timeline
              </button>
            </div>
          )}
          <span className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] uppercase text-muted">
            <I.Tag size={10} /> {project.config.aspect ?? "?"}
          </span>
          <span className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] uppercase text-muted">
            <I.FastForward size={10} /> {project.config.fps ?? "?"} fps
          </span>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] uppercase text-muted hover:border-accent2 hover:text-accent2"
            title="Close project"
          >
            <I.X size={11} /> close
          </button>
        </div>
      </header>

      <VideoRail
        projectPath={project.path}
        videos={project.videos}
        activeSlug={activeSlug}
        onSelect={(slug) => {
          setActiveSlug(slug);
          // Bouncing to a different video while in timeline mode keeps the
          // editor open only if that video has segments. The effect above
          // also guards this but we preempt here to avoid a flash.
          setOpenFile(null);
        }}
        onEdit={openEditor}
        onReload={onReload}
      />

      {centerKind === "timeline" && activeVideo && activeSlug ? (
        // Timeline mode renders its OWN 3-column shell (assets | center | inspector)
        // per the mockup, so the workspace surrenders its chrome for full bleed.
        <div className="min-h-0 min-w-0 overflow-hidden bg-bg">
          <ErrorBoundary label="center pane · timeline">
            <TimelineMode
              projectPath={project.path}
              videoSlug={activeSlug}
              video={activeVideo}
              aspect={aspect}
              selected={selected}
              onSelect={setSelected}
              activeRun={activeRun}
              setActiveRun={setActiveRun}
              onReloadVideo={reloadActive}
              voiceId={project.config.voice_id ?? undefined}
              ttsProvider={project.config.tts_provider ?? undefined}
              fps={typeof project.config.fps === "number" ? project.config.fps : undefined}
            />
          </ErrorBoundary>
        </div>
      ) : (
        <div className="grid grid-cols-[300px_1fr_380px] overflow-hidden">
          <aside className="flex flex-col overflow-hidden border-r border-border">
            {activeVideo && (
              <PipelineBar
                projectPath={project.path}
                video={activeVideo}
                activeRun={activeRun}
                setActiveRun={setActiveRun}
                onReload={reloadActive}
                onOpenEditor={activeSlug ? () => openEditor(activeSlug) : undefined}
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

          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <ErrorBoundary label={`center pane · ${centerKind}`}>
                {centerKind === "file" && openFile ? (
                  <FileViewer
                    absPath={openFile.abs}
                    rel={openFile.rel}
                    onClose={() => setOpenFile(null)}
                  />
                ) : centerKind === "clip" && selectedClip && activeSlug ? (
                  <ClipDetail
                    projectPath={project.path}
                    videoSlug={activeSlug}
                    clip={selectedClip}
                    onReload={reloadActive}
                    activeRun={activeRun}
                    setActiveRun={setActiveRun}
                  />
                ) : centerKind === "final" && activeVideo ? (
                  <FinalRenderPane
                    projectPath={project.path}
                    video={activeVideo}
                    aspect={aspect}
                    activeRun={activeRun}
                    setActiveRun={setActiveRun}
                    onOpenInTimeline={() => activeSlug && openEditor(activeSlug)}
                  />
                ) : (
                  <EmptyCenter
                    hasVideos={project.videos.length > 0}
                    phase={activeVideo?.phase}
                  />
                )}
              </ErrorBoundary>
            </div>
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
      )}

      <footer className="flex items-center justify-between border-t border-border bg-panel px-4 py-1 font-mono text-[10px] text-muted">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <I.Mic size={10} /> {String(project.config.voice_id ?? "—")}
          </span>
          <span className="flex items-center gap-1">
            <I.Sparkles size={10} /> {String(project.config.tts_provider ?? "kokoro")}
          </span>
          <span className="flex items-center gap-1">
            <I.Captions size={10} /> {String(project.config.caption_preset ?? "default")}
          </span>
        </span>
        <span className="flex items-center gap-3">
          {activeRun !== null ? (
            <span className="flex items-center gap-1 text-accent">
              <I.Loader size={10} className="animate-spin" /> run #{activeRun}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <I.Check size={10} className="text-accent/60" /> idle
            </span>
          )}
          <span>{project.videos.length} videos</span>
        </span>
      </footer>
    </div>
  );
}

// Coach-the-user empty state. The message depends on the current video's phase
// — a RECORD-phase video should nudge toward the Record step, whereas a
// SCRIPT-phase video wants the user to pick a clip from the list.
function EmptyCenter({
  hasVideos,
  phase,
}: {
  hasVideos: boolean;
  phase?: string;
}) {
  if (!hasVideos) {
    return (
      <Empty icon={<I.Film size={32} strokeWidth={1.25} />} text="no videos yet — click + NEW VIDEO in the tab bar above" />
    );
  }
  const p = (phase ?? "").toLowerCase();
  if (p === "record" || p === "new" || p === "init") {
    return (
      <Empty
        icon={<I.MousePointerClick size={32} strokeWidth={1.25} />}
        text="run RECORD (Full Build ▸ Record) to capture browser footage — once a raw video lands, segments and keyframes unlock"
      />
    );
  }
  if (p === "segments" || p === "keyframes") {
    return (
      <Empty
        icon={<I.Split size={32} strokeWidth={1.25} />}
        text="run SEGMENTS then KEYFRAMES — after that the timeline editor and clip list light up"
      />
    );
  }
  if (p === "script") {
    return (
      <Empty
        icon={<I.FileText size={32} strokeWidth={1.25} />}
        text="pick a clip on the left, or run SCRIPT INIT to seed script.json"
      />
    );
  }
  return (
    <Empty
      icon={<I.Film size={32} strokeWidth={1.25} />}
      text="click a clip on the left — or a file tree entry to preview, or hit RUN ALL after segments exist"
    />
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-bg font-mono text-sm text-muted">
      <span className="text-accent/40">{icon}</span>
      <p className="max-w-md text-center">{text}</p>
    </div>
  );
}
