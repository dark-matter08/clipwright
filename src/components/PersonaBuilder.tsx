// Persona builder — compose "who Claude IS when it writes for this
// project" without staring at an empty textarea.
//
// Two modes over ONE string. The persona is stored as free prose
// (`RecapConfig.persona`), because that's what the agent prompt
// blockquotes verbatim; the builder is a way to *produce* that prose,
// not a second schema.
//
//   * Guided  — six fields covering the blocks that actually change
//               output: identity, tone, structural rules, vocabulary,
//               pacing, and the failure mode to forbid.
//   * Custom  — the raw textarea, for anyone who'd rather just write.
//
// Editing the composed text directly flips you to Custom and keeps
// what you typed. Going back to Guided re-composes from the fields,
// which discards hand-edits — so we say so on the button rather than
// silently eating the user's prose.

import { useId, useMemo, useState } from "react";
import { Drama, Wand2 } from "lucide-react";
import type { PersonaDraft } from "../lib/tauri";
import { cn } from "../lib/cn";

/** Guided-mode field values. Declared in `lib/tauri.ts` because it's
 *  a wire shape — it round-trips through `recap-config.json` and has
 *  Rust and Python mirrors. Re-exported here so consumers of the
 *  builder don't have to know that. */
export type { PersonaDraft };

export const EMPTY_PERSONA_DRAFT: PersonaDraft = {
  role: "",
  voice: "",
  moves: "",
  vocabulary: "",
  pacing: "",
  avoid: "",
};

/** Compose the guided fields into the text the prompt will quote.
 *
 *  Shape: the identity as a sentence, then each remaining block as a
 *  labelled bullet. Labelled bullets rather than markdown headers
 *  because the agent prompt already nests this under `## Persona` and
 *  blockquotes it line by line — a `> ## Role` would collide with that
 *  heading level and read as a sibling section, not part of the quote.
 *
 *  Every field is optional. A persona with only a role is perfectly
 *  usable, and empty fields must not leave a dangling label behind.
 */
export function composePersona(d: PersonaDraft): string {
  const role = d.role.trim();
  const blocks: [string, string][] = [
    ["Voice & tone", d.voice.trim()],
    ["Structural rules", d.moves.trim()],
    ["Vocabulary", d.vocabulary.trim()],
    ["Pacing", d.pacing.trim()],
    ["Never", d.avoid.trim()],
  ];
  const body = blocks
    .filter(([, v]) => v)
    .map(([label, v]) => `- ${label}: ${endWithPeriod(v)}`);
  if (!role && body.length === 0) return "";

  const lines: string[] = [];
  if (role) lines.push(endWithPeriod(role));
  if (body.length) {
    if (lines.length) lines.push("");
    lines.push(...body);
  }
  return lines.join("\n");
}

function endWithPeriod(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}


/** Ready-made personas. Each fills the guided fields, so picking one
 *  is a starting point you can edit field-by-field rather than a wall
 *  of prose you have to unpick. */
export const PERSONA_PRESETS: { label: string; draft: PersonaDraft }[] = [
  {
    label: "Manhwa recapper",
    draft: {
      role: "You are an elite manhwa recap scriptwriter whose scripts hold 80% audience retention because you cut every line that isn't plot, power, or betrayal",
      voice: "Casual, fast, present tense. Rhetorical hooks between beats. Gaming and anime vocabulary used naturally — nerfed, glass cannon, MC",
      moves:
        "Open on the single sharpest image in the chapter. Name one concrete event per beat. Escalate, then tease the climax and stop — the unread chapter is the product",
      vocabulary:
        "Prefer hard verbs — smashed, betrayed, blitzed, buried. Ban \"furthermore\", \"in conclusion\", \"as the story progresses\", \"our protagonist\", \"in a world where\". Call characters by name or title",
      pacing:
        "Max 15 words per sentence. Roughly 2.5 spoken words per second of target duration. Given several chapters, spend the runtime on the fight and the twist, and compress travel and exposition to one line each",
      avoid:
        "Spoil past the chapter being recapped, resolve the cliffhanger, or pad a beat with mood instead of plot",
    },
  },
  {
    label: "Sardonic narrator",
    draft: {
      role: "You are a sardonic narrator with a deadpan sense of timing",
      voice: "Dry and level. Present tense. The joke lands because you didn't signal it",
      moves: "Play the plot straight and earn one aside every three beats",
      vocabulary: "Plain words. Ban exclamation marks and hype adjectives — insane, epic, crazy",
      pacing: "Short sentences. Let a beat breathe before the aside",
      avoid: "Reach for melodrama the story hasn't paid for",
    },
  },
  {
    label: "Product demo host",
    draft: {
      role: "You are a product demo host who shows rather than tells",
      voice: "Warm, concrete, second person",
      moves:
        "Lead with the outcome the viewer wants, then narrate each step as it happens on screen",
      vocabulary:
        "Name real UI elements — the button, the field, the sidebar. Ban marketing adjectives — seamless, powerful, robust, game-changing",
      pacing: "One step per beat. Never narrate ahead of the cursor",
      avoid: "Explain a feature before showing its result",
    },
  },
  {
    label: "Documentary explainer",
    draft: {
      role: "You are a documentary explainer with a calm, authoritative voice",
      voice: "Measured and unhurried, letting the visuals carry what words don't need to",
      moves: "Build one idea at a time and define a term the moment you first use it",
      vocabulary: "Concrete nouns over abstractions. Ban \"basically\", \"simply\", \"just\"",
      pacing: "One idea per sentence. Pause on the number that matters",
      avoid: "Stack three ideas into one sentence",
    },
  },
];

