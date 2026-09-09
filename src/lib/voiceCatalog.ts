// Voice catalog per TTS provider.
//
// Used by the segment Inspector's Voiceover panel and (eventually) the
// per-video settings dialog to render dependent dropdowns: provider
// picker → voice picker. The voice list narrows to the chosen
// provider's catalog so the user can't pick `af_sky` (Kokoro) when
// `openai` is selected.
//
// These lists are deliberately curated, not exhaustive — we hand-pick
// a handful of widely-known voices per provider so the dropdown stays
// scannable. Power users with a custom voice id can type into the
// underlying input via the dropdown's free-text fallback (planned)
// or via the per-project / per-video config files.

export type VoiceProvider = "kokoro" | "piper" | "elevenlabs" | "openai";

export interface VoiceOption {
  value: string;
  label: string;
  hint?: string;
}

export const VOICE_PROVIDER_OPTIONS: ReadonlyArray<{
  value: VoiceProvider;
  label: string;
  hint: string;
}> = [
  {
    value: "kokoro",
    label: "Kokoro",
    hint: "Local Apache-2.0 TTS — fast, free, runs without an API key.",
  },
  {
    value: "openai",
    label: "OpenAI",
    hint: "OpenAI TTS API. Higher quality voices, paid, needs OPENAI_API_KEY.",
  },
  {
    value: "elevenlabs",
    label: "ElevenLabs",
    hint: "ElevenLabs voices. Highest quality, paid, needs ELEVENLABS_API_KEY.",
  },
  {
    value: "piper",
    label: "Piper",
    hint: "Local Piper TTS — broad accent coverage, runs without an API key.",
  },
];

/** Voices per provider. Each entry is `{value, label, hint?}` ready
 *  to feed into the `Dropdown` component. */
export const VOICES_BY_PROVIDER: Record<VoiceProvider, VoiceOption[]> = {
  kokoro: [
    // American voices — most commonly used.
    { value: "af_sky", label: "af_sky", hint: "American female, bright, neutral." },
    { value: "af_alloy", label: "af_alloy", hint: "American female, warm." },
    { value: "af_aoede", label: "af_aoede", hint: "American female, soft." },
    { value: "af_bella", label: "af_bella", hint: "American female, narration-friendly." },
    { value: "af_river", label: "af_river", hint: "American female, calm." },
    { value: "am_adam", label: "am_adam", hint: "American male, deep narrator." },
    { value: "am_echo", label: "am_echo", hint: "American male, conversational." },
    { value: "am_michael", label: "am_michael", hint: "American male, broadcast." },
    // British voices.
    { value: "bf_alice", label: "bf_alice", hint: "British female." },
    { value: "bf_emma", label: "bf_emma", hint: "British female, narration." },
    { value: "bf_lily", label: "bf_lily", hint: "British female, youthful." },
    { value: "bm_george", label: "bm_george", hint: "British male, deep." },
    { value: "bm_lewis", label: "bm_lewis", hint: "British male, conversational." },
  ],
  openai: [
    // All eleven OpenAI TTS voices — names map 1:1 to the API, and this
    // list must stay in step with `VOICES` in
    // `engine/clipwright/tts/openai.py`, which rejects anything outside
    // it before the request goes out. The catalog used to carry only
    // the original six; the five newer ones (ash, ballad, coral, sage,
    // verse) were unreachable from the app.
    { value: "alloy", label: "alloy", hint: "Neutral, balanced." },
    { value: "ash", label: "ash", hint: "Male, expressive, conversational." },
    { value: "ballad", label: "ballad", hint: "Male, British, emotive." },
    { value: "coral", label: "coral", hint: "Female, warm, upbeat." },
    { value: "echo", label: "echo", hint: "Male, deep, narration." },
    { value: "fable", label: "fable", hint: "Male, British, storyteller." },
    { value: "onyx", label: "onyx", hint: "Male, deep, dramatic." },
    { value: "nova", label: "nova", hint: "Female, bright, energetic." },
    { value: "sage", label: "sage", hint: "Female, calm, measured." },
    { value: "shimmer", label: "shimmer", hint: "Female, warm." },
    { value: "verse", label: "verse", hint: "Male, versatile, narration." },
    // Newest generation — noticeably more natural than the rest, and
    // only available on the `gpt-4o-mini-tts` model (which is the
    // default). Hints stay non-committal because these two are best
    // judged with the Preview button rather than from a label.
    { value: "marin", label: "marin", hint: "Newest generation — most natural. Preview it." },
    { value: "cedar", label: "cedar", hint: "Newest generation — most natural. Preview it." },
  ],
  elevenlabs: [
    // ElevenLabs voice IDs vary across accounts — these are the
    // famous-name presets available on every free-tier account.
    { value: "Rachel", label: "Rachel", hint: "Female, calm narrator." },
    { value: "Domi", label: "Domi", hint: "Female, strong, confident." },
    { value: "Bella", label: "Bella", hint: "Female, friendly." },
    { value: "Antoni", label: "Antoni", hint: "Male, well-rounded narrator." },
    { value: "Elli", label: "Elli", hint: "Female, emotional." },
    { value: "Josh", label: "Josh", hint: "Male, deep, broadcast." },
    { value: "Arnold", label: "Arnold", hint: "Male, crisp, neutral." },
    { value: "Adam", label: "Adam", hint: "Male, deep, narration." },
    { value: "Sam", label: "Sam", hint: "Male, casual." },
  ],
  piper: [
    // A trimmed list of high-quality Piper voices. Piper's catalog is
    // much larger; expose a curated subset and let advanced users
    // override via the config files.
    {
      value: "en_US-hfc_male-medium",
      label: "en_US-hfc_male",
      hint: "American male, medium quality, narration-friendly.",
    },
    {
      value: "en_US-amy-medium",
      label: "en_US-amy",
      hint: "American female, medium quality.",
    },
    {
      value: "en_US-ryan-medium",
      label: "en_US-ryan",
      hint: "American male, medium quality.",
    },
    {
      value: "en_US-libritts_r-medium",
      label: "en_US-libritts_r",
      hint: "American multi-speaker, medium quality.",
    },
    {
      value: "en_GB-alan-medium",
      label: "en_GB-alan",
      hint: "British male, medium quality.",
    },
    {
      value: "en_GB-jenny_dioco-medium",
      label: "en_GB-jenny",
      hint: "British female, medium quality.",
    },
  ],
};

/** First voice in a provider's catalog — a safe default when the user
 *  switches providers and no voice is yet selected for the new one. */
export function defaultVoiceFor(provider: VoiceProvider): string {
  const list = VOICES_BY_PROVIDER[provider];
  return list[0]?.value ?? "";
}

/** True when `voice` is in the catalog for `provider`. Used by the
 *  Inspector to keep a user-entered voice id when it doesn't match
 *  the catalog (free-text fallback). */
export function voiceInCatalog(
  provider: VoiceProvider,
  voice: string,
): boolean {
  return VOICES_BY_PROVIDER[provider].some((v) => v.value === voice);
}
