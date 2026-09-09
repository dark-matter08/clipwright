// Project Settings dialog — per-project recap preferences.
//
// Two panels in one modal:
//   1. Script — target duration + narration style + additional notes
//      that flow into Claude's system prompt and OVERRIDE the template's
//      defaults. Solves "the LLM compressed my script into 60s when I
//      wanted 3 minutes" — the user just sets target_duration_seconds
//      and the next turn obeys.
//   2. Outro — reusable spec ("describe how every video in this
//      project should end"). The agent reads this once per video and
//      appends a matching final segment. So the user describes their
//      outro once and every chapter video closes the same way.
//
// Backed by `.clipwright/recap-config.json` (see recap_config.rs +
// recap_config.py). Changes take effect on the next Claude turn — no
// restart needed because the agent prompt is rebuilt per turn.

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  DEFAULT_RECAP_CONFIG,
  getRecapConfig,
  saveVideo,
  setRecapConfig,
  type RecapConfig,
} from "../lib/tauri";
import {
  defaultVoiceFor,
  VOICE_PROVIDER_OPTIONS,
  VOICES_BY_PROVIDER,
  voiceInCatalog,
  type VoiceProvider,
} from "../lib/voiceCatalog";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import { ApiKeysSection } from "./ApiKeysSection";
import { Dropdown } from "./Dropdown";
import { VoicePreview } from "./VoicePreview";

interface Props {
  onClose: () => void;
}

type SettingsScope = "project" | "video";

/** `videos/<id>.json#recap_overrides`. Values are heterogeneous by
 *  design — strings (persona, narration), numbers (durations),
 *  booleans (persona_enabled), and a string[] (default_skills). */
type OverrideMap = Record<string, string | number | boolean | string[]>;

