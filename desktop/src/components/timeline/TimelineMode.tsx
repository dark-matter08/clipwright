// TimelineMode — the cyberpunk editor shell that renders as its own full
// 3-column layout inside the Workspace center pane. Structure mirrors the
// `05 · EDITOR` mockup:
//
//   ┌──────────┬───────────────────────────────────┬────────────┐
//   │  Assets  │  Transport ─ Preview ─ Timeline   │ Inspector  │
//   │  240px   │  (flex 1, stacks vertically)      │  300px     │
//   └──────────┴───────────────────────────────────┴────────────┘
//                        status bar (full width)
//
// Clip selection is lifted: the parent owns `selected`, so flipping between
// detail and timeline modes preserves the selected clip.
//
// Data it loads on its own (not in VideoState): out/camera.json keyframes and
// per-clip out/captions/<id>.json. Everything else (script, segments,
// hasFinal) arrives via the `video` prop.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip, Segment, VideoState } from "../../lib/types";
import { readTextFile, runClipwright, saveScriptClip } from "../../lib/ipc";
import { I, type LucideIcon } from "../../lib/icons";
import { cn } from "../../lib/cn";

// ---- Data shapes only this component cares about --------------------------

interface CameraKeyframe {
  t: number;
  zoom?: number;
  x?: number;
  y?: number;
}

interface CaptionChunk {
  start: number;
  end: number;
  text: string;
  highlight?: string;
}

type Tool = "select" | "cut" | "magnet";
type LibraryTab = "video" | "audio" | "text" | "fx";

// ---- Derived timeline model -----------------------------------------------

interface TimelineItem {
  clipId: string;
  chapter: string;
  start: number;
  end: number;
  text: string;
}

interface BuiltTimeline {
  items: TimelineItem[];
  totalDuration: number;
}

function buildTimeline(clips: Clip[], segments: Segment[]): BuiltTimeline {
  if (!Array.isArray(clips) || clips.length === 0) return { items: [], totalDuration: 0 };
  const safeSegs: Segment[] = Array.isArray(segments) ? segments : [];

  const byChapter = new Map<string, Segment>();
  for (const s of safeSegs) byChapter.set(s.chapter, s);

  let cursor = 0;
  const items: TimelineItem[] = clips.map((c) => {
    const seg = byChapter.get(c.chapter);
    if (seg) {
      const item = {
        clipId: c.id,
        chapter: c.chapter,
        start: seg.start,
        end: seg.end,
        text: c.text,
      };
      cursor = Math.max(cursor, seg.end);
      return item;
    }
    const start = cursor;
    cursor += c.target_seconds;
    return { clipId: c.id, chapter: c.chapter, start, end: cursor, text: c.text };
  });

  return { items, totalDuration: cursor };
}

// ---- Main component --------------------------------------------------------

