# Clipwright-specific overrides on top of remotion-best-practices

This file qualifies the vendored upstream Remotion skill for the
Clipwright codebase. The upstream skill is generic ("how to write
Remotion code") and a couple of its defaults conflict with how
Clipwright does things. Read this file LAST — after the upstream
SKILL.md and any rule files you pulled — so these overrides have the
final word.

## TTS provider — do NOT default to ElevenLabs

The upstream `rules/voiceover.md` recommends ElevenLabs as the
default TTS provider. Clipwright supports four providers and the
user picks one per project (in `project.json#tts_provider`) with
optional per-video overrides (in
`videos/<id>.json#recap_overrides.voice_provider`).

Resolution order at TTS time:

1. Clip-level: `script.json#clips[].voice` (provider + voice_id)
2. Video-level: `videos/<id>.json#recap_overrides` (voice_provider + voice_id)
3. Project-level: `project.json#tts_provider` + `voice_id`
4. Template default
5. Hardcoded fallback (`kokoro`, no voice)

When writing TTS code, READ the resolved provider from this chain.
Don't hardcode ElevenLabs. Don't recommend ElevenLabs to the user
unless they've asked about it. Clipwright already has
`tts-segment` (Python) that handles the resolution — prefer
invoking that over writing fresh ElevenLabs HTTP calls.

## FFmpeg — use the system binary, not `npx remotion ffmpeg`

The upstream `rules/ffmpeg.md` recommends `npx remotion ffmpeg ...`
which uses the bundled Remotion ffmpeg. Clipwright's Python
pipeline (`src/clipwright/import_video.py`,
`src/clipwright/render_segment.py`, `src/clipwright/render_final.py`)
shells out to the system `ffmpeg` / `ffprobe` directly via
`subprocess`. Keep using `subprocess.run(["ffmpeg", ...])` for
backend code. The `npx remotion ffmpeg` form is fine for one-off
frontend / Studio commands but not for the production pipeline.

## Trimming — Clipwright's source_start / source_end map cleanly

`rules/trimming.md` covers `trimBefore` / `trimAfter` on `<Video>`,
which maps 1:1 to Clipwright's per-segment `source_start` /
`source_end` (both in source-video seconds; multiply by `fps` to
get frames). The skill's pattern works as-is — there's no
Clipwright-specific override needed here.

## Captions — use Clipwright's pipeline, not raw SRT

The upstream `rules/display-captions.md` and
`rules/import-srt-captions.md` cover Remotion's caption rendering
primitives. Clipwright produces captions via `caption-segment`
(Python) which writes per-segment JSON under `captions/<video_id>/`
with word-level timings derived from the TTS-emitted timestamps.
Use Clipwright's caption JSON as the source of truth for caption
rendering in the Remotion composition; don't generate SRT
separately unless the user explicitly asks for it.

## Asset paths — `sources/` and `out/`, not `public/`

The upstream skill assumes a stock Remotion layout with assets
under `public/`. Clipwright projects keep:

- Source media in `sources/`
- Per-segment cached renders in `out/segments/<video_id>/`
- Voiceover MP3s in `voiceover/audio/<video_id>/`
- Caption JSON in `captions/<video_id>/`
- Final assembly in `out/final/<video_id>.mp4`

When generating Remotion code, reference these paths via the
Clipwright project layout, not the upstream `public/` convention.

## Composition entry point

The Remotion composition lives in `remotion/` at the repo root.
Specifically:

- `remotion/src/Root.tsx` — composition registry
- `remotion/remotion.config.ts` — Remotion CLI / Studio config
- `remotion/public/` — Remotion-side static assets (Clipwright
  project assets stay in the per-project `sources/`,
  `voiceover/`, `captions/` dirs and are passed in as
  composition props, not copied into Remotion's `public/`)

Compositions are defined in `Root.tsx` with explicit `width`,
`height`, `fps` matching the project's `project.json#aspect`
and `fps`. Don't scaffold a fresh Remotion project — the
existing one is already wired up to Clipwright's render
pipeline (see `src/clipwright/render_segment.py` and
`src/clipwright/render_final.py`).
