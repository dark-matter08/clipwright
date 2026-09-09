// Audition a voice before committing it to a project.
//
// The pickers list names — "onyx", "ballad", "af_heart" — which tell you
// nothing about how a voice sounds. Previously the only way to find out
// was to set it, render a segment, and listen. This synthesizes one
// short line on demand and plays it inline.
//
// Deliberately click-to-play rather than auto-playing on selection:
// paid providers bill per synthesis, and a dropdown you're arrow-keying
// through would fire a request per voice you pass over.

import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Loader2, Play, Square, TriangleAlert } from "lucide-react";
import { ttsSample } from "../lib/tauri";
import { cn } from "../lib/cn";

type State = "idle" | "loading" | "playing" | "error";

export function VoicePreview({
  provider,
  voice,
  speed,
  pitch,
  instructions,
  className,
}: {
  provider: string;
  voice: string;
  /** The persona's tone controls. Passing them makes the preview an
   *  audition of what you'll actually get; leaving them off previews
   *  the raw voice, which is right where no persona owns the settings
   *  (the per-segment picker, say). */
  speed?: number;
  pitch?: number;
  instructions?: string;
  className?: string;
}) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop and reset when the target voice changes — otherwise clicking
  // through voices leaves the previous one playing over the next.
  useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setState("idle");
    setError(null);
  }, [provider, voice, speed, pitch, instructions]);

  // Don't leave audio playing when the dialog or panel unmounts.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  async function onClick() {
    if (state === "playing") {
      audioRef.current?.pause();
      audioRef.current = null;
      setState("idle");
      return;
    }
    setState("loading");
    setError(null);
    try {
      const { path } = await ttsSample(provider, voice, {
        speed,
        pitch,
        instructions,
      });
      const audio = new Audio(convertFileSrc(path));
      audioRef.current = audio;
      audio.onended = () => setState("idle");
      audio.onerror = () => {
        setError("Could not play the sample audio.");
        setState("error");
      };
      await audio.play();
      setState("playing");
    } catch (e) {
      // The Python side returns a message plus a fix hint for the two
      // things that actually go wrong here — a missing API key and an
      // uninstalled local backend. Surfacing it beats a generic failure.
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  const disabled = !provider || !voice;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || state === "loading"}
      title={
        disabled
          ? "Pick a provider and voice first"
          : error
            ? error
            : state === "playing"
              ? "Stop"
              : `Hear ${voice}`
      }
      aria-label={state === "playing" ? `Stop ${voice} sample` : `Play ${voice} sample`}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-[11px] transition-colors",
        state === "error"
          ? "border-warn/40 text-warn"
          : "text-fg-subtle hover:border-accent/50 hover:bg-accent/10 hover:text-fg",
        (disabled || state === "loading") && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {state === "loading" ? (
        <Loader2 size={11} strokeWidth={2} className="animate-spin" />
      ) : state === "playing" ? (
        <Square size={10} strokeWidth={2.5} fill="currentColor" />
      ) : state === "error" ? (
        <TriangleAlert size={11} strokeWidth={2} />
      ) : (
        <Play size={10} strokeWidth={2.5} fill="currentColor" />
      )}
      {state === "loading" ? "…" : state === "playing" ? "Stop" : "Preview"}
    </button>
  );
}
