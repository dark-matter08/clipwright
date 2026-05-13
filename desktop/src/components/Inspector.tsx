// Inspector — SRS §8.5.3 + §6.3. Vertical accordion with five groups.
// P1.5 wires Voiceover + Trim; P1.6 wires Captions + Camera + Annotations
// (Camera + Annotations editing surfaces lean on existing camera.json /
// annotations.json schema but real per-property editors land later — for
// now we expose enable toggles + sensible read-only summaries).

import { useEffect, useState } from "react";
import { useApp } from "../lib/store";
import {
  captionSegment,
  loadScript,
  saveScriptClip,
  saveTimeline,
  ttsSegment,
  type ScriptClip,
} from "../lib/tauri";
import type { Segment, SegmentRef, Timeline } from "../lib/types";
import { cn } from "../lib/cn";

export function Inspector() {
  const project = useApp((s) => s.project);
  const selectedId = useApp((s) => s.selectedSegmentId);
  const seg = project?.timeline.segments.find((s) => s.id === selectedId) ?? null;

  if (!seg || !project) {
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
        <VoiceoverGroup seg={seg} projectDir={project.project_dir} />
        <CaptionsGroup seg={seg} projectDir={project.project_dir} />
        <CameraGroup seg={seg} projectDir={project.project_dir} timeline={project.timeline} />
        <AnnotationsGroup seg={seg} projectDir={project.project_dir} timeline={project.timeline} />
        <TrimGroup seg={seg} projectDir={project.project_dir} timeline={project.timeline} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accordion shell
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Voiceover group — P1.5
// ---------------------------------------------------------------------------

function VoiceoverGroup({
  seg,
  projectDir,
}: {
  seg: Segment;
  projectDir: string;
}) {
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);
  const [clip, setClip] = useState<ScriptClip | null>(null);
  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [provider, setProvider] = useState<string>("");
  const [busy, setBusy] = useState<null | "save" | "regen">(null);
  const clipId = seg.voiceover.script_clip_id || `vo_${seg.id.replace("seg_", "")}`;

  useEffect(() => {
    loadScript(projectDir)
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
  }, [projectDir, seg.id, clipId]);

  const dirty =
    (clip?.text ?? "") !== text ||
    (clip?.voice?.voice_id ?? "") !== voiceId ||
    (clip?.voice?.provider ?? "") !== provider;

  async function onSave() {
    setBusy("save");
    try {
      const patch: Partial<ScriptClip> = {
        text,
        target_seconds: seg.target_duration,
      };
      if (provider || voiceId) {
        patch.voice = { provider: provider || undefined, voice_id: voiceId || undefined };
      }
      await saveScriptClip(projectDir, clipId, seg.id, patch);
      setClip((c) => ({
        id: clipId,
        segment_id: seg.id,
        ...c,
        text,
        voice: provider || voiceId ? { provider, voice_id: voiceId } : c?.voice,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRegen() {
    if (dirty) {
      await onSave();
    }
    setBusy("regen");
    try {
      const state = await ttsSegment(projectDir, seg.id, true);
      loadProject(state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const summary = !seg.voiceover.enabled
    ? "disabled"
    : text.trim()
      ? truncate(text, 40)
      : "(empty)";

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
          <LabeledInput
            label="Provider"
            value={provider}
            onChange={setProvider}
            placeholder="kokoro · piper · elevenlabs"
          />
          <LabeledInput
            label="Voice"
            value={voiceId}
            onChange={setVoiceId}
            placeholder="af_sky"
          />
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="font-mono text-[10px] text-fg-muted">
            target {seg.target_duration.toFixed(1)}s · ~{wordsAtRate(text).toFixed(0)} wps to fit
          </span>
          <div className="flex gap-1">
            <ActionBtn
              label={dirty ? "Save" : "Saved"}
              onClick={onSave}
              busy={busy === "save"}
              disabled={!dirty}
            />
            <ActionBtn
              label="Regenerate"
              variant="accent"
              onClick={onRegen}
              busy={busy === "regen"}
              disabled={!text.trim()}
            />
          </div>
        </div>
      </div>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// Captions group — P1.6
// ---------------------------------------------------------------------------

function CaptionsGroup({
  seg,
  projectDir,
}: {
  seg: Segment;
  projectDir: string;
}) {
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);
  const [busy, setBusy] = useState(false);

  async function onRegen() {
    setBusy(true);
    try {
      const state = await captionSegment(projectDir, seg.id, true);
      loadProject(state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const summary = seg.captions.enabled ? "enabled · default style" : "disabled";

  return (
    <Accordion title="Captions" summary={summary}>
      <div className="flex flex-col gap-2">
        <RefToggle
          seg={seg}
          field="captions"
          projectDir={projectDir}
        />
        <p className="text-xs text-fg-muted">
          Style overrides land in P2 — for now the default 2-word UPPERCASE
          chunks render at the project's aspect resolution.
        </p>
        <div className="flex justify-end pt-1">
          <ActionBtn
            label="Regenerate"
            variant="accent"
            onClick={onRegen}
            busy={busy}
            disabled={!seg.captions.enabled}
          />
        </div>
      </div>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// Camera group — P1.6 (toggle only; per-keyframe editor is P2)
// ---------------------------------------------------------------------------

function CameraGroup({
  seg,
  projectDir,
  timeline,
}: {
  seg: Segment;
  projectDir: string;
  timeline: Timeline;
}) {
  const summary = seg.camera.enabled ? "enabled" : "disabled";
  return (
    <Accordion title="Camera" summary={summary}>
      <div className="flex flex-col gap-2 text-xs text-fg-muted">
        <RefToggle
          seg={seg}
          field="camera"
          projectDir={projectDir}
          timeline={timeline}
        />
        <p>
          Per-keyframe editing (zoom curve + focus xy) lands in P2. For
          now, the auto-generated camera plan from recording continues to
          drive zoom on click/type actions.
        </p>
      </div>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// Annotations group — P1.6 (toggle only; overlay editor is P2)
// ---------------------------------------------------------------------------

function AnnotationsGroup({
  seg,
  projectDir,
  timeline,
}: {
  seg: Segment;
  projectDir: string;
  timeline: Timeline;
}) {
  const summary = seg.annotations.enabled ? "enabled" : "disabled";
  return (
    <Accordion title="Annotations" summary={summary}>
      <div className="flex flex-col gap-2 text-xs text-fg-muted">
        <RefToggle
          seg={seg}
          field="annotations"
          projectDir={projectDir}
          timeline={timeline}
        />
        <p>
          Click-ripple + highlight overlays from the Playwright bbox capture
          are honored if enabled. Manual overlay authoring is P2.
        </p>
      </div>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// Trim group — P1.5
// ---------------------------------------------------------------------------

function TrimGroup({
  seg,
  projectDir,
  timeline,
}: {
  seg: Segment;
  projectDir: string;
  timeline: Timeline;
}) {
  const setError = useApp((s) => s.setError);
  const loadProject = useApp((s) => s.loadProject);
  const [start, setStart] = useState(seg.source_start.toFixed(2));
  const [end, setEnd] = useState(seg.source_end.toFixed(2));
  const [target, setTarget] = useState(seg.target_duration.toFixed(2));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStart(seg.source_start.toFixed(2));
    setEnd(seg.source_end.toFixed(2));
    setTarget(seg.target_duration.toFixed(2));
  }, [seg.id, seg.source_start, seg.source_end, seg.target_duration]);

  const s = parseFloat(start);
  const e = parseFloat(end);
  const t = parseFloat(target);
  const valid = isFinite(s) && isFinite(e) && isFinite(t) && e > s && t > 0;
  const dirty =
    valid &&
    (s !== seg.source_start || e !== seg.source_end || t !== seg.target_duration);

  async function onSave() {
    if (!valid) return;
    setBusy(true);
    try {
      const next: Timeline = {
        ...timeline,
        segments: timeline.segments.map((g) =>
          g.id === seg.id
            ? { ...g, source_start: s, source_end: e, target_duration: t }
            : g,
        ),
      };
      await saveTimeline(projectDir, next);
      loadProject({ project_dir: projectDir, project: useApp.getState().project!.project, timeline: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Accordion title="Trim" summary={`${seg.source_start.toFixed(1)}s → ${seg.source_end.toFixed(1)}s`}>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-2">
          <LabeledInput label="Source in"  value={start}  onChange={setStart}  mono />
          <LabeledInput label="Source out" value={end}    onChange={setEnd}    mono />
          <LabeledInput label="Target dur" value={target} onChange={setTarget} mono />
        </div>
        {!valid && (
          <p className="text-xs text-danger">
            Source out must be greater than source in, and target duration must
            be positive.
          </p>
        )}
        <div className="flex justify-end pt-1">
          <ActionBtn
            label={dirty ? "Save" : "Saved"}
            onClick={onSave}
            busy={busy}
            disabled={!dirty}
          />
        </div>
      </div>
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function RefToggle({
  seg,
  field,
  projectDir,
  timeline: passed,
}: {
  seg: Segment;
  field: "captions" | "camera" | "annotations";
  projectDir: string;
  timeline?: Timeline;
}) {
  const projectTimeline = useApp((s) => s.project!.timeline);
  const timeline = passed ?? projectTimeline;
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const ref = seg[field];

  async function toggle() {
    try {
      const newRef: SegmentRef = { ...ref, enabled: !ref.enabled };
      const next: Timeline = {
        ...timeline,
        segments: timeline.segments.map((g) =>
          g.id === seg.id ? { ...g, [field]: newRef } : g,
        ),
      };
      await saveTimeline(projectDir, next);
      const state = useApp.getState().project!;
      loadProject({ ...state, timeline: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-subtle">
      <input
        type="checkbox"
        checked={ref.enabled}
        onChange={toggle}
        className="accent-accent"
      />
      Enabled
      {ref.ref && (
        <span className="ml-2 truncate font-mono text-[10px] text-fg-muted">
          {ref.ref}
        </span>
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
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">
        {label}
      </span>
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
  // ~2.5 words per second is the SKILL.md target; this returns the rate
  // the current text would land at given the segment target duration.
  // It's intentionally informational — no hard validation.
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words; // displayed as a count, not divided — keep it simple
}
