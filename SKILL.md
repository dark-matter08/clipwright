---
name: clipwright
description: Produce short-form how-to / demo videos from a scripted browser session OR an imported video. Drive Clipwright Studio (Tauri desktop app) or the per-segment Python CLI. Edit the on-disk JSON timeline; the app reloads from disk. Production-correctness rules are hard; creative choices are yours.
---

# Clipwright

Clipwright is two things sharing one project format:

- **Clipwright Studio** — local Tauri desktop app where a human edits a timeline.
- **Python CLI** (`clipwright …`) — the compute layer the desktop app shells out to, and the same surface Claude Code uses.

You (Claude Code) edit **JSON + asset files on disk**. The Studio watches those files and reloads its timeline whenever they change. **Never** simulate writes — always change the file. The project on disk is the single source of truth (SRS §4, §5.9).

## Principle

1. **The project is a collection of videos, not one video.** A project directory holds `project.json` + `videos/<video_id>.json` per video. Every video-scoped command takes `--video <id>` (default `main`).
2. **Two equal entry modes** (SRS §F-REC, §F-UPL):
   - **Record mode:** Claude drives Playwright via `browse-plan.json` and the recorder emits one segment per chapter.
   - **Upload mode:** the user imports an existing video and segments are derived from the transcript.
   Both modes land on the same timeline schema.
3. **Per-segment caching.** Each segment renders to `out/segments/<video_id>/<seg_id>.mp4`. Editing segment 3 invalidates only segment 3. Use `clipwright render-segment <seg_id>` for a single segment, `clipwright render-final` for the concatenation.
4. **Voice drives timing.** TTS character timestamps are the source of truth for caption alignment. Stretch audio (`atempo`) only when it's **longer** than `target_duration` — never slow it down.
5. **Think in chapters, not actions.** Each chapter narrates as one clip of 10–16s. Contiguous same-chapter actions collapse into one segment. A segment per click feels frantic; a segment per topic breathes.
6. **Dwell before cut.** Default action `wait` is **2.5s+**. Use 3–5s when a viewer must read something on screen; 1–1.5s only for true tempo beats (typing email then password).
7. **Scripts are punchy sentences with periods.** TTS pauses on periods. Use short declarative fragments. Target ~2.5 words/sec.
8. **Ask → confirm → execute → iterate.** Never spend TTS credits or run a final render until the user has confirmed the script and the outro.

## Hard rules (production correctness)

Silent failures when violated. Memorize them.

1. **Subtitles applied LAST** in the filter chain, after every overlay. Otherwise overlays hide captions.
2. **Per-segment extract → lossless concat**, not a single-pass filtergraph. Otherwise every segment double-encodes.
3. **30ms audio fades at every segment boundary** (`afade=t=in:st=0:d=0.03,afade=t=out:st={dur-0.03}:d=0.03`). Otherwise you get audible pops.
4. **Overlays use `setpts=PTS-STARTPTS+T/TB`** to align overlay frame 0 with the overlay window start.
5. **Never cut inside a word.** Snap every cut edge to a word boundary from the TTS timestamps.
6. **Word-level verbatim timestamps only.** Use the TTS provider's character-timestamp endpoint. Never a phrase-level SRT for alignment.
7. **Never slow TTS down to fit a segment.** Stretch only when audio is too long. Short narration + trailing silence beats a drawn-out delivery.

## Directory layout (v2)

```
<project>/
├── project.json                          root manifest (schema_version, title, aspect, fps)
├── videos/<video_id>.json                per-video timeline (segments[])
├── browse-plan.json                      declarative actions (record mode)
├── sources/                              project-level, shared across videos
│   ├── main.mp4                          imported video(s) or recording output
│   └── main.transcript.json              Whisper transcript (lazy)
├── voiceover/
│   ├── script.json                       per-segment text + voice config
│   └── audio/<video_id>/<seg_id>.mp3     rendered VO + .timestamps.json + .cache.json
├── captions/
│   ├── style.json                        font, size, color, position
│   └── <video_id>/<seg_id>/              PNG frames + index json
├── camera.json                           per-segment zoom/pan keyframes
├── annotations.json                      click ripples, highlights, callouts
├── brand/                                optional, from `clipwright inspire <url>`
│   ├── primary_color, logo.png, hero.png
├── scenes/<slot>/                        non-recording scenes (intro, broll, outro)
├── chat/sessions/                        Claude Code transcripts
└── out/
    ├── segments/<video_id>/<seg_id>.mp4  per-segment cached output
    └── final/<video_id>.mp4              concatenated final
```

