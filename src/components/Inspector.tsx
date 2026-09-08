// Inspector — SRS §8.5.3 + §6.3. Vertical accordion with five groups.
// Operates on the currently-loaded Video inside the open Project.

import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import {
  captionSegment,
  listSources,
  loadScript,
  saveScriptClip,
  saveVideo,
  ttsSegment,
  type ScriptClip,
  type SourceEntry,
} from "../lib/tauri";
import type { Segment, SegmentRef, Video } from "../lib/types";
import { cn } from "../lib/cn";
import {
  defaultVoiceFor,
  VOICE_PROVIDER_OPTIONS,
  VOICES_BY_PROVIDER,
  voiceInCatalog,
  type VoiceProvider,
} from "../lib/voiceCatalog";
import { getCredentialsStatus, type CredentialsStatus } from "../lib/tauri";
import { AlertTriangle } from "lucide-react";
import { Dropdown } from "./Dropdown";
import { VoicePreview } from "./VoicePreview";

export function Inspector() {
  const project = useApp((s) => s.project);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const video = project?.video ?? null;
  const seg = video?.segments.find((s) => s.id === selectedId) ?? null;

  if (!seg || !project || !video) {
    return (
      <div className="flex h-full w-full items-center justify-center px-6 py-4 text-sm text-fg-muted">
        Select a segment on the timeline to edit its properties.
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-3 px-4 py-3">
      <header className="flex items-baseline gap-2">
        <span className="font-mono text-sm text-fg">{seg.id}</span>
        <span className="text-fg-muted">·</span>
        <span className="text-sm text-fg">{seg.label || "(no label)"}</span>
        <span className="ml-auto font-mono text-xs text-fg-muted">
          {seg.target_duration.toFixed(1)}s
        </span>
      </header>
      <div className="flex flex-col gap-1.5 pb-3">
        <VoiceoverGroup seg={seg} projectDir={project.project_dir} videoId={video.video_id} />
        <CaptionsGroup seg={seg} projectDir={project.project_dir} videoId={video.video_id} />
        <CameraGroup seg={seg} projectDir={project.project_dir} videoId={video.video_id} video={video} />
        <AnnotationsGroup seg={seg} projectDir={project.project_dir} videoId={video.video_id} video={video} />
        <TrimGroup seg={seg} projectDir={project.project_dir} videoId={video.video_id} video={video} />
      </div>
    </div>
  );
}

interface AccordionProps {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Accordion({ title, summary, defaultOpen, children }: AccordionProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="rounded border border-border-subtle bg-bg-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-raised"
      >
        <span className="text-xs text-fg-muted">{open ? "▾" : "▸"}</span>
        <span className="text-sm font-medium text-fg">{title}</span>
        <span className="ml-auto truncate text-xs text-fg-muted">{summary}</span>
      </button>
      {open && (
        <div className="border-t border-border-subtle px-3 py-3">{children}</div>
      )}
    </div>
  );
}

interface GroupProps {
  seg: Segment;
  projectDir: string;
  videoId: string;
  video: Video;
}

function VoiceoverGroup({
  seg,
  projectDir,
  videoId,
}: {
  seg: Segment;
  projectDir: string;
  videoId: string;
}) {
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);
  const [clip, setClip] = useState<ScriptClip | null>(null);
  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [provider, setProvider] = useState<string>("");
  const [busy, setBusy] = useState<null | "save" | "regen">(null);
  // Refresh credentials status whenever the provider changes — that
  // way the "missing key" badge updates the moment the user picks
  // OpenAI / ElevenLabs even before they save and re-open the panel.
  const [credStatus, setCredStatus] = useState<CredentialsStatus | null>(null);
  useEffect(() => {
    getCredentialsStatus().then(setCredStatus).catch(() => setCredStatus(null));
  }, [provider]);
  const clipId = seg.voiceover.script_clip_id || `vo_${seg.id.replace("seg_", "")}`;

  useEffect(() => {
    loadScript(projectDir, videoId)
      .then((script) => {
        const found =
          script.clips.find((c) => c.id === clipId) ??
          script.clips.find((c) => c.segment_id === seg.id) ??
          null;
        setClip(found);
        setText(found?.text ?? "");
        setVoiceId(found?.voice?.voice_id ?? "");
        setProvider(found?.voice?.provider ?? "");
      })
      .catch(() => setClip(null));
  }, [projectDir, videoId, seg.id, clipId]);

  const dirty =
    (clip?.text ?? "") !== text ||
    (clip?.voice?.voice_id ?? "") !== voiceId ||
    (clip?.voice?.provider ?? "") !== provider;

  async function onSave() {
    setBusy("save");
    try {
      const patch: Partial<ScriptClip> = { text, target_seconds: seg.target_duration };
      if (provider || voiceId) {
        patch.voice = { provider: provider || undefined, voice_id: voiceId || undefined };
      }
      await saveScriptClip(projectDir, videoId, clipId, seg.id, patch);
      setClip((c) => ({
        id: clipId,
        segment_id: seg.id,
        ...c,
        text,
        voice: provider || voiceId ? { provider, voice_id: voiceId } : c?.voice,
      }));
      // If the segment's voiceover flag is still false but the user
      // just saved non-empty script text, flip the flag on the
      // segment manifest so the inspector summary stops reading
      // "disabled" for what is plainly an enabled voiceover. We
      // also patch the script_clip_id ref so the agent + renderer
      // can link the segment to its clip without guessing.
      const needsEnable =
        text.trim() &&
        (!seg.voiceover.enabled || seg.voiceover.script_clip_id !== clipId);
      if (needsEnable) {
        await persistSegmentVoiceoverEnabled(projectDir, videoId, seg.id, clipId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRegen() {
    if (dirty) await onSave();
    setBusy("regen");
    try {
      const state = await ttsSegment(projectDir, videoId, seg.id, true);
      loadProject(state);
      // A fresh per-segment audio mp3 doesn't appear in the assembled
      // final mp4 until the final is re-rendered. Mark stale so the
      // Preview's Final tab surfaces a banner pointing the user at
      // the TopBar Render — otherwise they'd hit "Regenerate", hear
      // the old audio in the Preview, and think nothing happened.
      useApp.getState().markFinalStale(videoId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // The accordion summary used to read "disabled" whenever
  // `seg.voiceover.enabled` was false — but that flag often lags the
  // user's intent (older manifests, agent-authored segments without
  // it). Treat a segment with non-empty script text as effectively
  // enabled for the UI; the next save flips the flag persistently.
  const hasScriptText = text.trim().length > 0;
  const summary = hasScriptText
    ? truncate(text, 40)
    : seg.voiceover.enabled
      ? "(empty)"
      : "disabled";

  return (
    <Accordion title="Voiceover" summary={summary} defaultOpen>
      <div className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder="What should this segment say? Short declarative fragments work best."
          className="w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
        />
        <div className="grid grid-cols-2 gap-2">
          <LabeledDropdown
            label="Provider"
            value={provider}
            // Wrap the change so swapping providers also resets the
            // voice to that provider's default — otherwise the user
            // would carry over an incompatible voice id (e.g.
            // `af_sky` from Kokoro into OpenAI which knows nothing
            // about it). Only override when the previous voice
            // isn't in the new provider's catalog.
            onChange={(next) => {
              setProvider(next);
              const p = next as VoiceProvider;
              if (
                VOICES_BY_PROVIDER[p] &&
                !voiceInCatalog(p, voiceId)
              ) {
                setVoiceId(defaultVoiceFor(p));
              }
            }}
            options={VOICE_PROVIDER_OPTIONS}
            placeholder="select provider"
          />
          <LabeledDropdown
            label="Voice"
            value={voiceId}
            onChange={setVoiceId}
            options={
              (provider as VoiceProvider) in VOICES_BY_PROVIDER
                ? VOICES_BY_PROVIDER[provider as VoiceProvider]
                : []
            }
            placeholder={
              provider ? "select voice" : "pick a provider first"
            }
            disabled={!provider}
          />
        </div>
        <div className="flex justify-end">
          <VoicePreview provider={provider} voice={voiceId} />
        </div>
        <ProviderKeyWarning provider={provider} status={credStatus} />
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="font-mono text-[10px] text-fg-muted">
            target {seg.target_duration.toFixed(1)}s · {wordsAtRate(text).toFixed(0)} words
          </span>
          <div className="flex gap-1">
            <ActionBtn label={dirty ? "Save" : "Saved"} onClick={onSave}
                       busy={busy === "save"} disabled={!dirty} />
            <ActionBtn label="Regenerate" variant="accent" onClick={onRegen}
                       busy={busy === "regen"} disabled={!text.trim()} />
          </div>
        </div>
      </div>
    </Accordion>
  );
}

/** Inline warning shown under the provider/voice picker when the
 *  selected provider needs an API key and one isn't set. Points the
 *  user at the Project Settings dialog's API Keys section.
 *  Hidden for local providers (Kokoro / Piper) which don't need keys. */
function ProviderKeyWarning({
  provider,
  status,
}: {
  provider: string;
  status: CredentialsStatus | null;
}) {
  if (!status) return null;
  if (provider === "openai" && !status.has_openai_key) {
    return <MissingKeyBanner label="OpenAI" />;
  }
  if (provider === "elevenlabs" && !status.has_elevenlabs_key) {
    return <MissingKeyBanner label="ElevenLabs" />;
  }
  return null;
}

function MissingKeyBanner({ label }: { label: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[11px] text-fg-subtle"
    >
      <AlertTriangle size={12} strokeWidth={2} className="mt-0.5 shrink-0 text-warn" />
      <span>
        {label} API key is not configured. Open{" "}
        <span className="text-fg">Settings → API keys</span> (gear icon in the top bar)
        to paste your key, or set the{" "}
        <span className="font-mono">
          {label === "OpenAI" ? "OPENAI_API_KEY" : "ELEVENLABS_API_KEY"}
        </span>{" "}
        env var. Regenerate will fail without it.
      </span>
    </div>
  );
}

function CaptionsGroup({
  seg,
  projectDir,
  videoId,
}: {
  seg: Segment;
  projectDir: string;
  videoId: string;
}) {
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);
  const [busy, setBusy] = useState(false);

  async function onRegen() {
    setBusy(true);
    try {
      const state = await captionSegment(projectDir, videoId, seg.id, true);
      loadProject(state);
      // Captions changed → final mp4 is stale until re-rendered. See
      // VoiceoverGroup.onRegen for the same pattern + rationale.
      useApp.getState().markFinalStale(videoId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Accordion title="Captions" summary={seg.captions.enabled ? "enabled" : "disabled"}>
      <div className="flex flex-col gap-2">
        <RefToggle seg={seg} field="captions" projectDir={projectDir} videoId={videoId} />
        <p className="text-xs text-fg-muted">
          Style overrides land in P2 — for now the default 2-word UPPERCASE chunks
          render at the project's aspect resolution.
        </p>
        <div className="flex justify-end pt-1">
          <ActionBtn label="Regenerate" variant="accent" onClick={onRegen}
                     busy={busy} disabled={!seg.captions.enabled} />
        </div>
      </div>
    </Accordion>
  );
}

function CameraGroup({ seg, projectDir, videoId, video }: GroupProps) {
  return (
    <Accordion title="Camera" summary={seg.camera.enabled ? "enabled" : "disabled"}>
      <div className="flex flex-col gap-2 text-xs text-fg-muted">
        <RefToggle seg={seg} field="camera" projectDir={projectDir}
                   videoId={videoId} video={video} />
        <p>Per-keyframe editing (zoom curve + focus xy) lands in P2.</p>
      </div>
    </Accordion>
  );
}

function AnnotationsGroup({ seg, projectDir, videoId, video }: GroupProps) {
  return (
    <Accordion title="Annotations" summary={seg.annotations.enabled ? "enabled" : "disabled"}>
      <div className="flex flex-col gap-2 text-xs text-fg-muted">
        <RefToggle seg={seg} field="annotations" projectDir={projectDir}
                   videoId={videoId} video={video} />
        <p>Click-ripple + highlight overlays are honored if enabled. Manual overlay authoring is P2.</p>
      </div>
    </Accordion>
  );
}

function TrimGroup({ seg, projectDir, videoId, video }: GroupProps) {
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);
  const [start, setStart] = useState(seg.source_start.toFixed(2));
  const [end, setEnd] = useState(seg.source_end.toFixed(2));
  const [target, setTarget] = useState(seg.target_duration.toFixed(2));
  const [source, setSource] = useState(seg.source);
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listSources(projectDir).then(setSources).catch(() => setSources([]));
  }, [projectDir, seg.id]);

  useEffect(() => {
    setStart(seg.source_start.toFixed(2));
    setEnd(seg.source_end.toFixed(2));
    setTarget(seg.target_duration.toFixed(2));
    setSource(seg.source);
  }, [seg.id, seg.source_start, seg.source_end, seg.target_duration, seg.source]);

  const s = parseFloat(start);
  const e = parseFloat(end);
  const t = parseFloat(target);
  const valid = isFinite(s) && isFinite(e) && isFinite(t) && e > s && t > 0;
  const dirty =
    valid &&
    (s !== seg.source_start ||
      e !== seg.source_end ||
      t !== seg.target_duration ||
      source !== seg.source);

  async function onSave() {
    if (!valid) return;
    setBusy(true);
    try {
      const next: Video = {
        ...video,
        segments: video.segments.map((g) =>
          g.id === seg.id
            ? { ...g, source, source_start: s, source_end: e, target_duration: t }
            : g,
        ),
      };
      await saveVideo(projectDir, videoId, next);
      const state = useApp.getState().project!;
      loadProject({ ...state, video: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const summary =
    sources.length > 1
      ? `${source.replace(/^sources\//, "")} · ${seg.source_start.toFixed(1)}s → ${seg.source_end.toFixed(1)}s`
      : `${seg.source_start.toFixed(1)}s → ${seg.source_end.toFixed(1)}s`;

  return (
    <Accordion title="Trim" summary={summary}>
      <div className="flex flex-col gap-2">
        {sources.length > 1 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-fg-muted">Source</span>
            <Dropdown<string>
              value={source}
              onChange={setSource}
              wrapperClassName="block w-full"
              options={[
                ...sources.map((entry) => ({
                  value: entry.path,
                  label: entry.path.replace(/^sources\//, ""),
                })),
                // If the segment references a source no longer on disk,
                // keep it as an option so the picker reflects reality —
                // flagged with "(missing on disk)" so the user knows
                // it'll break a re-render.
                ...(!sources.some((s2) => s2.path === source)
                  ? [
                      {
                        value: source,
                        label: `${source.replace(/^sources\//, "")} (missing on disk)`,
                      },
                    ]
                  : []),
              ]}
              triggerClassName="w-full px-2 py-1 font-mono text-xs text-fg justify-between bg-bg-inset"
            />
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <LabeledInput label="Source in" value={start} onChange={setStart} mono />
          <LabeledInput label="Source out" value={end} onChange={setEnd} mono />
          <LabeledInput label="Target dur" value={target} onChange={setTarget} mono />
        </div>
        {!valid && (
          <p className="text-xs text-danger">
            Source out must be greater than source in, and target duration must be positive.
          </p>
        )}
        <div className="flex justify-end pt-1">
          <ActionBtn label={dirty ? "Save" : "Saved"} onClick={onSave}
                     busy={busy} disabled={!dirty} />
        </div>
      </div>
    </Accordion>
  );
}

function RefToggle({
  seg,
  field,
  projectDir,
  videoId,
  video: passedVideo,
}: {
  seg: Segment;
  field: "captions" | "camera" | "annotations";
  projectDir: string;
  videoId: string;
  video?: Video;
}) {
  const storeVideo = useApp((s) => s.project!.video!);
  const video = passedVideo ?? storeVideo;
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const ref = seg[field];

  async function toggle() {
    try {
      const newRef: SegmentRef = { ...ref, enabled: !ref.enabled };
      const next: Video = {
        ...video,
        segments: video.segments.map((g) =>
          g.id === seg.id ? { ...g, [field]: newRef } : g,
        ),
      };
      await saveVideo(projectDir, videoId, next);
      const state = useApp.getState().project!;
      loadProject({ ...state, video: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-subtle">
      <input type="checkbox" checked={ref.enabled} onChange={toggle} className="accent-accent" />
      Enabled
      {ref.ref && (
        <span className="ml-2 truncate font-mono text-[10px] text-fg-muted">{ref.ref}</span>
      )}
    </label>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "rounded border border-border-subtle bg-bg-inset px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus:focus-ring",
          mono && "font-mono",
        )}
      />
    </label>
  );
}

/** Flip `seg.voiceover.enabled = true` (and wire its `script_clip_id`)
 *  on the active video and persist via `saveVideo`. Used by the
 *  Voiceover panel's save flow so the segment manifest stays
 *  consistent with what the user typed into the script — no more
 *  "disabled" summary on a segment that plainly has narration.
 *
 *  We reach into the Zustand store directly here instead of
 *  threading the full Video through as a prop because the Voiceover
 *  panel is several levels deep and the alternative would be ugly
 *  prop drilling. The store's `loadProject` keeps the in-memory
 *  state in sync with what we wrote to disk. */
async function persistSegmentVoiceoverEnabled(
  projectDir: string,
  videoId: string,
  segId: string,
  clipId: string,
): Promise<void> {
  // Local import to avoid a circular dep with the store.
  const { useApp } = await import("../lib/store");
  const state = useApp.getState();
  const project = state.project;
  if (!project?.video || project.video.video_id !== videoId) return;
  const segments = project.video.segments.map((s) =>
    s.id === segId
      ? {
          ...s,
          voiceover: {
            ...s.voiceover,
            enabled: true,
            script_clip_id: clipId,
          },
        }
      : s,
  );
  const nextVideo = { ...project.video, segments };
  await saveVideo(projectDir, videoId, nextVideo);
  state.loadProject({ ...project, video: nextVideo });
}

function LabeledDropdown<T extends string>({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</span>
      <Dropdown<T>
        value={value}
        onChange={onChange}
        options={options}
        wrapperClassName="block w-full"
        triggerClassName="w-full justify-between bg-bg-inset px-2 py-1 text-sm text-fg"
        placeholder={placeholder}
        disabled={disabled}
        menuMinWidth={220}
      />
    </label>
  );
}

function ActionBtn(props: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "default" | "accent";
}) {
  const isAccent = props.variant === "accent";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      className={cn(
        "min-w-[80px] rounded px-3 py-1 text-xs font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:bg-bg-raised disabled:text-fg-muted",
        !props.disabled && !props.busy && !isAccent &&
          "border border-border-subtle bg-bg-raised text-fg-subtle hover:bg-bg-inset hover:text-fg",
        !props.disabled && !props.busy && isAccent &&
          "bg-accent text-bg hover:bg-accent-hover",
      )}
    >
      {props.busy ? "…" : props.label}
    </button>
  );
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function wordsAtRate(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