export function ProjectSettingsDialog({ onClose }: Props) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const [config, setConfig] = useState<RecapConfig>(DEFAULT_RECAP_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Track the loaded baseline so we can flag dirty state and disable
  // Save when nothing's changed.
  const [pristine, setPristine] = useState<RecapConfig>(DEFAULT_RECAP_CONFIG);

  // ── Scope toggle: project-level vs. per-video overrides ───────────
  const [scope, setScope] = useState<SettingsScope>("project");
  // Per-video override state. We mirror the existing project config
  // shape but treat empty values as "fall back to project default" —
  // the agent prompt does the same resolution. Initialized from the
  // currently-loaded video's `recap_overrides` map.
  const initialOverrides = (project?.video?.recap_overrides ?? {}) as OverrideMap;
  const [overrides, setOverrides] = useState<OverrideMap>(initialOverrides);
  const [overridesPristine, setOverridesPristine] =
    useState<OverrideMap>(initialOverrides);

  useEffect(() => {
    if (!project?.project_dir) return;
    setLoading(true);
    getRecapConfig(project.project_dir)
      .then((loaded) => {
        setConfig(loaded);
        setPristine(loaded);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [project?.project_dir, setError]);

  const projectDirty = JSON.stringify(config) !== JSON.stringify(pristine);
  const videoDirty =
    JSON.stringify(overrides) !== JSON.stringify(overridesPristine);
  const dirty = scope === "project" ? projectDirty : videoDirty;

  async function onSave() {
    if (!project?.project_dir || saving || !dirty) return;
    setSaving(true);
    try {
      if (scope === "project") {
        await setRecapConfig(project.project_dir, config);
        setPristine(config);
      } else if (project.video) {
        // Per-video save: strip empty values so the manifest stays
        // clean and the agent prompt's "use project default" fallback
        // kicks in for unset fields.
        const cleaned: OverrideMap = {};
        for (const [k, v] of Object.entries(overrides)) {
          if (typeof v === "string" && v.trim() === "") continue;
          if (typeof v === "number" && v === 0) continue;
          // `persona_enabled: true` is the default — persisting it
          // would bake today's default into the manifest, so only the
          // explicit opt-out is written.
          if (k === "persona_enabled" && v === true) continue;
          cleaned[k] = v;
        }
        const nextVideo = { ...project.video, recap_overrides: cleaned };
        await saveVideo(project.project_dir, project.video.video_id, nextVideo);
        loadProject({ ...project, video: nextVideo });
        setOverridesPristine(cleaned);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!project) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-settings-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-bg shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <div className="flex flex-col">
            <h2 id="project-settings-title" className="text-base font-medium">
              Project settings
            </h2>
            <span className="text-[11px] text-fg-muted">
              {project.project.title || project.project_dir}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg disabled:opacity-50"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        <div className="flex items-center gap-1 border-b border-border-subtle bg-bg-subtle px-5 py-2">
          {/* Scope toggle — project-level vs. just-this-video. The
           *  per-video tab is hidden when no video is loaded (e.g.
           *  the user opened settings before selecting one). */}
          <TabButton
            active={scope === "project"}
            onClick={() => setScope("project")}
            label="Project default"
            hint="Applies to every video in this project."
          />
          {project.video && (
            <TabButton
              active={scope === "video"}
              onClick={() => setScope("video")}
              label={`This video · ${project.video.video_id}`}
              hint="Overrides the project default for just this video."
            />
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-fg-muted">
              <Loader2 size={16} strokeWidth={2} className="mr-2 animate-spin" />
              Loading…
            </div>
          ) : scope === "project" ? (
            <div className="flex flex-col gap-6">
              <ScriptPanel config={config} onChange={setConfig} />
              <OutroPanel
                config={config}
                onChange={setConfig}
                projectTitle={project.project.title}
              />
              <PreviewBanner config={config} projectTitle={project.project.title} />
              {/* API keys sit at the bottom of the project tab —
               *  app-wide config, but discoverable here so users find
               *  it when wiring up an OpenAI/ElevenLabs voice. The
               *  section explicitly labels itself "app-wide" so the
               *  user knows it persists across projects. */}
              <ApiKeysSection />
            </div>
          ) : (
            <VideoOverridesPanel
              overrides={overrides}
              onChange={setOverrides}
              projectConfig={config}
              projectVoice={{
                provider: project.project.tts_provider,
                voice_id: project.project.voice_id,
              }}
              videoId={project.video?.video_id ?? ""}
            />
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border-subtle px-5 py-3">
          <span className="text-[11px] text-fg-muted">
            {dirty ? "Unsaved changes" : "Saved · applies to the next Claude turn"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded px-3 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-bg-raised hover:text-fg focus:focus-ring disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving}
              className={cn(
                "flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg transition-colors hover:bg-accent-hover focus:focus-ring",
                (!dirty || saving) && "cursor-not-allowed opacity-50",
              )}
            >
              {saving && <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />}
              Save settings
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Script panel — target duration + narration + free-form notes
// ---------------------------------------------------------------------------

function ScriptPanel({
  config,
  onChange,
}: {
  config: RecapConfig;
  onChange: (next: RecapConfig) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col">
        <h3 className="text-sm font-medium text-fg">Script</h3>
        <span className="text-[11px] text-fg-muted">
          Controls what Claude is told about pacing + tone. Overrides the
          template's defaults.
        </span>
      </header>
      <Field
        label="Target duration"
        hint="Total video length you want, in seconds. 0 = let the template pick (manhwa-recap defaults to 60–90s). Set 180 for a 3-min recap."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={1800}
            value={config.target_duration_seconds || ""}
            placeholder="0"
            onChange={(e) =>
              onChange({
                ...config,
                target_duration_seconds: parseInt(e.target.value || "0", 10) || 0,
              })
            }
            className="w-32 rounded border border-border-subtle bg-bg-inset px-2 py-1 font-mono text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
          />
          <span className="text-xs text-fg-muted">seconds</span>
          {config.target_duration_seconds > 0 && (
            <span className="ml-auto font-mono text-[11px] text-fg-muted">
              ≈ {formatDuration(config.target_duration_seconds)}
            </span>
          )}
        </div>
      </Field>
      <Field
        label="Narration style"
        hint="How the finished line is spoken — one-line description of the voiceover voice + tone. e.g. 'deep male narrator, conversational, slight rasp'. For who's doing the writing, use the Persona panel in the top bar."
      >
        <input
          type="text"
          value={config.narration_style}
          placeholder="deep male narrator, conversational"
          onChange={(e) => onChange({ ...config, narration_style: e.target.value })}
          className="w-full rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
        />
      </Field>
      <Field
        label="Additional notes"
        hint="Free-form notes Claude should remember about this project. Tone, audience, recurring characters, no-go topics."
      >
        <textarea
          value={config.additional_notes}
          onChange={(e) => onChange({ ...config, additional_notes: e.target.value })}
          rows={4}
          placeholder="e.g. Audience is shounen fans. Always keep the protagonist's full name. Avoid spoilers past the chapter being recapped."
          className="w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
        />
      </Field>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Outro panel — reusable spec applied to every video in the project
// ---------------------------------------------------------------------------

function OutroPanel({
  config,
  onChange,
  projectTitle,
}: {
  config: RecapConfig;
  onChange: (next: RecapConfig) => void;
  projectTitle: string;
}) {
  // Mirror the Python `effective_outro_description()` so the user can
  // see exactly what Claude will be told when they leave the box
  // empty. Cyberpunk + project title is the house default.
  const fallbackDescription =
    `Cyberpunk-themed outro card. Project title "${projectTitle || "Clipwright"}" appears ` +
    "center-screen in a neon-accented sans-serif over a deep blue/violet " +
    "background with subtle scanline/glitch. Voiceover (short, 1 line): " +
    "tease the next chapter and prompt a follow.";
  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col">
        <h3 className="text-sm font-medium text-fg">Outro</h3>
        <span className="text-[11px] text-fg-muted">
          Describe how every video in this project should close. Claude
          appends a matching final segment to each render — write it once
          here, never again per-video. Leave blank to use the cyberpunk-
          title default shown below.
        </span>
      </header>
      <Field
        label="Outro description"
        hint='Leave empty to use the cyberpunk-title default. Or write your own e.g. "Black background, voiceover: like for more, read next chapter in bio."'
      >
        <textarea
          value={config.outro.description}
          onChange={(e) =>
            onChange({
              ...config,
              outro: { ...config.outro, description: e.target.value },
            })
          }
          rows={4}
          placeholder={fallbackDescription}
          className="w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
        />
      </Field>
      <Field
        label="Outro duration"
        hint="Seconds. Most outros are 3–6s — long enough to read the CTA, short enough not to lose the viewer."
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={20}
            step={0.5}
            value={config.outro.duration_seconds}
            onChange={(e) =>
              onChange({
                ...config,
                outro: {
                  ...config.outro,
                  duration_seconds:
                    parseFloat(e.target.value || "5") || 5,
                },
              })
            }
            className="w-32 rounded border border-border-subtle bg-bg-inset px-2 py-1 font-mono text-sm text-fg focus:focus-ring"
          />
          <span className="text-xs text-fg-muted">seconds</span>
        </div>
      </Field>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live preview — show what gets injected into Claude's prompt
// ---------------------------------------------------------------------------

function PreviewBanner({
  config,
  projectTitle,
}: {
  config: RecapConfig;
  projectTitle: string;
}) {
  const lines: string[] = [];
  // Read-only here — the persona is edited in its own panel, but it's
  // part of what the next turn sees, so the banner would lie by omission.
  if (config.persona?.trim()) {
    lines.push(`persona: ${truncate(config.persona.trim(), 90)}`);
  }
  if (config.target_duration_seconds > 0) {
    lines.push(
      `target duration: ${config.target_duration_seconds}s (≈ ${formatDuration(config.target_duration_seconds)})`,
    );
  }
  if (config.narration_style.trim()) {
    lines.push(`narration: ${config.narration_style.trim()}`);
  }
  if (config.additional_notes.trim()) {
    lines.push(`notes: ${truncate(config.additional_notes.trim(), 90)}`);
  }
  // Outro line always shows since we have a sensible default — when
  // description is empty, we surface the cyberpunk-title fallback that
  // matches what the agent will see.
  const outroLabel = config.outro.description.trim()
    ? truncate(config.outro.description.trim(), 90)
    : `cyberpunk-title default — "${projectTitle || "Clipwright"}"`;
  lines.push(`outro (~${config.outro.duration_seconds}s): ${outroLabel}`);
  return (
    <div className="flex flex-col gap-1 rounded border border-accent/30 bg-accent/5 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
        Next Claude turn will see
      </span>
      <ul className="text-[11px] text-fg-subtle">
        {lines.map((l, i) => (
          <li key={i}>· {l}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg">{label}</span>
      {hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        "rounded px-3 py-1 text-xs transition-colors",
        active
          ? "bg-accent/15 text-fg"
          : "text-fg-muted hover:bg-bg-raised hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Per-video overrides panel
// ---------------------------------------------------------------------------
//
// Each field shows the project-level default as a placeholder /
// helper line so the user knows what they'd be overriding. Setting a
// field to non-empty saves into `Video.recap_overrides`; emptying
// removes the override and the project default takes over.

function VideoOverridesPanel({
  overrides,
  onChange,
  projectConfig,
  projectVoice,
  videoId,
}: {
  overrides: OverrideMap;
  onChange: (next: OverrideMap) => void;
  projectConfig: RecapConfig;
  projectVoice: { provider: string; voice_id: string };
  videoId: string;
}) {
  /** Apply a patch of override keys in ONE update.
   *
   *  Takes a patch rather than a single key on purpose. The previous
   *  signature was `set(key, value)`, and the provider dropdown called
   *  it twice in a row — once for `voice_provider`, once to snap
   *  `voice_id` to the new provider's default. Both calls spread the
   *  same captured `overrides`, React batched them, and the second
   *  clobbered the first: the provider you picked silently reverted.
   *  It only misbehaved when the second call fired (i.e. when the old
   *  voice wasn't in the new provider's catalog), which is why it read
   *  as "sometimes it doesn't stick".
   *
   *  Empty string / 0 means "inherit the project value", so those keys
   *  are deleted rather than stored. Booleans are meaningful at
   *  `false` and bypass that clearing.
   */
  function set(patch: Record<string, string | number | boolean>) {
    const next: OverrideMap = { ...overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== "boolean" && (value === "" || value === 0)) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    onChange(next);
  }

  const overrideProvider = (overrides.voice_provider as string) ?? "";
  const overrideVoice = (overrides.voice_id as string) ?? "";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col">
        <h3 className="text-sm font-medium text-fg">
          Per-video overrides · <span className="font-mono">{videoId}</span>
        </h3>
        <span className="text-[11px] text-fg-muted">
          Each field overrides the project default for just this video.
          Leave a field blank to inherit the project value.
        </span>
      </header>

      <Field
        label="Target duration"
        hint={`Project default: ${projectConfig.target_duration_seconds}s. Set 0 to inherit.`}
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={1800}
            value={(overrides.target_duration_seconds as number) || ""}
            placeholder="0 (use project default)"
            onChange={(e) =>
              set({ target_duration_seconds: parseInt(e.target.value || "0", 10) || 0 })
            }
            className="w-40 rounded border border-border-subtle bg-bg-inset px-2 py-1 font-mono text-sm text-fg focus:focus-ring"
          />
          <span className="text-xs text-fg-muted">seconds</span>
        </div>
      </Field>

      <Field
        label="Narration style"
        hint={`Project default: ${projectConfig.narration_style || "(none)"}`}
      >
        <input
          type="text"
          value={(overrides.narration_style as string) || ""}
          placeholder="(use project default)"
          onChange={(e) => set({ narration_style: e.target.value })}
          className="w-full rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg focus:focus-ring"
        />
      </Field>

      <Field
        label="Additional notes"
        hint={
          projectConfig.additional_notes
            ? `Project default: ${truncate(projectConfig.additional_notes, 80)}`
            : "Free-form notes Claude should remember for this specific video."
        }
      >
        <textarea
          value={(overrides.additional_notes as string) || ""}
          onChange={(e) => set({ additional_notes: e.target.value })}
          rows={3}
          placeholder="(use project default)"
          className="w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg focus:focus-ring"
        />
      </Field>

      <section className="flex flex-col gap-2">
        <span className="text-xs font-medium text-fg">Voice override</span>
        <span className="text-[11px] text-fg-muted">
          Project default voice: provider{" "}
          <span className="font-mono">{projectVoice.provider || "(unset)"}</span> · voice{" "}
          <span className="font-mono">{projectVoice.voice_id || "(unset)"}</span>.
          Pick a different one here for just this video, or leave blank to inherit.
        </span>
        <div className="grid grid-cols-2 gap-2">
          <Dropdown<string>
            value={overrideProvider}
            onChange={(next) => {
              // Provider and voice move together: switching provider
              // has to snap the voice to something that provider knows,
              // or the pair is inconsistent. One patch, one update.
              const p = next as VoiceProvider;
              const keepVoice = !next || voiceInCatalog(p, overrideVoice);
              set({
                voice_provider: next,
                voice_id: keepVoice ? overrideVoice : defaultVoiceFor(p),
              });
            }}
            options={[
              { value: "", label: "(use project default)", hint: "Inherit" },
              ...VOICE_PROVIDER_OPTIONS,
            ]}
            wrapperClassName="block w-full"
            triggerClassName="w-full justify-between bg-bg-inset px-2 py-1 text-sm text-fg"
            placeholder="(use project default)"
            menuMinWidth={240}
          />
          <Dropdown<string>
            value={overrideVoice}
            onChange={(v) => set({ voice_id: v })}
            options={
              overrideProvider && overrideProvider in VOICES_BY_PROVIDER
                ? [
                    { value: "", label: "(use project default)", hint: "Inherit" },
                    ...VOICES_BY_PROVIDER[overrideProvider as VoiceProvider],
                  ]
                : [{ value: "", label: "(use project default)", hint: "Inherit" }]
            }
            wrapperClassName="block w-full"
            triggerClassName="w-full justify-between bg-bg-inset px-2 py-1 text-sm text-fg"
            placeholder="(use project default)"
            disabled={!overrideProvider}
            menuMinWidth={220}
          />
        </div>
        {/* Falls back to the project's provider/voice so you can audition
         *  what this video will actually use, override set or not. */}
        <div className="flex justify-end">
          <VoicePreview
            provider={overrideProvider || projectVoice.provider}
            voice={overrideVoice || projectVoice.voice_id}
          />
        </div>
      </section>

      <Field
        label="Outro description"
        hint={
          projectConfig.outro.description
            ? `Project default: ${truncate(projectConfig.outro.description, 80)}`
            : "Project default uses the cyberpunk-title fallback."
        }
      >
        <textarea
          value={(overrides.outro_description as string) || ""}
          onChange={(e) => set({ outro_description: e.target.value })}
          rows={3}
          placeholder="(use project default)"
          className="w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg focus:focus-ring"
        />
      </Field>

      <Field
        label="Outro duration"
        hint={`Project default: ${projectConfig.outro.duration_seconds}s. Set 0 to inherit.`}
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={(overrides.outro_duration_seconds as number) || ""}
            placeholder="0 (use project default)"
            onChange={(e) =>
              set({ outro_duration_seconds: parseFloat(e.target.value || "0") || 0 })
            }
            className="w-40 rounded border border-border-subtle bg-bg-inset px-2 py-1 font-mono text-sm text-fg focus:focus-ring"
          />
          <span className="text-xs text-fg-muted">seconds</span>
        </div>
      </Field>
    </div>
  );
}
