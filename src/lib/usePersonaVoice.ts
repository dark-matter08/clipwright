// The tone controls that apply to the current project's voice.
//
// Speed, pitch and delivery instructions live on the persona, but the
// pickers that override *which* voice speaks — per video, per segment —
// don't own a persona and would otherwise preview a raw voice. That
// makes the preview button lie: you'd audition something with none of
// the tone the render will apply.
//
// This resolves the bound persona once and hands back its tone, so every
// preview in the app auditions what you'll actually get.

import { useEffect, useState } from "react";
import { EMPTY_PERSONA_VOICE, loadPersona, type PersonaVoice } from "./tauri";
import { useApp } from "./store";

export function usePersonaVoice(): PersonaVoice {
  // Per-video override beats the project's, matching how the agent
  // prompt and the TTS chain resolve it.
  const personaId = useApp(
    (s) =>
      (s.project?.video?.recap_overrides?.persona_id as string | undefined) ||
      s.project?.project?.persona_id ||
      "",
  );
  const [voice, setVoice] = useState<PersonaVoice>(EMPTY_PERSONA_VOICE);

  useEffect(() => {
    if (!personaId) {
      setVoice(EMPTY_PERSONA_VOICE);
      return;
    }
    let cancelled = false;
    loadPersona(personaId)
      .then((p) => !cancelled && setVoice(p.voice ?? EMPTY_PERSONA_VOICE))
      // A dangling persona reference shouldn't break a preview button —
      // the raw voice is still worth hearing.
      .catch(() => !cancelled && setVoice(EMPTY_PERSONA_VOICE));
    return () => {
      cancelled = true;
    };
  }, [personaId]);

  return voice;
}