export function TimelineMode({
  projectPath,
  videoSlug,
  video,
  aspect,
  selected,
  onSelect,
  activeRun,
  setActiveRun,
  onReloadVideo,
  voiceId,
  ttsProvider,
  fps,
}: {
  projectPath: string;
  videoSlug: string;
  video: VideoState;
  aspect: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  activeRun: number | null;
  setActiveRun: (id: number | null) => void;
  onReloadVideo: () => Promise<void>;
  voiceId?: string;
  ttsProvider?: string;
  fps?: number;
}) {
  const [cameraKFs, setCameraKFs] = useState<CameraKeyframe[]>([]);
  const [captions, setCaptions] = useState<Record<string, CaptionChunk[]>>({});
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("video");
  const [zoom, setZoom] = useState(1); // 0.25..4 timeline zoom
  const [activeLanes, setActiveLanes] = useState({
    v1: true,
    a1: true,
    a2: true,
    c1: true,
    fx: true,
    outro: true,
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);

  // Load camera.json when the active video changes.
  useEffect(() => {
    let alive = true;
    setCameraKFs([]);
    readTextFile(`${projectPath}/videos/${videoSlug}/out/camera.json`)
      .then((raw) => {
        if (!alive) return;
        const parsed = safeParse<{ keyframes?: CameraKeyframe[] } | CameraKeyframe[]>(raw);
        if (!parsed) return;
        const kfs = Array.isArray(parsed) ? parsed : parsed.keyframes;
        if (Array.isArray(kfs)) setCameraKFs(kfs);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectPath, videoSlug]);

  // Load per-clip captions whenever the clip list changes.
  useEffect(() => {
    const rawClips = video.script?.clips;
    const clips = Array.isArray(rawClips) ? rawClips : null;
    if (!clips) {
      setCaptions({});
      return;
    }
    let alive = true;
    (async () => {
      const entries: [string, CaptionChunk[]][] = [];
      for (const c of clips) {
        try {
          const raw = await readTextFile(
            `${projectPath}/videos/${videoSlug}/out/captions/${c.id}.json`,
          );
          const parsed = safeParse<{ chunks?: CaptionChunk[] } | CaptionChunk[]>(raw);
          const chunks = Array.isArray(parsed) ? parsed : parsed?.chunks;
          if (Array.isArray(chunks)) entries.push([c.id, chunks]);
        } catch {
          /* no captions yet for this clip */
        }
      }
      if (alive) setCaptions(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, videoSlug, video.script?.clips]);

  // --- Derived values -------------------------------------------------------

  const clips: Clip[] = Array.isArray(video.script?.clips) ? video.script!.clips : [];
  const segments: Segment[] = Array.isArray(video.segments) ? video.segments : [];

  const timeline = useMemo(() => buildTimeline(clips, segments), [clips, segments]);
  const effectiveDuration = duration > 0 ? duration : timeline.totalDuration;

  const selectedClip = selected ? clips.find((c) => c.id === selected) ?? null : null;
  const selectedTl = selected
    ? timeline.items.find((t) => t.clipId === selected) ?? null
    : null;

  const videoUrl = video.hasFinal
    ? convertFileSrc(`${projectPath}/videos/${videoSlug}/out/final.mp4`)
    : null;

  // --- Playback handlers ---------------------------------------------------

  function play() {
    videoRef.current?.play();
  }
  function pause() {
    videoRef.current?.pause();
  }
  function seekTo(t: number) {
    const clamped = Math.max(0, Math.min(effectiveDuration, t));
    setCurrentTime(clamped);
    if (videoRef.current && videoUrl) {
      videoRef.current.currentTime = clamped;
    }
  }
  function skip(delta: number) {
    seekTo(currentTime + delta);
  }
  function jumpToClip(id: string) {
    onSelect(id);
    const tl = timeline.items.find((t) => t.clipId === id);
    if (tl) seekTo(tl.start);
  }
  function onRulerClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!rulerRef.current || effectiveDuration <= 0) return;
    const rect = rulerRef.current.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seekTo(pct * effectiveDuration);
  }

  // --- IPC actions ---------------------------------------------------------

  async function regenForSelected(cmd: string) {
    if (!selectedClip || activeRun !== null) return;
    const id = await runClipwright(projectPath, cmd, videoSlug, selectedClip.id);
    setActiveRun(id);
  }
  async function renderAll() {
    if (activeRun !== null) return;
    const id = await runClipwright(projectPath, "render", videoSlug);
    setActiveRun(id);
  }
  async function updateClipText(next: string) {
    if (!selectedClip) return;
    await saveScriptClip(projectPath, videoSlug, selectedClip.id, next);
    await onReloadVideo();
  }

  const segmentCount = segments.length;
  const frameCount = Math.round(effectiveDuration * (fps ?? 30));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-bg text-fg">
      <div className="flex min-h-0 flex-1 min-w-0 overflow-hidden">
        <AssetSidebar
          tab={libraryTab}
          onTabChange={setLibraryTab}
          timelineItems={timeline.items}
          selectedClipId={selected}
          onSelectClip={jumpToClip}
          segmentCount={segmentCount}
          voiceId={voiceId}
          ttsProvider={ttsProvider}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <TransportBar
            playing={playing}
            currentTime={currentTime}
            duration={effectiveDuration}
            tool={tool}
            snap={snap}
            onPlay={play}
            onPause={pause}
            onSkip={skip}
            onToolChange={setTool}
            onSnapChange={setSnap}
            onRender={renderAll}
            rendering={activeRun !== null}
            hasFinal={video.hasFinal}
            hasPreview={!!videoUrl}
            videoTitle={video.title || video.slug}
            trackCount={visibleTrackCount(activeLanes)}
          />

          <PreviewPane
            videoUrl={videoUrl}
            videoRef={videoRef}
            aspect={aspect}
            fps={fps}
            currentTime={currentTime}
            duration={effectiveDuration}
            selectedChapter={selectedTl?.chapter ?? selectedClip?.chapter ?? null}
            selectedClipId={selectedClip?.id ?? null}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={setCurrentTime}
            onDurationChange={setDuration}
          />

          <Timeline
            timeline={timeline}
            duration={effectiveDuration}
            currentTime={currentTime}
            selectedClipId={selected}
            cameraKFs={cameraKFs}
            captions={captions}
            activeLanes={activeLanes}
            onToggleLane={(lane) =>
              setActiveLanes((l) => ({ ...l, [lane]: !l[lane] }))
            }
            onSelectClip={jumpToClip}
            onSeek={seekTo}
            rulerRef={rulerRef}
            onRulerClick={onRulerClick}
            zoom={zoom}
          />

          <TimelineFooter
            duration={effectiveDuration}
            fps={fps ?? 30}
            frameCount={frameCount}
            zoom={zoom}
            onZoom={setZoom}
            snap={snap}
          />
        </div>

        <Inspector
          clip={selectedClip}
          tlItem={selectedTl}
          captions={selectedClip ? captions[selectedClip.id] : undefined}
          cameraKFs={cameraKFs}
          voiceId={voiceId}
          aspect={aspect}
          fps={fps ?? 30}
          busy={activeRun !== null}
          onUpdateText={updateClipText}
          onRegenAudio={() => regenForSelected("tts")}
          onRegenCaption={() => regenForSelected("caption")}
          onRegenRender={() => regenForSelected("render")}
          onRenderAll={renderAll}
        />
      </div>

      <StatusBar
        activeRun={activeRun}
        rendering={activeRun !== null}
        hasFinal={video.hasFinal}
        fps={fps ?? 30}
      />
    </div>
  );
}

function visibleTrackCount(active: Record<string, boolean>): number {
  return Object.values(active).filter(Boolean).length;
}

// ============================================================================
// AssetSidebar — left 240px column
// ============================================================================

function AssetSidebar({
  tab,
  onTabChange,
  timelineItems,
  selectedClipId,
  onSelectClip,
  segmentCount,
  voiceId,
  ttsProvider,
}: {
  tab: LibraryTab;
  onTabChange: (t: LibraryTab) => void;
  timelineItems: TimelineItem[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  segmentCount: number;
  voiceId?: string;
  ttsProvider?: string;
}) {
  return (
    <aside className="flex w-[240px] shrink-0 flex-col overflow-hidden border-r border-border bg-bg-raised/50">
      <LibraryTabs tab={tab} onTabChange={onTabChange} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "video" && (
          <>
            <SegmentGrid
              items={timelineItems}
              selectedClipId={selectedClipId}
              onSelect={onSelectClip}
              segmentCount={segmentCount}
            />
            <SectionHeader label={`Audio`} />
            <div className="flex flex-col">
              <LibRow
                icon={I.Mic}
                accent="accent"
                title={`${selectedClipId ?? "clip"}.mp3`}
                sub={`${ttsProvider ?? "kokoro"} · ${voiceId ?? "af_bella"}`}
              />
              <LibRow
                icon={I.Music}
                accent="accent"
                title="synthwave-bed.ogg"
                sub="loop · -18 dB"
              />
              <LibRow
                icon={I.Waves}
                accent="accent"
                title="whoosh-01.wav"
                sub="0.42 s · sfx"
              />
            </div>
            <SectionHeader label="Effects" />
            <div className="flex flex-col">
              <LibRow
                icon={I.Focus}
                accent="accent"
                title="Ken Burns Zoom"
                sub="ease-in-out · 1.00 → 1.22"
              />
              <LibRow
                icon={I.Sparkles}
                accent="accent"
                title="Cyberpunk Outro"
                sub="1.4 s · glitch"
              />
            </div>
          </>
        )}
        {tab === "audio" && (
          <>
            <SectionHeader label="Voice" />
            <LibRow
              icon={I.Mic}
              accent="accent"
              title={`${voiceId ?? "af_bella"}`}
              sub={`${ttsProvider ?? "kokoro"} · local TTS`}
            />
            <SectionHeader label="Beds" />
            <LibRow
              icon={I.Music}
              accent="accent3"
              title="synthwave-bed.ogg"
              sub="loop · -18 dB"
            />
            <SectionHeader label="SFX" />
            <LibRow
              icon={I.Waves}
              accent="accent3"
              title="whoosh-01.wav"
              sub="0.42 s"
            />
          </>
        )}
        {tab === "text" && (
          <>
            <SectionHeader label={`Clips · ${timelineItems.length}`} />
            <div className="flex flex-col">
              {timelineItems.map((it) => (
                <button
                  key={it.clipId}
                  onClick={() => onSelectClip(it.clipId)}
                  className={cn(
                    "flex items-center gap-2 border-b border-border px-3 py-2 text-left transition-colors",
                    selectedClipId === it.clipId
                      ? "bg-accent/5 text-fg"
                      : "text-muted hover:bg-white/[.02] hover:text-fg",
                  )}
                >
                  <I.Captions size={13} className="text-accent2" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[10.5px] text-fg-dim">
                      {it.chapter || it.clipId}
                    </div>
                    <div className="truncate text-[9px] text-muted">
                      {(it.end - it.start).toFixed(2)}s · {it.clipId}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        {tab === "fx" && (
          <>
            <SectionHeader label="Camera" />
            <LibRow
              icon={I.Focus}
              accent="accent2"
              title="Ken Burns Zoom"
              sub="ease-in-out · 1.00 → 1.22"
            />
            <SectionHeader label="Outro" />
            <LibRow
              icon={I.Sparkles}
              accent="accent2"
              title="Cyberpunk Outro"
              sub="1.4 s · glitch"
            />
            <SectionHeader label="Transitions" />
            <LibRow icon={I.Split} accent="accent" title="Hard cut" sub="no transition" />
            <LibRow icon={I.Zap} accent="accent" title="Flash" sub="3 frame · teal glow" />
          </>
        )}
      </div>
    </aside>
  );
}

function LibraryTabs({
  tab,
  onTabChange,
}: {
  tab: LibraryTab;
  onTabChange: (t: LibraryTab) => void;
}) {
  const tabs: { key: LibraryTab; label: string; icon: LucideIcon }[] = [
    { key: "video", label: "Video", icon: I.Video },
    { key: "audio", label: "Audio", icon: I.Music2 },
    { key: "text", label: "Text", icon: I.Captions },
    { key: "fx", label: "FX", icon: I.Sparkles },
  ];
  return (
    <div className="flex shrink-0 border-b border-border">
      {tabs.map((t, i) => {
        const active = tab === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-2.5 text-[9px] uppercase tracking-[0.2em] transition-colors",
              i < tabs.length - 1 && "border-r border-border",
              active
                ? "bg-accent/5 text-accent"
                : "text-muted hover:text-fg-dim",
            )}
          >
            <Icon size={14} strokeWidth={1.5} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-3 pb-1.5 pt-3 text-[9px] uppercase tracking-[0.2em] text-muted-dim">
      {label}
    </div>
  );
}

function SegmentGrid({
  items,
  selectedClipId,
  onSelect,
  segmentCount,
}: {
  items: TimelineItem[];
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  segmentCount: number;
}) {
  if (items.length === 0) {
    return (
      <>
        <SectionHeader
          label={`Segments · ${segmentCount}`}
        />
        <div className="mx-3 mb-2 rounded border border-dashed border-border p-3 text-center text-[10px] text-muted">
          // no clips yet — run <span className="text-accent">SCRIPT INIT</span>
        </div>
      </>
    );
  }
  return (
    <>
      <SectionHeader label={`Segments · ${items.length}`} />
      <div className="grid grid-cols-2 gap-1.5 px-2.5 pb-2.5">
        {items.map((it, i) => (
          <SegmentThumb
            key={it.clipId}
            index={i}
            item={it}
            active={selectedClipId === it.clipId}
            onClick={() => onSelect(it.clipId)}
          />
        ))}
      </div>
    </>
  );
}

function SegmentThumb({
  index,
  item,
  active,
  onClick,
}: {
  index: number;
  item: TimelineItem;
  active: boolean;
  onClick: () => void;
}) {
  const gradients = [
    "from-[#14304f] to-[#0c1223]",
    "from-[#3a1a42] to-[#0c1223]",
    "from-[#1a3a42] to-[#0c1223]",
    "from-[#42291a] to-[#0c1223]",
    "from-[#1a2542] to-[#0c1223]",
    "from-[#2d1a42] to-[#0c1223]",
  ];
  const grad = gradients[index % gradients.length];
  const dur = (item.end - item.start).toFixed(1);
  const n = String(index + 1).padStart(2, "0");
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex aspect-[9/16] flex-col justify-end overflow-hidden rounded-md border bg-gradient-to-br p-1.5 text-left transition-all",
        grad,
        active
          ? "border-accent shadow-glow-teal"
          : "border-border hover:border-border-strong",
      )}
    >
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[.05] via-transparent to-black/40" />
      <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-[1px] text-[8.5px] font-medium text-white">
        {dur}s
      </span>
      <span className="relative z-10 truncate text-[9px] tracking-wide text-fg-dim">
        {n} · {item.chapter || item.clipId}
      </span>
    </button>
  );
}

function LibRow({
  icon: Icon,
  accent,
  title,
  sub,
}: {
  icon: LucideIcon;
  accent: "accent" | "accent2" | "accent3";
  title: string;
  sub: string;
}) {
  const accentCls =
    accent === "accent"
      ? "border-accent/40 bg-accent/[.04] text-accent"
      : accent === "accent2"
        ? "border-accent2/40 bg-accent2/[.04] text-accent2"
        : "border-accent3/40 bg-accent3/[.04] text-accent3";
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 transition-colors hover:bg-white/[.02]">
      <span
        className={cn(
          "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border",
          accentCls,
        )}
      >
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[10.5px] text-fg-dim">{title}</div>
        <div className="truncate text-[9px] text-muted">{sub}</div>
      </div>
    </div>
  );
}

// ============================================================================
// TransportBar — top of center column
// ============================================================================

function TransportBar({
  playing,
  currentTime,
  duration,
  tool,
  snap,
  onPlay,
  onPause,
  onSkip,
  onToolChange,
  onSnapChange,
  onRender,
  rendering,
  hasFinal,
  hasPreview,
  videoTitle,
  trackCount,
}: {
  playing: boolean;
  currentTime: number;
  duration: number;
  tool: Tool;
  snap: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSkip: (delta: number) => void;
  onToolChange: (t: Tool) => void;
  onSnapChange: (v: boolean) => void;
  onRender: () => void;
  rendering: boolean;
  hasFinal: boolean;
  hasPreview: boolean;
  videoTitle: string;
  trackCount: number;
}) {
  return (
    <div
      className="shrink-0 border-b border-border bg-gradient-to-b from-panel-2/60 to-panel/40 px-4 py-2.5"
      style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 20, alignItems: "center" }}
    >
      {/* Left: project chip + preview ready + autosync */}
      <div className="flex items-center gap-2">
        <Chip icon={I.Film}>
          <span className="normal-case text-fg-dim">{videoTitle}</span>
        </Chip>
        {hasPreview ? (
          <Chip tone="ok">
            <span className="mr-1 inline-block h-[7px] w-[7px] animate-soft-pulse rounded-full bg-ok shadow-[0_0_6px_rgba(74,222,128,.8)]" />
            preview ready
          </Chip>
        ) : (
          <Chip tone="muted">
            <span className="mr-1 inline-block h-[7px] w-[7px] rounded-full bg-muted" />
            render pending
          </Chip>
        )}
        <Chip tone="mag">
          <span className="mr-1 inline-block h-[7px] w-[7px] animate-soft-pulse rounded-full bg-accent2 shadow-[0_0_6px_rgba(232,121,249,.8)]" />
          autosync
        </Chip>
      </div>

      {/* Center: playback controls + timecode */}
      <div className="flex items-center gap-2">
        <IconBtn title="Skip back 5s" onClick={() => onSkip(-5)}>
          <I.SkipBack size={13} />
        </IconBtn>
        <IconBtn title="Step back 1 frame" onClick={() => onSkip(-1 / 30)}>
          <I.Rewind size={13} />
        </IconBtn>
        {playing ? (
          <IconBtn title="Pause" onClick={onPause} lg primary>
            <I.Pause size={16} />
          </IconBtn>
        ) : (
          <IconBtn title="Play" onClick={onPlay} lg primary>
            <I.Play size={16} />
          </IconBtn>
        )}
        <IconBtn title="Step forward 1 frame" onClick={() => onSkip(1 / 30)}>
          <I.FastForward size={13} />
        </IconBtn>
        <IconBtn title="Skip forward 5s" onClick={() => onSkip(5)}>
          <I.SkipForward size={13} />
        </IconBtn>

        <div
          className="ml-2 flex items-baseline gap-1 rounded-lg border border-accent/30 bg-gradient-to-b from-accent/[.08] to-accent/[.03] px-3.5 py-1 font-mono tabular-nums"
          style={{ textShadow: "0 0 18px rgba(0,245,229,.45)" }}
        >
          <span className="text-[17px] font-medium tracking-wider text-accent">
            {fmtTC(currentTime)}
          </span>
          <span className="text-[11px] text-muted">/</span>
          <span className="text-[11px] text-muted">{fmtTC(duration)}</span>
        </div>

        <IconBtn title="Back to start" onClick={() => onSkip(-999999)}>
          <I.RotateCcw size={13} />
        </IconBtn>
        <IconBtn title="Loop">
          <I.Repeat size={13} />
        </IconBtn>
        <IconBtn title="Volume">
          <I.Volume2 size={13} />
        </IconBtn>
      </div>

      {/* Right: tools + tracks + export */}
      <div className="flex items-center justify-end gap-2">
        <IconBtn
          title="Cut"
          active={tool === "cut"}
          onClick={() => onToolChange(tool === "cut" ? "select" : "cut")}
        >
          <I.Scissors size={13} />
        </IconBtn>
        <IconBtn title="Snap to playhead" active={snap} onClick={() => onSnapChange(!snap)}>
          <I.Magnet size={13} />
        </IconBtn>
        <IconBtn title="Split at playhead">
          <I.Split size={13} />
        </IconBtn>
        <Chip>
          <I.Layers size={11} className="text-accent" />
          <span>{trackCount} tracks</span>
        </Chip>
        <button
          onClick={onRender}
          disabled={rendering}
          className={cn(
            "flex items-center gap-1.5 rounded border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider transition-all",
            rendering
              ? "border-accent2/40 bg-accent2/10 text-accent2"
              : "border-accent2 bg-gradient-to-b from-accent2/20 to-accent2/10 text-accent2 shadow-glow-mag hover:from-accent2/30 hover:to-accent2/15",
          )}
        >
          {rendering ? (
            <I.Loader size={12} className="animate-spin" />
          ) : hasFinal ? (
            <I.FileDown size={12} />
          ) : (
            <I.Sparkles size={12} />
          )}
          {rendering ? "rendering…" : "export"}
        </button>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  active,
  primary,
  lg,
  disabled,
}: {
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  active?: boolean;
  primary?: boolean;
  lg?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center rounded border transition-all disabled:opacity-40",
        lg ? "h-8 w-8" : "h-7 w-7",
        primary
          ? "border-accent/70 bg-gradient-to-b from-accent/25 to-accent/10 text-accent shadow-glow-teal hover:from-accent/35 hover:to-accent/15"
          : active
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-border/80 bg-panel/40 text-muted hover:border-border-strong hover:text-fg-dim",
      )}
    >
      {children}
    </button>
  );
}

function Chip({
  children,
  icon: Icon,
  tone = "default",
}: {
  children: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "ok" | "mag" | "muted";
}) {
  const toneCls =
    tone === "ok"
      ? "border-ok/30 bg-ok/10 text-ok"
      : tone === "mag"
        ? "border-accent2/30 bg-accent2/10 text-accent2"
        : tone === "muted"
          ? "border-border bg-panel/40 text-muted"
          : "border-border bg-panel/40 text-fg-dim";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] uppercase tracking-wider",
        toneCls,
      )}
    >
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

