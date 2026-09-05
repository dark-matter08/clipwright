// Persona rail — a working surface for the project's writing persona.
//
// Opened from the top bar, and shaped like the Claude rail rather than
// a modal on purpose: writing a persona is iterative. You want the
// timeline and the transcript still on screen while you tune it, and
// you want to leave it open across several Claude turns to see whether
// the voice actually landed. A modal forces a decision and closes.
//
// Owns two scopes at once, because they're the same decision:
//   * Project — the persona every video inherits (recap-config.json).
//   * This video — whether it opts in at all, and an optional
//     video-specific persona that replaces the project one
//     (videos/<id>.json#recap_overrides).
//
// Saving is explicit. Auto-saving a half-typed persona would ship it
// to the next Claude turn mid-thought, and turns are expensive.

import { useEffect, useMemo, useState } from "react";
import { Check, Drama, Loader2, Telescope, X } from "lucide-react";
import {
  DEFAULT_RECAP_CONFIG,
  getRecapConfig,
  saveVideo,
  setRecapConfig,
  type RecapConfig,
} from "../lib/tauri";
import { useApp } from "../lib/store";
import { cn } from "../lib/cn";
import {
  composePersona,
  EMPTY_PERSONA_DRAFT,
  PersonaBuilder,
} from "./PersonaBuilder";

/** Loaded into the Claude composer by "Derive from a reference".
 *
 *  Asks for the six builder blocks by name and in order, so the reply
 *  can be pasted field-for-field. It deliberately asks for observable
 *  detail (actual banned phrases, actual sentence lengths) rather than
 *  adjectives — "energetic and fun" changes nothing about the output,
 *  while "max 15 words per sentence, never says 'furthermore'" does. */
const EXTRACTION_PROMPT = `I want to build a writing persona from a reference.

Below this line I'll paste a transcript from a channel whose voice I want to work in. (If I haven't pasted one yet, ask me for it and stop.)

Reverse-engineer its style and give me exactly these six blocks, each 1-3 sentences, concrete enough that following them changes the output:

1. **Who they are** — identity and expertise, completing "You are…".
2. **Voice & tone** — tense, register, rhythm.
3. **Structural rules** — what they do to a script, in order: how they open, how a beat is built, how they close.
4. **Vocabulary** — actual verbs and phrases they reach for, and actual words they never use. Quote real examples from the transcript.
5. **Pacing** — measured, not vibes: words per sentence, how runtime is spent across the material, what gets compressed.
6. **Never does** — the failure mode this style deliberately avoids.

Rules: describe what's observably in the transcript, not what sounds flattering. No adjectives I can't act on ("engaging", "dynamic"). Don't write me a sample script — just the six blocks, so I can paste each into the persona builder.

---
`;

