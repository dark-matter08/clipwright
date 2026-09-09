// Per-persona voice: provider, voice, and the tone controls.
//
// Voice belongs to the persona rather than the project — a persona is a
// narrator, and the same narrator shouldn't sound different because
// it's working on a different project.
//
// The controls are deliberately not a uniform grid. Providers support
// genuinely different things, and pretending otherwise means a slider
// that does nothing on three of four backends. What each control does:
//
//   speed        every provider, natively
//   pitch        NO provider — applied post-synthesis in ffmpeg
//   instructions OpenAI only, and the strongest tone lever that exists
//   stability…   ElevenLabs only

import { Info } from "lucide-react";
import {
  VOICE_PROVIDER_OPTIONS,
  VOICES_BY_PROVIDER,
  defaultVoiceFor,
  voiceInCatalog,
  type VoiceProvider,
} from "../lib/voiceCatalog";
import type { PersonaVoice } from "../lib/tauri";
import { cn } from "../lib/cn";
import { Dropdown } from "./Dropdown";
import { VoicePreview } from "./VoicePreview";

export function VoiceControls({
  voice,
  onChange,
}: {
  voice: PersonaVoice;
  /** One patch per change. Provider and voice move together, so they
   *  can't be two racing writes — the bug that made the old per-video
   *  picker revert selections. */
  onChange: (patch: Partial<PersonaVoice>) => void;
}) {
  const provider = (voice.provider || "kokoro") as VoiceProvider;
  const isOpenAI = provider === "openai";
  const isEleven = provider === "elevenlabs";

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col">
        <h3 className="text-sm font-medium text-fg">Voice</h3>
        <span className="text-[11px] text-fg-muted">
          Travels with the persona into every project that uses it.
        </span>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Dropdown<string>
          value={provider}
          onChange={(next) => {
            // Snap the voice to something the new provider knows, in the
            // same patch — otherwise the pair is briefly inconsistent.
            const p = next as VoiceProvider;
            onChange({
              provider: next,
              voice_id: voiceInCatalog(p, voice.voice_id)
                ? voice.voice_id
                : defaultVoiceFor(p),
            });
          }}
          options={VOICE_PROVIDER_OPTIONS as unknown as Array<{
            value: string;
            label: string;
            hint?: string;
          }>}
          wrapperClassName="block w-full"
          triggerClassName="w-full justify-between bg-bg-inset px-2 py-1.5 text-sm text-fg"
          menuMinWidth={260}
        />
        <div className="flex items-center gap-1.5">
          <Dropdown<string>
            value={voice.voice_id}
            onChange={(v) => onChange({ voice_id: v })}
            options={VOICES_BY_PROVIDER[provider] ?? []}
            wrapperClassName="block min-w-0 flex-1"
            triggerClassName="w-full justify-between bg-bg-inset px-2 py-1.5 text-sm text-fg"
            placeholder="(provider default)"
            menuMinWidth={240}
          />
          <VoicePreview provider={provider} voice={voice.voice_id} />
        </div>
      </div>

      <Slider
        label="Speed"
        hint="Delivery rate. Applied at synthesis where the provider supports it, so timings stay accurate."
        value={voice.speed}
        min={0.6}
        max={1.6}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(speed) => onChange({ speed })}
      />

      <Slider
        label="Pitch"
        hint="No TTS provider offers pitch, so this is applied after synthesis by resampling. Past ±2 it stops sounding like a different voice and starts sounding processed."
        value={voice.pitch_semitones}
        min={-6}
        max={6}
        step={0.5}
        format={(v) => (v === 0 ? "natural" : `${v > 0 ? "+" : ""}${v} st`)}
        warnOutside={[-2, 2]}
        onChange={(pitch_semitones) => onChange({ pitch_semitones })}
      />

      {isOpenAI && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg">Delivery instructions</span>
          <span className="text-[11px] text-fg-muted">
            OpenAI only, and the strongest tone control any provider
            exposes — plain English, describing how to perform the line.
          </span>
          <textarea
            value={voice.instructions}
            onChange={(e) => onChange({ instructions: e.target.value })}
            rows={2}
            placeholder="Gravelly and unhurried. Drop to a near-whisper on the last line."
            className="mt-0.5 w-full resize-y rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:focus-ring"
          />
        </label>
      )}

      {isEleven && (
        <div className="flex flex-col gap-2.5">
          <Slider
            label="Stability"
            hint="Low is more expressive and more variable between takes; high is consistent and flatter."
            value={voice.stability}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(stability) => onChange({ stability })}
          />
          <Slider
            label="Similarity"
            hint="How closely to match the original voice sample."
            value={voice.similarity_boost}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(similarity_boost) => onChange({ similarity_boost })}
          />
          <Slider
            label="Style"
            hint="Exaggerates the source voice's delivery. Costs latency and can destabilize long lines."
            value={voice.style}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(style) => onChange({ style })}
          />
        </div>
      )}

      {!isOpenAI && !isEleven && (
        <p className="flex items-start gap-1.5 rounded border border-border-subtle bg-bg-inset px-2 py-1.5 text-[11px] text-fg-muted">
          <Info size={12} strokeWidth={2} className="mt-px shrink-0" />
          <span>
            {provider === "kokoro" ? "Kokoro" : "Piper"} runs locally and exposes
            speed only. Pitch above still works — it's applied after synthesis.
            Switch to OpenAI for free-text delivery direction.
          </span>
        </p>
      )}
    </section>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
  warnOutside,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  /** Range outside which the value is flagged. Used for pitch, where
   *  the control accepts more than it can do well. */
  warnOutside?: [number, number];
}) {
  const warned =
    warnOutside && (value < warnOutside[0] || value > warnOutside[1]);
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-xs font-medium text-fg">
        {label}
        <span
          className={cn(
            "font-mono text-[11px] font-normal",
            warned ? "text-warn" : "text-fg-muted",
          )}
        >
          {format(value)}
        </span>
      </span>
      <span className="text-[11px] text-fg-muted">{hint}</span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-0.5 w-full accent-accent"
        aria-label={label}
      />
    </label>
  );
}