// ============================================================================
// PreviewPane — center / middle of center column
// ============================================================================

function PreviewPane({
  videoUrl,
  videoRef,
  aspect,
  fps,
  currentTime,
  duration,
  selectedChapter,
  selectedClipId,
  onPlay,
  onPause,
  onTimeUpdate,
  onDurationChange,
}: {
  videoUrl: string | null;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  aspect: string;
  fps?: number;
  currentTime: number;
  duration: number;
  selectedChapter: string | null;
  selectedClipId: string | null;
  onPlay: () => void;
  onPause: () => void;
  onTimeUpdate: (t: number) => void;
  onDurationChange: (d: number) => void;
}) {
  const ratio =
    aspect === "16:9"
      ? "aspect-[16/9]"
      : aspect === "1:1"
        ? "aspect-square"
        : "aspect-[9/16]";
  const [w, h] = aspect === "16:9" ? ["1920", "1080"] : aspect === "1:1" ? ["1080", "1080"] : ["1080", "1920"];

  return (
    <div
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden border-b border-border p-4"
      style={{
        background: `
          radial-gradient(circle at 50% -10%, rgba(0,245,229,.07), transparent 50%),
          linear-gradient(180deg, #07091a, #050811)
        `,
      }}
    >
      {/* Scanline overlay */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(to bottom, rgba(255,255,255,.013) 0 1px, transparent 1px 3px)",
        }}
      />

      {/* Top-left aspect + FPS chips */}
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-raised/80 px-2 py-1 text-[9.5px] uppercase tracking-wider text-muted backdrop-blur">
          <I.Layers size={10} className="text-accent" />
          {aspect} · {w}×{h}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-raised/80 px-2 py-1 text-[9.5px] uppercase tracking-wider text-muted backdrop-blur">
          <I.Gauge size={10} className="text-accent" />
          {fps ?? 30} fps
        </span>
      </div>

      {/* The preview frame */}
      <div
        className={cn(
          "relative max-h-full overflow-hidden rounded-xl border border-accent/30 bg-black shadow-glow-teal",
          ratio,
          aspect === "9:16" ? "h-full" : "w-full",
        )}
        style={{
          boxShadow:
            "0 0 0 1px rgba(0,245,229,.25), 0 0 60px -10px rgba(232,121,249,.35), 0 0 80px -20px rgba(0,245,229,.4)",
        }}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            onPlay={onPlay}
            onPause={onPause}
            onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => onDurationChange(e.currentTarget.duration)}
            className="h-full w-full object-contain"
            playsInline
          />
        ) : (
          <div
            className="relative flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
            style={{
              background:
                "linear-gradient(180deg, rgba(20,30,60,.4), rgba(8,12,22,.8))",
            }}
          >
            <I.Film size={48} className="text-accent/30" strokeWidth={1.25} />
            <p className="text-xs text-muted-dim">
              // out/final.mp4 not rendered yet
            </p>
            <p className="text-[10px] uppercase tracking-wider text-accent/60">
              click <span className="text-accent2">export</span> to compose
            </p>
          </div>
        )}
      </div>

      {/* Bottom breadcrumbs */}
      <div className="absolute inset-x-3 bottom-3 z-10 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <I.Eye size={11} />
            preview
          </span>
          <span className="inline-flex items-center gap-1.5">
            <I.Zap size={11} className="text-accent" />
            remotion
          </span>
          {selectedChapter && (
            <span className="inline-flex items-center gap-1.5">
              <I.Layers size={11} className="text-accent2" />
              {selectedChapter}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span>
            playhead{" "}
            <b className="font-mono tabular-nums text-accent">{currentTime.toFixed(3)}s</b>
          </span>
          {selectedClipId && (
            <span>
              selected <b className="font-mono text-accent2">{selectedClipId}</b>
            </span>
          )}
          <span className="text-muted-dim">of {duration.toFixed(2)}s</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Timeline — 6 lanes
// ============================================================================

type LaneKey = "v1" | "a1" | "a2" | "c1" | "fx" | "outro";

interface LaneSpec {
  key: LaneKey;
  icon: LucideIcon;
  label: string;
  height: number;
  iconColor: "accent" | "accent2" | "accent3";
}

const LANES: LaneSpec[] = [
  { key: "v1", icon: I.Video, label: "V1", height: 52, iconColor: "accent" },
  { key: "a1", icon: I.Mic, label: "A1 Voice", height: 52, iconColor: "accent" },
  { key: "a2", icon: I.Music2, label: "A2 Music", height: 40, iconColor: "accent3" },
  { key: "c1", icon: I.Captions, label: "C1", height: 36, iconColor: "accent2" },
  { key: "fx", icon: I.Focus, label: "FX Zoom", height: 34, iconColor: "accent2" },
  { key: "outro", icon: I.Sparkles, label: "Outro", height: 36, iconColor: "accent2" },
];

function Timeline({
  timeline,
  duration,
  currentTime,
  selectedClipId,
  cameraKFs,
  captions,
  activeLanes,
  onToggleLane,
  onSelectClip,
  onSeek,
  rulerRef,
  onRulerClick,
  zoom,
}: {
  timeline: BuiltTimeline;
  duration: number;
  currentTime: number;
  selectedClipId: string | null;
  cameraKFs: CameraKeyframe[];
  captions: Record<string, CaptionChunk[]>;
  activeLanes: Record<LaneKey, boolean>;
  onToggleLane: (lane: LaneKey) => void;
  onSelectClip: (id: string) => void;
  onSeek: (t: number) => void;
  rulerRef: React.MutableRefObject<HTMLDivElement | null>;
  onRulerClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  zoom: number;
}) {
  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  const ticks = useMemo(() => {
    if (duration <= 0) return [] as { t: number; major: boolean }[];
    const step = duration > 60 ? 5 : duration > 20 ? 1 : 0.5;
    const out: { t: number; major: boolean }[] = [];
    for (let t = 0; t <= duration + 0.001; t += step) {
      out.push({ t, major: Math.abs((t % 5)) < 0.001 });
    }
    return out;
  }, [duration]);

  // Pre-compute outro block position (last 1.4s of the timeline if items exist)
  const outroBlock = useMemo(() => {
    if (timeline.items.length === 0 || duration <= 0) return null;
    const outroDur = Math.min(1.4, duration * 0.06);
    return { start: Math.max(0, duration - outroDur), end: duration };
  }, [timeline.items.length, duration]);

  // FX zoom curve path: use real cameraKFs if available, otherwise synthesize
  // one bump per clip so the timeline still shows the vibe.
  const fxPath = useMemo(() => {
    if (duration <= 0) return "";
    const w = 1000;
    const h = 40;
    if (cameraKFs.length >= 2) {
      const pts = cameraKFs.map((k) => {
        const x = (k.t / duration) * w;
        const zoomVal = k.zoom ?? 1;
        // clamp 1..1.3 to screen range with top = peak zoom
        const y = h - Math.min(1, Math.max(0, (zoomVal - 1) / 0.3)) * (h - 8) - 4;
        return { x, y };
      });
      return catmullRom(pts);
    }
    // Synthetic per-clip bumps
    if (timeline.items.length === 0) return "";
    const pts: { x: number; y: number }[] = [];
    timeline.items.forEach((it) => {
      const sx = (it.start / duration) * w;
      const mx = ((it.start + it.end) / 2 / duration) * w;
      const ex = (it.end / duration) * w;
      pts.push({ x: sx, y: h - 8 });
      pts.push({ x: mx, y: 6 });
      pts.push({ x: ex, y: h - 8 });
    });
    return catmullRom(pts);
  }, [cameraKFs, timeline.items, duration]);

  // FX keyframe dots: use real kfs if provided, else one per clip boundary +
  // peak. teal at boundaries, magenta at peak.
  const fxDots = useMemo(() => {
    if (duration <= 0) return [] as { t: number; tone: "teal" | "mag" }[];
    if (cameraKFs.length > 0) {
      return cameraKFs.map((kf, i) => ({
        t: kf.t,
        tone: (i === 0 || i === cameraKFs.length - 1 ? "teal" : "mag") as "teal" | "mag",
      }));
    }
    const dots: { t: number; tone: "teal" | "mag" }[] = [];
    timeline.items.forEach((it) => {
      dots.push({ t: it.start, tone: "teal" });
      dots.push({ t: (it.start + it.end) / 2, tone: "mag" });
    });
    if (timeline.items.length > 0) {
      dots.push({ t: timeline.items[timeline.items.length - 1].end, tone: "teal" });
    }
    return dots;
  }, [cameraKFs, timeline.items, duration]);

  return (
    <div
      className="relative grid min-h-0 shrink-0 overflow-hidden border-t border-border bg-[#060910]"
      style={{
        gridTemplateRows: "28px 1fr",
        height: 280 * Math.max(1, zoom * 0.5 + 0.5),
        maxHeight: 360,
      }}
    >
      {/* Header ruler */}
      <div
        className="grid border-b border-border"
        style={{
          gridTemplateColumns: "110px 1fr",
          background: "linear-gradient(180deg, rgba(14,21,38,.7), rgba(10,15,28,.7))",
        }}
      >
        <div className="flex items-center justify-between border-r border-border px-2.5 text-[9.5px] uppercase tracking-[0.18em]">
          <span className="inline-flex items-center gap-1.5 text-muted">
            <I.GalleryHorizontalEnd size={11} />
            timeline
          </span>
          <span className="font-mono tabular-nums text-accent">
            {duration.toFixed(1)}s
          </span>
        </div>
        <div
          ref={rulerRef}
          onClick={onRulerClick}
          className="relative cursor-pointer overflow-hidden"
        >
          {ticks.map((tk, i) => (
            <div
              key={i}
              className={cn(
                "absolute bottom-0 w-px",
                tk.major ? "h-3 bg-border-strong" : "h-1.5 bg-border-strong/50",
              )}
              style={{ left: `${pct(tk.t)}%` }}
            >
              {tk.major && (
                <span className="absolute -left-4 top-1 whitespace-nowrap font-mono text-[9px] text-muted-dim">
                  {fmtRuler(tk.t)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Body: 110px track heads + lanes */}
      <div className="grid min-h-0 overflow-hidden" style={{ gridTemplateColumns: "110px 1fr" }}>
        {/* Track heads */}
        <div className="flex flex-col overflow-hidden border-r border-border bg-bg-raised/60">
          {LANES.map((lane) => (
            <TrackHead
              key={lane.key}
              lane={lane}
              active={activeLanes[lane.key]}
              onToggle={() => onToggleLane(lane.key)}
            />
          ))}
        </div>
        {/* Lanes */}
        <div className="relative min-w-0 overflow-x-auto overflow-y-hidden">
          <div className="relative h-full" style={{ minWidth: `${100 * zoom}%` }}>
            {/* Playhead spanning all lanes */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20"
              style={{ left: `${pct(currentTime)}%` }}
            >
              <div
                className="h-full w-[2px]"
                style={{
                  background: "linear-gradient(180deg, #ffe8fb, rgb(232 121 249))",
                  boxShadow: "0 0 12px rgba(232,121,249,.8)",
                }}
              />
              <div
                className="absolute -left-[7px] -top-[6px] h-4 w-4"
                style={{
                  background: "rgb(232 121 249)",
                  clipPath: "polygon(50% 100%, 0 0, 100% 0)",
                  filter: "drop-shadow(0 0 6px rgba(232,121,249,.8))",
                }}
              />
            </div>

            {/* V1 video lane */}
            <Lane
              height={LANES[0].height}
              disabled={!activeLanes.v1}
              empty={timeline.items.length === 0}
              emptyText="// script.json has no clips"
            >
              {timeline.items.map((it, i) => (
                <VideoClipBlock
                  key={it.clipId}
                  index={i}
                  item={it}
                  selected={selectedClipId === it.clipId}
                  left={pct(it.start)}
                  width={pct(it.end - it.start)}
                  onClick={() => onSelectClip(it.clipId)}
                />
              ))}
            </Lane>

            {/* A1 voice lane */}
            <Lane
              height={LANES[1].height}
              disabled={!activeLanes.a1}
              empty={timeline.items.length === 0}
            >
              {timeline.items.map((it) => (
                <VoiceClipBlock
                  key={it.clipId}
                  clipId={it.clipId}
                  selected={selectedClipId === it.clipId}
                  left={pct(it.start)}
                  width={pct(it.end - it.start)}
                  onClick={() => onSelectClip(it.clipId)}
                />
              ))}
            </Lane>

            {/* A2 music lane (single block spanning whole timeline) */}
            <Lane height={LANES[2].height} disabled={!activeLanes.a2} empty={duration <= 0}>
              <MusicClipBlock left={0} width={100} />
            </Lane>

            {/* C1 caption lane */}
            <Lane
              height={LANES[3].height}
              disabled={!activeLanes.c1}
              empty={timeline.items.length === 0}
            >
              {timeline.items.map((it) => {
                const chunks = captions[it.clipId] ?? syntheticChunks(it);
                return chunks.map((ch, j) => {
                  const start = it.start + ch.start;
                  const end = it.start + ch.end;
                  return (
                    <CaptionChunkBlock
                      key={`${it.clipId}-${j}`}
                      text={ch.text}
                      left={pct(start)}
                      width={pct(end - start)}
                    />
                  );
                });
              })}
            </Lane>

            {/* FX ZOOM lane */}
            <Lane
              height={LANES[4].height}
              disabled={!activeLanes.fx}
              empty={duration <= 0}
              emptyText="// run KEYFRAMES to populate zoom curve"
            >
              {fxPath && (
                <svg
                  viewBox="0 0 1000 40"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  <path
                    d={fxPath}
                    fill="none"
                    stroke="rgb(232 121 249)"
                    strokeWidth="1.2"
                    strokeOpacity="0.75"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              )}
              {fxDots.map((d, i) => (
                <button
                  key={i}
                  onClick={() => onSeek(d.t)}
                  title={`t=${d.t.toFixed(2)}s`}
                  className={cn(
                    "kf-diamond absolute top-1/2 h-2.5 w-2.5 border",
                    d.tone === "teal"
                      ? "border-[#dffffc] bg-accent"
                      : "border-[#fff2fb] bg-accent2",
                  )}
                  style={{
                    left: `${pct(d.t)}%`,
                    boxShadow:
                      d.tone === "teal"
                        ? "0 0 8px rgb(0 245 229)"
                        : "0 0 8px rgb(232 121 249)",
                  }}
                />
              ))}
            </Lane>

            {/* Outro lane */}
            <Lane
              height={LANES[5].height}
              disabled={!activeLanes.outro}
              empty={outroBlock === null}
            >
              {outroBlock && (
                <OutroClipBlock
                  left={pct(outroBlock.start)}
                  width={pct(outroBlock.end - outroBlock.start)}
                />
              )}
            </Lane>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrackHead({
  lane,
  active,
  onToggle,
}: {
  lane: LaneSpec;
  active: boolean;
  onToggle: () => void;
}) {
  const Icon = lane.icon;
  const iconCls =
    lane.iconColor === "accent"
      ? "text-accent"
      : lane.iconColor === "accent2"
        ? "text-accent2"
        : "text-accent3";
  return (
    <div
      className="flex items-center justify-between border-b border-border px-2.5 text-[10px] uppercase tracking-[0.14em] text-fg-dim"
      style={{ height: lane.height }}
    >
      <span className="inline-flex items-center gap-1.5">
        <Icon size={13} className={iconCls} />
        {lane.label}
      </span>
      <span className="flex items-center gap-1">
        <button
          onClick={onToggle}
          title={active ? "Hide lane" : "Show lane"}
          className={cn(
            "flex h-4 w-4 items-center justify-center transition-colors",
            active ? "text-muted hover:text-fg" : "text-muted-dim hover:text-muted",
          )}
        >
          {active ? <I.Eye size={10} /> : <I.VolumeX size={10} />}
        </button>
        <button
          className="flex h-4 w-4 items-center justify-center text-muted hover:text-fg"
          title="Lock lane"
        >
          <I.Lock size={10} />
        </button>
      </span>
    </div>
  );
}

function Lane({
  height,
  disabled,
  empty,
  emptyText,
  children,
}: {
  height: number;
  disabled?: boolean;
  empty?: boolean;
  emptyText?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative border-b border-border",
        disabled && "pointer-events-none opacity-40",
      )}
      style={{ height }}
    >
      {empty && emptyText && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-dim">
          {emptyText}
        </span>
      )}
      {children}
    </div>
  );
}

function VideoClipBlock({
  index,
  item,
  selected,
  left,
  width,
  onClick,
}: {
  index: number;
  item: TimelineItem;
  selected: boolean;
  left: number;
  width: number;
  onClick: () => void;
}) {
  const n = String(index + 1).padStart(2, "0");
  const dur = (item.end - item.start).toFixed(1);
  return (
    <button
      onClick={onClick}
      className={cn(
        "absolute inset-y-[5px] overflow-hidden rounded-md border transition-shadow",
        selected
          ? "clip-selected border-accent"
          : "border-[#2a4e82] hover:shadow-[0_0_0_1px_rgba(255,255,255,.15)]",
      )}
      style={{
        left: `${left}%`,
        width: `${Math.max(0.5, width)}%`,
        background: "linear-gradient(180deg, #1d3a5e, #12233f)",
      }}
      title={`${item.chapter} · ${dur}s`}
    >
      {/* Title strip */}
      <div
        className="relative flex items-center justify-between gap-2 border-b border-white/10 px-2 py-[3px] text-[10px] font-medium tracking-wide text-white"
        style={{ background: "rgba(0,0,0,.35)" }}
      >
        <span className="truncate">
          <span className="text-accent/80">{n}</span>{" "}
          <span className="text-white">·</span>{" "}
          <span className="truncate">{item.chapter || item.clipId}</span>
        </span>
        <span className="shrink-0 text-[9px] text-white/50">· {dur}s</span>
      </div>
      {/* Body with cyberpunk overlay */}
      <div
        className="relative flex-1"
        style={{
          position: "absolute",
          top: 20,
          left: 0,
          right: 0,
          bottom: 0,
          background: `
            linear-gradient(135deg, rgba(0,245,229,.22) 0 30%, transparent 32% 68%, rgba(232,121,249,.2) 70% 100%),
            repeating-linear-gradient(90deg, rgba(255,255,255,.05) 0 1px, transparent 1px 8px)
          `,
        }}
      />
      {/* Edge handles */}
      {selected && (
        <>
          <span className="pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-md bg-accent shadow-[0_0_10px_rgba(0,245,229,.8)]" />
          <span className="pointer-events-none absolute inset-y-0 right-0 w-1 rounded-r-md bg-accent shadow-[0_0_10px_rgba(0,245,229,.8)]" />
        </>
      )}
    </button>
  );
}

function VoiceClipBlock({
  clipId,
  selected,
  left,
  width,
  onClick,
}: {
  clipId: string;
  selected: boolean;
  left: number;
  width: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "absolute inset-y-[5px] overflow-hidden rounded-md border transition-shadow",
        selected
          ? "clip-selected border-accent"
          : "border-accent/35 hover:shadow-[0_0_0_1px_rgba(0,245,229,.3)]",
      )}
      style={{
        left: `${left}%`,
        width: `${Math.max(0.5, width)}%`,
        background: "linear-gradient(180deg, #0d3332, #062523)",
      }}
      title={`${clipId}.mp3`}
    >
      <div
        className="flex items-center justify-between px-2 py-[3px] text-[9.5px] text-accent/90"
        style={{ background: "rgba(0,0,0,.35)" }}
      >
        <span className="inline-flex items-center gap-1">
          <I.Mic size={9} />
          <span className="truncate">{clipId}.mp3</span>
        </span>
      </div>
      <div className="absolute inset-x-1 bottom-1 top-[18px]">
        <Waveform tone="teal" seed={clipId} />
      </div>
    </button>
  );
}

function MusicClipBlock({ left, width }: { left: number; width: number }) {
  return (
    <div
      className="absolute inset-y-[5px] overflow-hidden rounded-md border"
      style={{
        left: `${left}%`,
        width: `${Math.max(0.5, width)}%`,
        background: "linear-gradient(180deg, #3a2d0a, #1f1705)",
        borderColor: "rgba(251,191,36,.3)",
      }}
      title="synthwave-bed.ogg · loop"
    >
      <div
        className="flex items-center justify-between px-2 py-[2px] text-[9px] text-accent3/90"
        style={{ background: "rgba(0,0,0,.35)" }}
      >
        <span className="inline-flex items-center gap-1">
          <I.Music2 size={9} />
          synthwave-bed.ogg · loop · -18 dB
        </span>
      </div>
      <div className="absolute inset-x-1 bottom-[2px] top-[16px]">
        <Waveform tone="amber" seed="music-bed" dense />
      </div>
    </div>
  );
}

function CaptionChunkBlock({
  text,
  left,
  width,
}: {
  text: string;
  left: number;
  width: number;
}) {
  return (
    <div
      className="absolute inset-y-[4px] flex items-center justify-center overflow-hidden rounded-md border px-1.5 py-[2px] text-center text-[10px] font-bold uppercase leading-tight tracking-wide text-white"
      style={{
        left: `${left}%`,
        width: `${Math.max(0.3, width)}%`,
        background: "linear-gradient(180deg, #3a1a42, #1d0d24)",
        borderColor: "rgba(232,121,249,.35)",
        textShadow: "0 0 8px rgba(232,121,249,.6)",
      }}
      title={text}
    >
      <span className="truncate">{text}</span>
    </div>
  );
}

function OutroClipBlock({ left, width }: { left: number; width: number }) {
  return (
    <div
      className="absolute inset-y-[5px] overflow-hidden rounded-md border"
      style={{
        left: `${left}%`,
        width: `${Math.max(0.5, width)}%`,
        background: "linear-gradient(135deg, #0d1c35, #1d0c32)",
        borderColor: "rgba(232,121,249,.4)",
      }}
    >
      <div
        className="flex items-center justify-between px-2 py-[3px] text-[9.5px] text-accent2/90"
        style={{ background: "rgba(0,0,0,.35)" }}
      >
        <span className="inline-flex items-center gap-1">
          <I.Sparkles size={9} />
          cyberpunk outro · 1.4s
        </span>
      </div>
      <div
        className="absolute inset-1 rounded-sm"
        style={{
          background: `
            radial-gradient(circle at 20% 30%, rgba(0,245,229,.5), transparent 60%),
            radial-gradient(circle at 80% 70%, rgba(232,121,249,.5), transparent 60%)
          `,
        }}
      />
    </div>
  );
}

function Waveform({
  tone,
  seed,
  dense,
}: {
  tone: "teal" | "amber";
  seed: string;
  dense?: boolean;
}) {
  // Deterministic pseudo-random from seed so each clip keeps the same shape
  // across re-renders instead of flickering.
  const bars = dense ? 160 : 90;
  const base =
    Array.from(seed).reduce((acc, c) => acc * 31 + c.charCodeAt(0), 7) >>> 0;
  return (
    <div className="flex h-full items-center gap-[1px]">
      {Array.from({ length: bars }).map((_, i) => {
        const n = (base + i * 2654435761) >>> 0;
        const nrm = ((n % 1000) / 1000) * 0.7 + 0.2;
        const sw = 0.6 + 0.4 * Math.abs(Math.sin(i * 0.34));
        const h = nrm * sw;
        const bg =
          tone === "teal"
            ? "linear-gradient(180deg, rgb(0 245 229), rgba(0,245,229,.2))"
            : "linear-gradient(180deg, rgb(251 191 36), rgba(251,191,36,.2))";
        return (
          <div
            key={i}
            className="flex-1 rounded-[1px]"
            style={{ height: `${h * 100}%`, background: bg }}
          />
        );
      })}
    </div>
  );
}

// ============================================================================
// Timeline footer
// ============================================================================

function TimelineFooter({
  duration,
  fps,
  frameCount,
  zoom,
  onZoom,
  snap,
}: {
  duration: number;
  fps: number;
  frameCount: number;
  zoom: number;
  onZoom: (z: number) => void;
  snap: boolean;
}) {
  return (
    <div className="flex h-[22px] shrink-0 items-center justify-between border-t border-border bg-bg-raised/70 px-3.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted">
      <div className="flex items-center gap-4">
        <span className="inline-flex items-center gap-1.5">
          <I.Magnet size={10} className={snap ? "text-accent" : "text-muted-dim"} />
          snap 1/4 frame
        </span>
        <span className="inline-flex items-center gap-1.5">
          <I.Ruler size={10} />
          {duration.toFixed(1)}s · {fps} fps · {frameCount} frames
        </span>
        <span className="inline-flex items-center gap-1.5">
          <I.Bookmark size={10} className="text-accent2" />
          {Math.max(0, Math.round(duration / 8))} markers
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span>zoom</span>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-[1px]">
          <button
            onClick={() => onZoom(Math.max(0.25, zoom - 0.25))}
            className="text-muted hover:text-accent"
          >
            <I.ZoomOut size={11} />
          </button>
          <span className="tabular-nums text-fg-dim">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => onZoom(Math.min(4, zoom + 0.25))}
            className="text-muted hover:text-accent"
          >
            <I.ZoomIn size={11} />
          </button>
        </div>
        <span className="text-muted-dim">|</span>
        <span>[A] scale · [S] split · [J/K/L] shuttle · [space] play</span>
      </div>
    </div>
  );
}

// ============================================================================
// Inspector — right 300px column
// ============================================================================

function Inspector({
  clip,
  tlItem,
  captions,
  cameraKFs,
  voiceId,
  aspect,
  fps,
  busy,
  onUpdateText,
  onRegenAudio,
  onRegenCaption,
  onRegenRender,
  onRenderAll,
}: {
  clip: Clip | null;
  tlItem: TimelineItem | null;
  captions?: CaptionChunk[];
  cameraKFs: CameraKeyframe[];
  voiceId?: string;
  aspect: string;
  fps: number;
  busy: boolean;
  onUpdateText: (s: string) => Promise<void>;
  onRegenAudio: () => Promise<void>;
  onRegenCaption: () => Promise<void>;
  onRegenRender: () => Promise<void>;
  onRenderAll: () => Promise<void>;
}) {
  const [text, setText] = useState(clip?.text ?? "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setText(clip?.text ?? "");
    setDirty(false);
  }, [clip?.id, clip?.text]);

  if (!clip) {
    return (
      <aside className="flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-border bg-bg-raised/50">
        <div className="border-b border-border px-4 py-3.5">
          <div className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.22em] text-muted">
            <I.Info size={11} /> nothing selected
          </div>
          <p className="mt-1 font-sans text-sm text-fg">No clip</p>
          <p className="mt-1 text-[10px] text-muted">
            click a segment on the timeline or in the library to inspect it
          </p>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-[11px] text-muted">
          <I.MousePointerClick size={28} strokeWidth={1.25} className="text-accent/40" />
          <span>// no selection</span>
        </div>
        <div className="border-t border-border px-4 py-3">
          <button
            onClick={onRenderAll}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-accent2/60 bg-accent2/5 px-3 py-2 text-[11px] uppercase tracking-wider text-accent2 hover:bg-accent2/10 disabled:opacity-40"
          >
            <I.Sparkles size={12} /> render full video
          </button>
        </div>
      </aside>
    );
  }

  const duration = tlItem ? tlItem.end - tlItem.start : clip.target_seconds;
  const inTC = tlItem ? fmtTC(tlItem.start) : "00:00.000";
  const outTC = tlItem ? fmtTC(tlItem.end) : fmtTC(clip.target_seconds);
  const kfPeak = cameraKFs.reduce<{ zoom: number; t: number }>(
    (acc, kf) => {
      const z = typeof kf.zoom === "number" ? kf.zoom : 1;
      return z > acc.zoom ? { zoom: z, t: kf.t } : acc;
    },
    { zoom: 1.22, t: 4.0 },
  );
  const captionCount = captions ? `${captions.length} chunks` : "synthetic";
  const frameCount = Math.round(duration * fps);

  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-border bg-bg-raised/50">
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.22em] text-muted">
          <I.Info size={11} /> selected
        </div>
        <p className="mt-1 font-sans text-[14px] font-medium text-fg">
          {clip.chapter || clip.id}
        </p>
        <div className="mt-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
          <span className="inline-flex items-center gap-1 text-accent">
            <I.Film size={11} /> {clip.id}
          </span>
          <span className="text-muted-dim">·</span>
          <span className="font-mono">
            V1 · {inTC} → {outTC}
          </span>
        </div>
      </div>

      <PropGroup icon={I.MoveHorizontal} label="Transform">
        <PropRow k="in" v={<span className="font-mono tabular-nums">{inTC}</span>} />
        <PropRow k="out" v={<span className="font-mono tabular-nums">{outTC}</span>} />
        <PropRow
          k="duration"
          v={<span className="font-mono tabular-nums">{duration.toFixed(3)}s</span>}
        />
        <PropRow
          k="frames"
          v={
            <span className="font-mono tabular-nums text-muted">
              {frameCount} @ {fps}fps
            </span>
          }
        />
        <PropRow
          k="aspect"
          v={<span className="font-mono uppercase tracking-wider">{aspect}</span>}
        />
        <PropRow k="speed" v={<span className="font-mono">1.00×</span>} />
        <Slider percent={0.6 * 100 / 4 * 1} />
        <div className="mt-1.5 flex justify-between font-mono text-[9px] text-muted">
          <span>0.25×</span>
          <span>1.00×</span>
          <span>4.00×</span>
        </div>
      </PropGroup>

      <PropGroup icon={I.Focus} label="Camera">
        <PropRow k="zoom in" v={<span className="font-mono">1.00</span>} />
        <PropRow
          k="zoom peak"
          v={
            <span className="font-mono text-accent2">
              {kfPeak.zoom.toFixed(2)} @ {kfPeak.t.toFixed(2)}s
            </span>
          }
        />
        <PropRow k="focus" v={<span className="font-mono">(0.63, 0.41)</span>} />
        <PropRow k="curve" v="ease-in-out" />
      </PropGroup>

      <PropGroup icon={I.Volume2} label="Audio">
        <PropRow k="voice" v={voiceId ?? "af_bella"} />
        <PropRow k="gain" v={<span className="font-mono">+0.0 dB</span>} />
        <PropRow k="stretch" v={<span className="font-mono">1.003×</span>} />
        <PropRow k="ducking (A2)" v={<span className="font-mono">-12 dB</span>} />
      </PropGroup>

      <PropGroup icon={I.Captions} label="Captions">
        <PropRow k="chunks" v={captionCount} />
        <PropRow k="font" v="DejaVu Sans · 800" />
        <PropRow k="glow" v="teal · 14px" />
        <PropRow k="position" v="bottom 44px" />
      </PropGroup>

      <PropGroup icon={I.Pencil} label="Narration" noDivider>
        {dirty && <div className="mb-1 text-[9px] uppercase text-accent2">· unsaved</div>}
        <textarea
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
          }}
          className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-fg focus:border-accent focus:outline-none"
        />
        <button
          onClick={async () => {
            await onUpdateText(text);
            setDirty(false);
          }}
          disabled={!dirty || busy}
          className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded border border-border bg-panel/40 px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted hover:border-accent hover:text-accent disabled:opacity-40"
        >
          <I.Save size={11} /> save narration
        </button>
      </PropGroup>

      <div className="mt-auto px-4 pb-4 pt-2">
        <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.22em] text-muted">
          <I.Sparkles size={11} /> actions
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <ActBtn label="Split" icon={I.Scissors} />
          <ActBtn label="Duplicate" icon={I.Copy} />
          <ActBtn
            label="Regen audio"
            icon={I.Mic}
            onClick={onRegenAudio}
            disabled={busy}
          />
          <ActBtn
            label="Regen caption"
            icon={I.Captions}
            onClick={onRegenCaption}
            disabled={busy}
          />
          <ActBtn
            className="col-span-2 border-accent bg-gradient-to-b from-accent/20 to-accent/5 text-accent shadow-glow-teal hover:from-accent/30"
            label="Re-render segment"
            icon={I.RefreshCw}
            onClick={onRegenRender}
            disabled={busy}
          />
          <ActBtn
            className="col-span-2 border-accent2/60 text-accent2 hover:bg-accent2/10"
            label="⌘K · ask claude"
            icon={I.Sparkles}
          />
        </div>
      </div>
    </aside>
  );
}