/** Prose + fields always change together, so they're reported together.
 *
 *  This used to be two callbacks. Callers wrote them as two `setState`
 *  spreads of the same captured object, React batched them, and the
 *  second silently clobbered the first — typing in a guided field did
 *  nothing at all. One atomic change makes that unrepresentable. */
export interface PersonaChange {
  persona: string;
  draft: PersonaDraft;
}

interface Props {
  /** The composed prose — the value that actually ships to the prompt. */
  value: string;
  draft: PersonaDraft;
  onChange: (next: PersonaChange) => void;
  mode: "guided" | "custom";
  onModeChange: (next: "guided" | "custom") => void;
  /** Rendered under the header. Lets the settings dialog and the
   *  new-project step explain the same control in their own words. */
  hint?: string;
}

export function PersonaBuilder({
  value,
  draft,
  onChange,
  mode,
  onModeChange,
  hint,
}: Props) {
  const composed = useMemo(() => composePersona(draft), [draft]);

  function setField(key: keyof PersonaDraft, v: string) {
    const next = { ...draft, [key]: v };
    // Guided mode owns the prose: every keystroke recomposes it, so
    // what you see in the preview is exactly what the prompt gets.
    onChange({ persona: composePersona(next), draft: next });
  }

  function applyPreset(preset: (typeof PERSONA_PRESETS)[number]) {
    onChange({ persona: composePersona(preset.draft), draft: preset.draft });
    onModeChange("guided");
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <Drama size={13} strokeWidth={2} className="text-accent" />
            Persona
          </h3>
          <span className="text-[11px] text-fg-muted">
            {hint ??
              "Who Claude is when it writes for this project. Applies to every video here and outranks the template on tone."}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded border border-border-subtle p-0.5">
          <ModeTab
            active={mode === "guided"}
            label="Guided"
            title="Compose the persona from six fields"
            onClick={() => {
              // Re-composing throws away hand-edits, so only do it when
              // the fields actually have something to say.
              onModeChange("guided");
              if (composed) onChange({ persona: composed, draft });
            }}
          />
          <ModeTab
            active={mode === "custom"}
            label="Custom"
            title="Write the persona yourself"
            onClick={() => onModeChange("custom")}
          />
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-fg-muted">Start from:</span>
        {PERSONA_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => applyPreset(p)}
            title={composePersona(p.draft)}
            className="flex items-center gap-1 rounded border border-border-subtle px-2 py-0.5 text-[11px] text-fg-subtle transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg focus:focus-ring"
          >
            <Wand2 size={10} strokeWidth={2} />
            {p.label}
          </button>
        ))}
        {(value.trim() || composed) && (
          <button
            type="button"
            onClick={() =>
              onChange({ persona: "", draft: EMPTY_PERSONA_DRAFT })
            }
            className="ml-auto text-[11px] text-fg-muted transition-colors hover:text-fg"
          >
            Clear
          </button>
        )}
      </div>

      {mode === "guided" && (
        <div className="flex flex-col gap-2.5 rounded border border-border-subtle bg-bg-inset p-2.5">
          <BuilderField
            label="Who they are"
            hint="Completes “You are…”. Expertise and track record beat job title."
            placeholder="You are an elite manhwa recap scriptwriter whose scripts hold 80% retention"
            value={draft.role}
            onChange={(v) => setField("role", v)}
            rows={2}
          />
          <BuilderField
            label="Voice & tone"
            hint="How the prose sounds. Not the speaking voice — that's Narration style in settings."
            placeholder="Casual, fast, present tense. Rhetorical hooks between beats."
            value={draft.voice}
            onChange={(v) => setField("voice", v)}
            rows={2}
          />
          <BuilderField
            label="Structural rules"
            hint="What they do to a script, in order. The field that shapes structure rather than wording."
            placeholder="Open on the sharpest image. One concrete event per beat. Tease the climax and stop."
            value={draft.moves}
            onChange={(v) => setField("moves", v)}
            rows={2}
          />
          <BuilderField
            label="Vocabulary"
            hint="Words to prefer and words to ban. Cheapest field to get right, and the most visible in the output."
            placeholder={'Prefer hard verbs — smashed, betrayed. Ban "furthermore", "in a world where".'}
            value={draft.vocabulary}
            onChange={(v) => setField("vocabulary", v)}
            rows={2}
          />
          <BuilderField
            label="Pacing"
            hint="Sentence length and how to spend runtime across a long input. Without this, long inputs get flattened evenly."
            placeholder="Max 15 words per sentence. Spend the runtime on the fight; compress travel to one line."
            value={draft.pacing}
            onChange={(v) => setField("pacing", v)}
            rows={2}
          />
          <BuilderField
            label="Never does"
            hint="The failure mode you keep seeing. Stated as a prohibition it sticks better."
            placeholder="Resolve the cliffhanger, or pad a beat with mood instead of plot"
            value={draft.avoid}
            onChange={(v) => setField("avoid", v)}
            rows={2}
          />
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-xs font-medium text-fg">
          {mode === "guided" ? "Composed persona" : "Persona"}
          <span className="font-mono text-[10px] font-normal text-fg-muted">
            {value.trim() ? `${value.trim().length} chars` : "empty"}
          </span>
        </span>
        <span className="text-[11px] text-fg-muted">
          {mode === "guided"
            ? "Exactly what gets quoted into Claude's prompt. Edit it here to take manual control."
            : "Quoted verbatim into Claude's prompt. Finish the sentence “You are…”."}
        </span>
        <textarea
          value={value}
          onChange={(e) => {
            // Typing in the composed box means you want it as written —
            // switch to Custom so the next keystroke in a guided field
            // doesn't overwrite what you just did.
            if (mode === "guided") onModeChange("custom");
            onChange({ persona: e.target.value, draft });
          }}
          rows={mode === "guided" ? 3 : 6}
          placeholder={composePersona(PERSONA_PRESETS[0].draft)}
          className="mt-0.5 w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
        />
      </label>
    </section>
  );
}

function ModeTab({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded px-2 py-0.5 text-[11px] transition-colors",
        active ? "bg-accent/15 text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

function BuilderField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  rows = 2,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  // Six fields with permanent two-line hints was most of the rail's
  // height, and the hints are only useful while you're in the field.
  // They now appear on focus; `aria-describedby` keeps them attached
  // for screen readers whether or not they're visible, and `title`
  // keeps them reachable on hover.
  const [focused, setFocused] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  const filled = value.trim().length > 0;
  return (
    <div className="flex flex-col gap-0.5">
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-[11px] font-medium text-fg"
      >
        {label}
        {filled && (
          <span
            aria-hidden
            className="h-1 w-1 rounded-full bg-accent"
            title="Set"
          />
        )}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={rows}
        placeholder={placeholder}
        title={hint}
        aria-describedby={hintId}
        className="w-full resize-y rounded border border-border-subtle bg-bg px-2 py-1 text-[12px] leading-snug text-fg placeholder:text-fg-muted/60 focus:focus-ring"
      />
      <span
        id={hintId}
        className={cn(
          "text-[10px] text-fg-muted",
          !focused && "sr-only",
        )}
      >
        {hint}
      </span>
    </div>
  );
}