The cache invariant: `out/segments/<video_id>/<seg_id>.mp4` exists iff its sidecar `.cache.json` matches the hash of `(source_range, target_duration, voice, captions style, camera, annotations)`. Stale segments are silently re-rendered.

## Setup

- API keys live in the OS keyring (managed by Clipwright Studio's Settings panel) **or** as env vars: `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`. Ask before writing keys.
- `ffmpeg` + `ffprobe` on PATH.
- Node ≥ 18 + `npm` (Remotion backend).
- `./install.sh` at repo root creates `.venv`, installs Clipwright, runs `playwright install chromium`, installs Remotion deps.

## CLI surface

Defaults: every video-scoped command takes `--video <id>` (default `main`) and `--project <path>` (default cwd).

### Project creation
- `clipwright init <dir>` — scaffold a new project (writes `project.json` + `browse-plan.json` skeleton).
- `clipwright record-project <dir> --plan browse-plan.json [--video <id>]` — **Record mode.** Run Playwright, capture video, emit one segment per chapter.
- `clipwright import <video.mp4> [--video <id>]` — **Upload mode.** Copy into `sources/`, transcribe (Whisper), seed segments from transcript breaks.

### Per-segment pipeline (content-hashed cache)
- `clipwright tts-segment <seg_id> --video <id>` — synthesize VO for one segment.
- `clipwright caption-segment <seg_id> --video <id>` — render caption PNGs for one segment.
- `clipwright render-segment <seg_id> --video <id> [--force]` — render one segment MP4.
- `clipwright render-final --video <id>` — concat all segments → `out/final/<video_id>.mp4`.

### Helpers (mostly v1 — still useful when working from a single browse-plan)
- `clipwright segments` — derive `segments.json` from `moments.json`.
- `clipwright keyframes` — derive `camera.json`.
- `clipwright annotations` — derive `annotations.json` from bbox-bearing moments.
- `clipwright review` — print segments + keyframes + total duration for human confirmation. (Replaces the old `edit-plan`.)
- `clipwright script init [--draft]` — write `voiceover/script.json` skeleton. With `--draft`, fills `text` heuristically from hints; segments with no hint stay empty so a human fills them.
- `clipwright inspire <url>` — extract brand color, logo, hero, copy from a URL into `brand/`.
- `clipwright outro [--preset cyberpunk|minimal]` — render branded outro card.
- `clipwright assets --gradient dark|light|<path>` — set Remotion gradient.

### Doctor / sanity
- `clipwright doctor` — preflight: Python, ffmpeg, Node, API keys, schema sync.
- `clipwright status` — list project artifacts (what exists, what's missing).

## Process

### Mode A — Record from a plan
1. **Inventory.** Read `project.json`. If missing, `clipwright init <dir>`.
2. **Plan.** Write `browse-plan.json`. Decide the 3–6 **chapters** first (e.g. Library, Reader, Share, Stats), then write 3–8 actions per chapter. Each action declares:
   - `type`: `navigate | click | type | hover | scroll | wait | key`
   - `label`: shown to you when writing copy
   - `chapter`: chapter name (contiguous same-chapter actions become one segment)
   - `wait`: seconds to dwell AFTER the action. **Default 2.5s.** Use 3–5s for moments a viewer must read. Use 1–1.5s only for rapid tempo beats.
   - `fields`: action payload (`url`, `selector`, `text`, etc.)
   Aim for each chapter's summed wait + action time ≈ 10–16s in source footage.
3. **Record.** `clipwright record-project . --plan browse-plan.json`. Verify `videos/main.json` has one segment per chapter; if you see more, a chapter label is missing on some action.
4. **Review.** `clipwright review` — show user total duration + per-segment breakdown. **Get confirmation before TTS.**
5. **Script.** `clipwright script init` writes `voiceover/script.json` with `target_seconds` and `hint` per clip. **You fill the `text` fields next.** Rules:
   - Target ~2.5 words/sec. A 12s clip ≈ 30 words.
   - **Short declarative sentences, periods for pacing.** Good: *"Your library. Unified. Fifty titles, one clean grid."* Bad: *"Your library is unified and has fifty titles in a clean grid."*
   - Fragments and imperatives are strong ("Tap. Done."). Drop filler connectives.
   - Copy must describe what the segment's moments SHOW. Use the `hint` field for grounding. Don't invent.
   - Confirm the filled script with the user before TTS.
6. **TTS per segment.** `clipwright tts-segment <seg_id>` for each clip, or loop. Audio longer than `target_duration` by >3% is time-stretched via `atempo` (pitch preserved).
7. **Captions per segment.** `clipwright caption-segment <seg_id>`.
8. **(Optional) Brand.** `clipwright inspire <url>` to pull brand color/logo/hero — activates the Remotion TitleCard + BrandedOutro scenes.
9. **(Optional) Outro.** `clipwright outro --preset <name>`.
10. **Render segments.** `clipwright render-segment <seg_id>` to validate one, then `clipwright render-final` to concat.
11. **Self-eval.** `ffprobe out/final/main.mp4` — duration ≈ sum of `target_duration` + outro ± 0.3s. Spot-check first caption frame aligns with first spoken word.

### Mode B — Edit an uploaded video
1. `clipwright init <dir>` (or open existing).
2. `clipwright import <video.mp4>` — copy into sources, transcribe, seed segments.
3. Open Clipwright Studio (or read `videos/main.json`). Trim segment ranges to match content beats.
4. Fill `voiceover/script.json` `text` fields if VO is desired (or leave VO disabled per segment).
5. Continue at step 6 above (TTS → caption → render).

### Inside Clipwright Studio (SRS §9.1 Mode B)
When the user invokes you from a segment's context menu ("Ask Claude about this clip"), you receive:
- the project's `project.json` + `videos/<video_id>.json`
- the focus segment + ±2 neighbors
- the relevant `voiceover/script.json` clip
- a transcript window around the segment's source range

**Edit the JSON file directly** (`videos/<video_id>.json` or `voiceover/script.json`). The Studio's file watcher reloads the timeline within ~200ms. Do not invoke render commands unless explicitly asked; the Studio re-renders affected segments through its own cache layer.

## Aspect ratios

`project.json` → `aspect`: `"9:16"` (default, 1080×1920), `"16:9"` (1920×1080), or `"1:1"` (1080×1080). Recorder, composer, and outro all read this value.

## Anti-patterns

- Burning subtitles into the base before overlays. Subtitles are LAST. (Rule 1.)
- Single-pass filtergraph with overlays. Per-segment extract → concat. (Rule 2.)
- Hard cuts in audio at segment boundaries. 30ms fades. (Rule 3.)
- Writing captions from estimated word durations. Use character timestamps.
- Cutting on action timestamps without padding. Pre-roll 500ms, post-roll 1s by default.
- Re-running TTS without checking credits. Costs real money — check the segment's `.cache.json` first; re-render only on real input change.
- **Editing `videos/<video_id>.json` segments by hand to mass-renumber.** Segment ids are stable. Add/remove segments via Studio actions or `segment_ops` helpers — never rewrite the id field.
- **Writing `script.json` copy from imagination.** Use the `hint` + the segment's `moments` for grounding.
- **Skipping the `review` step.** TTS costs tokens; confirm total duration first.
- **One segment per action.** Action-scoped segments cut every 1–2s and feel frantic. Group 3–8 related actions under one `chapter`.
- **Sub-2-second `wait` everywhere.** Reserve short waits for rapid-fire inputs.
- **Long compound voiceover sentences.** TTS breathes at periods.
- **Writing the plan without deciding chapters first.** Chapters are the outline; actions are the beats.
- **Camera zoom motions.** All `ZOOM_BY_TYPE` values are 1.0 — zoom feels janky, static framing wins. Don't re-introduce zoom without explicit user approval.

## Memory

If `chat/sessions/` contains prior transcripts, read the most recent one on startup and summarize the last session in one sentence before asking how to continue. Append a session note when you finish:

```markdown
## Session N — YYYY-MM-DD
**Changed:** ...
**Rendered:** out/final/<video_id>.mp4 (<duration>s)
**Outstanding:** ...
```

## SRS cross-reference

This skill implements SRS §6.5 (Claude Code integration), §F-REC (record mode), §F-UPL (upload mode), §9.1 (invocation contract), §9.2 (system prompt build). When in doubt about behaviour or invariants, read the SRS clause — that's the contract.