function PropGroup({
  icon: Icon,
  label,
  children,
  noDivider,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  noDivider?: boolean;
}) {
  return (
    <div className={cn("px-4 pb-3 pt-2.5", !noDivider && "border-b border-border")}>
      <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.22em] text-muted">
        <Icon size={11} />
        {label}
      </div>
      {children}
    </div>
  );
}

function PropRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between py-[5px] text-[11px]">
      <span className="text-muted">{k}</span>
      <span className="text-fg-dim">{v}</span>
    </div>
  );
}

function Slider({ percent }: { percent: number }) {
  return (
    <div className="relative mt-2 h-[6px] rounded border border-border bg-panel">
      <div
        className="absolute left-0 top-0 h-full rounded"
        style={{
          width: `${percent}%`,
          background: "linear-gradient(90deg, rgba(0,245,229,.3), rgb(0 245 229))",
        }}
      />
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
        style={{ left: `${percent}%`, boxShadow: "0 0 8px rgb(0 245 229)" }}
      />
    </div>
  );
}

function ActBtn({
  label,
  icon: Icon,
  onClick,
  disabled,
  className,
}: {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded border border-border bg-panel/30 px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-border-strong hover:text-fg-dim disabled:opacity-40",
        className,
      )}
    >
      <Icon size={11} />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ============================================================================
