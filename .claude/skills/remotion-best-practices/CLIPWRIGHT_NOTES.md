# Clipwright-specific overrides on the Remotion skill set

This file qualifies the twelve vendored upstream Remotion skills for
the Clipwright codebase. Upstream is generic ("how to write Remotion
code") and a few of its defaults conflict with how Clipwright does
things. Read this file LAST — after the router and whichever sibling
skills you loaded — so these overrides have the final word.

Paths below are relative to `.claude/skills/`. Upstream v4.0.520
replaced the old flat `rules/*.md` layout with eleven sibling skills;
if a cited file has moved again, find its new home before assuming the
override no longer applies.

## TTS provider — do NOT default to ElevenLabs

`remotion-markup/voiceover.md` recommends ElevenLabs as the default TTS
provider. Clipwright supports four providers and the user picks one per
project (in `project.json#tts_provider`) with optional per-video
overrides (in `videos/<id>.json#recap_overrides.voice_provider`).

Resolution order at TTS time:

1. Clip-level: `script.json#clips[].voice` (provider + voice_id)
2. Video-level: `videos/<id>.json#recap_overrides` (voice_provider + voice_id)
3. Project-level: `project.json#tts_provider` + `voice_id`
4. Template default
5. Hardcoded fallback (`kokoro`, no voice)

When writing TTS code, READ the resolved provider from this chain.
Don't hardcode ElevenLabs. Don't recommend ElevenLabs to the user
unless they've asked about it. Clipwright already has `tts-segment`
(Python) that handles the resolution — prefer invoking that over
writing fresh ElevenLabs HTTP calls.

## FFmpeg — use the system binary, not `npx remotion ffmpeg`

`remotion-markup/ffmpeg.md` recommends `npx remotion ffmpeg ...`, which
uses the bundled Remotion ffmpeg. Clipwright's Python pipeline
(`src/clipwright/import_video.py`, `src/clipwright/render_segment.py`,
`src/clipwright/render_final.py`) shells out to the system `ffmpeg` /
`ffprobe` directly via `subprocess`. Keep using
`subprocess.run(["ffmpeg", ...])` for backend code. The `npx remotion
ffmpeg` form is fine for one-off frontend / Studio commands but not for
the production pipeline.

## Trimming — Clipwright's source_start / source_end map cleanly

`remotion-markup/embedding-videos.md` and
`remotion-markup/video-editing.md` cover `trimBefore` / `trimAfter` on
`<Video>`, which maps 1:1 to Clipwright's per-segment `source_start` /
`source_end` (both in source-video seconds; multiply by `fps` to get
frames). The upstream pattern works as-is — no Clipwright-specific
override needed here.

## Captions — use Clipwright's pipeline, not raw SRT

The `remotion-captions` skill covers Remotion's caption rendering
primitives (`display-captions.md`, `import-srt-captions.md`,
`transcribe-captions.md`). Clipwright produces captions via
`caption-segment` (Python), which writes per-segment JSON under
`captions/<video_id>/` with word-level timings derived from the
TTS-emitted timestamps. Use Clipwright's caption JSON as the source of
truth for caption rendering in the Remotion composition; don't generate
SRT separately, and don't run `transcribe-captions.md`'s Whisper flow,
unless the user explicitly asks for it.

## Asset paths — `sources/` and `out/`, not `public/`

Upstream assumes a stock Remotion layout with assets under `public/`.
Clipwright projects keep:

- Source media in `sources/`
- Per-segment cached renders in `out/segments/<video_id>/`
- Voiceover MP3s in `voiceover/audio/<video_id>/`
- Caption JSON in `captions/<video_id>/`
- Final assembly in `out/final/<video_id>.mp4`

When generating Remotion code, reference these paths via the Clipwright
project layout, not the upstream `public/` convention.

## Composition entry point — do NOT scaffold a new project

The `remotion-create` skill (and the router's "New project setup"
section) will offer to run `npx create-video@latest`. **Don't.**
Clipwright's composition already exists at the repo root and is already
wired into the render pipeline:

- `remotion/src/Root.tsx` — composition registry
- `remotion/remotion.config.ts` — Remotion CLI / Studio config
- `remotion/public/` — Remotion-side static assets (per-project assets
  stay in `sources/`, `voiceover/`, `captions/` and are passed in as
  composition props, not copied here)

Compositions are defined in `Root.tsx` with explicit `width`, `height`,
`fps` matching the project's `project.json#aspect` and `fps`. Reach for
`remotion-create` only when the user is explicitly starting a brand-new
Remotion project outside the Clipwright pipeline.

## Rendering — go through Clipwright, not `npx remotion render`

The `remotion-render` skill documents `npx remotion render` and Lambda
/ cloud rendering. Clipwright renders through its own Python layer
(`clipwright render-segment` per segment, then `clipwright
render-final`), which owns caching, per-segment reuse, and the audio
mux. Use those commands. Read `remotion-render` when you need to
understand a flag Clipwright passes through or debug a render failure —
not as the invocation path.

## `remotion-saas` and `remotion-interactivity` are reference-only

Clipwright is a desktop app (Tauri) driving a local render pipeline, not
a Remotion-powered SaaS, and its compositions are generated from JSON
rather than hand-edited in Studio. Load these two skills only when the
user asks a question squarely in their territory (embedding `<Player>`,
Lambda deployment, making a composition Studio-editable). Don't let
their architectural advice restructure the render pipeline.