export function PersonaRail({ collapsed }: { collapsed: boolean }) {
  const project = useApp((s) => s.project);
  const loadProject = useApp((s) => s.loadProject);
  const setError = useApp((s) => s.setError);
  const toggle = useApp((s) => s.togglePersonaRail);
  const toggleClaudeRail = useApp((s) => s.toggleClaudeRail);
  const updateChatRuntime = useApp((s) => s.updateChatRuntime);

  const [config, setConfig] = useState<RecapConfig>(DEFAULT_RECAP_CONFIG);
  const [pristine, setPristine] = useState<RecapConfig>(DEFAULT_RECAP_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [mode, setMode] = useState<"guided" | "custom">("guided");

  const video = project?.video ?? null;
  const videoId = video?.video_id ?? "";
  const overrides = useMemo(
    () => (video?.recap_overrides ?? {}) as Record<string, unknown>,
    [video],
  );

  // Per-video state, mirrored locally so Save is one atomic action.
  const [personaEnabled, setPersonaEnabled] = useState(true);
  const [videoPersona, setVideoPersona] = useState("");

  useEffect(() => {
    setPersonaEnabled(overrides.persona_enabled !== false);
    setVideoPersona(String(overrides.persona ?? ""));
  }, [overrides]);

  useEffect(() => {
    if (!project?.project_dir) return;
    setLoading(true);
    getRecapConfig(project.project_dir)
      .then((loaded) => {
        setConfig(loaded);
        setPristine(loaded);
        // Resume in Guided only when the saved prose is still exactly
        // what the saved fields compose to. Otherwise it was
        // hand-written, and opening in Guided would overwrite it on the
        // first keystroke in any field.
        const draft = loaded.persona_draft ?? EMPTY_PERSONA_DRAFT;
        const persona = (loaded.persona ?? "").trim();
        const composed = composePersona(draft).trim();
        setMode(!persona || composed === persona ? "guided" : "custom");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [project?.project_dir, setError]);

  const projectDirty = JSON.stringify(config) !== JSON.stringify(pristine);
  const videoDirty =
    personaEnabled !== (overrides.persona_enabled !== false) ||
    videoPersona !== String(overrides.persona ?? "");
  const dirty = projectDirty || videoDirty;

  async function onSave() {
    if (!project?.project_dir || saving || !dirty) return;
    setSaving(true);
    try {
      if (projectDirty) {
        await setRecapConfig(project.project_dir, config);
        setPristine(config);
      }
      if (videoDirty && video) {
        const next: Record<string, unknown> = { ...overrides };
        // Absence is what the prompt reads as "enabled", so only the
        // opt-out is ever written — that keeps today's default out of
        // the manifest and lets it change later without a migration.
        if (personaEnabled) delete next.persona_enabled;
        else next.persona_enabled = false;
        if (videoPersona.trim()) next.persona = videoPersona.trim();
        else delete next.persona;
        const nextVideo = {
          ...video,
          recap_overrides: next as typeof video.recap_overrides,
        };
        await saveVideo(project.project_dir, video.video_id, nextVideo);
        loadProject({ ...project, video: nextVideo });
      }
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /** Hand the reverse-engineering job to Claude.
   *
   *  Deriving a persona from a channel you admire beats inventing one
   *  from scratch — you can hear the voice you want long before you can
   *  describe it. We don't call the model from here: we load the
   *  extraction prompt into the Claude composer and switch to that rail,
   *  so the user reviews and sends it themselves. Firing a turn off a
   *  button press would spend tokens the user didn't ask to spend, and
   *  they usually want to paste a transcript in first. */
  function draftFromReference() {
    if (!videoId) return;
    updateChatRuntime(videoId, { draft: EXTRACTION_PROMPT });
    toggleClaudeRail();
  }

  // Clear the "saved" tick once the user starts editing again.
  useEffect(() => {
    if (dirty) setSavedAt(null);
  }, [dirty]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        title="Open Persona panel"
        className="flex h-full w-full flex-col items-center justify-start gap-3 pt-3 text-fg-muted transition-colors hover:text-fg"
      >
        <Drama size={16} strokeWidth={1.75} />
        <span className="rotate-180 [writing-mode:vertical-rl] text-xs">
          Persona
        </span>
      </button>
    );
  }

  if (!project) return null;

  const effective = videoPersona.trim() || config.persona.trim();

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Persona
        </span>
        <button
          type="button"
          onClick={toggle}
          title="Close Persona panel"
          aria-label="Close Persona panel"
          className="rounded p-1 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-fg-muted">
          <Loader2 size={16} strokeWidth={2} className="mr-2 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <button
            type="button"
            onClick={draftFromReference}
            disabled={!videoId}
            title={
              videoId
                ? "Load a prompt into the Claude composer that reverse-engineers a persona from a reference script"
                : "Open a video first — the extraction runs in that video's chat"
            }
            className="mb-3 flex w-full items-center gap-2 rounded border border-border-subtle px-2.5 py-2 text-left transition-colors hover:border-accent/50 hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Telescope size={14} strokeWidth={2} className="shrink-0 text-accent" />
            <span className="flex min-w-0 flex-col">
              <span className="text-xs font-medium text-fg">
                Derive from a reference
              </span>
              <span className="text-[11px] text-fg-muted">
                Paste a transcript from a channel you like — Claude extracts
                the voice into these fields.
              </span>
            </span>
          </button>

          <PersonaBuilder
            value={config.persona}
            draft={config.persona_draft ?? EMPTY_PERSONA_DRAFT}
            onChange={({ persona, draft }) =>
              // Functional form on top of the atomic change: the rail
              // also writes `config` from the load effect and the video
              // section, and a captured-spread here would race those.
              setConfig((c) => ({ ...c, persona, persona_draft: draft }))
            }
            mode={mode}
            onModeChange={setMode}
            hint="Who Claude is when it writes for this project. Every video inherits it, and it outranks the template on tone."
          />

          {video && (
            <section className="mt-5 flex flex-col gap-2 border-t border-border-subtle pt-4">
              <h3 className="text-sm font-medium text-fg">
                This video ·{" "}
                <span className="font-mono text-xs text-fg-muted">{videoId}</span>
              </h3>

              <label className="flex cursor-pointer items-start gap-2 rounded border border-border-subtle bg-bg-inset px-2.5 py-2">
                <input
                  type="checkbox"
                  checked={personaEnabled}
                  onChange={(e) => setPersonaEnabled(e.target.checked)}
                  className="mt-[3px] accent-accent"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-medium text-fg">
                    Use a persona for this video
                  </span>
                  <span className="text-[11px] text-fg-muted">
                    {personaEnabled
                      ? "On — this video writes in character."
                      : "Off — Claude writes without a persona here. The template's own voice guidance applies instead."}
                  </span>
                </span>
              </label>

              <label
                className={cn(
                  "flex flex-col gap-1",
                  !personaEnabled && "pointer-events-none opacity-40",
                )}
              >
                <span className="text-xs font-medium text-fg">
                  Override for this video
                </span>
                <span className="text-[11px] text-fg-muted">
                  Replaces the project persona for this one video. Leave blank
                  to inherit.
                </span>
                <textarea
                  value={videoPersona}
                  onChange={(e) => setVideoPersona(e.target.value)}
                  rows={3}
                  disabled={!personaEnabled}
                  placeholder="(inherit the project persona)"
                  className="mt-0.5 w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
                />
              </label>
            </section>
          )}

          {/* What the next turn actually gets, after both scopes resolve.
           *  Two settings interact here, so showing the resolved result
           *  beats making the user simulate the precedence rules. */}
          <div className="mt-4 flex flex-col gap-1 rounded border border-accent/30 bg-accent/5 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
              Next Claude turn will see
            </span>
            {!personaEnabled ? (
              <span className="text-[11px] text-fg-subtle">
                No persona section — this video opted out.
              </span>
            ) : effective ? (
              <span className="text-[11px] italic text-fg-subtle">
                “{effective}”
                {videoPersona.trim() && (
                  <span className="not-italic text-fg-muted">
                    {" "}
                    · video override
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[11px] text-fg-subtle">
                No persona section — nothing set yet.
              </span>
            )}
          </div>
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-between border-t border-border-subtle px-3 py-2">
        <span className="text-[11px] text-fg-muted">
          {dirty
            ? "Unsaved changes"
            : savedAt
              ? "Saved · applies to the next Claude turn"
              : "Applies to the next Claude turn"}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            "flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-bg transition-colors hover:bg-accent-hover focus:focus-ring",
            (!dirty || saving) && "cursor-not-allowed opacity-50",
          )}
        >
          {saving ? (
            <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />
          ) : savedAt && !dirty ? (
            <Check size={12} strokeWidth={2.5} />
          ) : null}
          Save persona
        </button>
      </footer>
    </div>
  );
}