// StatusBar — bottom of TimelineMode (under the 3 columns)
// ============================================================================

function StatusBar({
  activeRun,
  rendering,
  hasFinal,
  fps,
}: {
  activeRun: number | null;
  rendering: boolean;
  hasFinal: boolean;
  fps: number;
}) {
  return (
    <div className="flex h-[24px] shrink-0 items-center justify-between border-t border-border bg-bg px-3.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted">
      <div className="flex items-center gap-4">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[7px] w-[7px] animate-soft-pulse rounded-full bg-accent shadow-[0_0_6px_rgba(0,245,229,.8)]" />
          connected
        </span>
        {rendering ? (
          <span className="inline-flex items-center gap-1.5 text-accent">
            <I.Loader size={11} className="animate-spin" />
            run <b>#{activeRun}</b> · rendering…
          </span>
        ) : hasFinal ? (
          <span className="inline-flex items-center gap-1.5">
            <I.Check size={10} className="text-accent/60" />
            final.mp4 ready
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <I.Check size={10} className="text-accent/60" />
            idle
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <I.HardDrive size={11} />
          <b className="text-fg-dim">482 GB</b> free
        </span>
        <span className="text-muted-dim">
          cpu 64 · mem 3.8/16 · gpu idle
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[7px] w-[7px] animate-soft-pulse rounded-full bg-accent2 shadow-[0_0_6px_rgba(232,121,249,.8)]" />
          claude live
        </span>
        <span>{fps} fps engine · remotion</span>
        <span className="text-muted-dim">
          ⌘o open · ⌘r rec · ⌘⏎ run · ⌘k claude
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// Utilities
// ============================================================================

function fmtTC(t: number): string {
  if (!Number.isFinite(t)) return "00:00.000";
  const mins = Math.floor(t / 60);
  const secs = t - mins * 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
}

function fmtRuler(t: number): string {
  const mins = Math.floor(t / 60);
  const secs = t - mins * 60;
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

function syntheticChunks(it: TimelineItem): CaptionChunk[] {
  const words = (it.text || "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const total = Math.max(0.5, it.end - it.start);
  const perChunk = 2;
  const n = Math.max(1, Math.ceil(words.length / perChunk));
  const dur = total / n;
  const out: CaptionChunk[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      start: i * dur,
      end: (i + 1) * dur,
      text: words
        .slice(i * perChunk, (i + 1) * perChunk)
        .join(" ")
        .toUpperCase(),
    });
  }
  return out;
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Catmull-Rom to cubic Bezier for a smooth through-points curve.
function catmullRom(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
