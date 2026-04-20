---
name: clipwright
description: Produce short-form how-to / demo videos from a scripted browser session. Record with Playwright, trim dead time, synthesize voiceover with ElevenLabs, burn 2-word UPPERCASE captions, and render a vertical (or 16:9 / 1:1) MP4 with a branded outro. Production-correctness rules are hard; creative choices are yours.
---

# Clipwright

## Principle

1. **One artifact per stage.** `video.mp4` + `moments.json` -> trimmed EDL -> voiceover + timestamps -> caption PNGs -> composed vertical -> final MP4. Each stage writes a file the next stage reads.
2. **Voice drives timing.** ElevenLabs/Kokoro character timestamps are the source of truth for caption alignment. Trim against the action log, not the speech.
3. **Think in chapters, not actions.** A demo is 3–6 **topic chapters** (Library, Reader, Share, Stats...), each narrated as one clip of 10–16s. Every action in `browse-plan.json` MUST declare a `chapter` — contiguous same-chapter actions collapse into one segment. A segment per click produces jittery cuts; a segment per topic breathes.
4. **Dwell before cut.** Viewers need time to register each action. Default action `wait` is **2.5s+** (not 1s). A topic chapter plays for 10–16s of source footage; the final clip is that footage stretched/cropped to match a 10–16s voiceover.
5. **Scripts are punchy sentences with periods.** Kokoro and ElevenLabs pause on periods — use short declarative fragments (e.g. "Your library. Unified. Add any source in seconds.") instead of long compound sentences. Target ~2.5 words/sec.
6. **Ask -> confirm -> execute -> iterate.** Never render the final until the user has confirmed the script and the outro.
7. **Don't assume aesthetics.** Cyberpunk is the default template, not a mandate. Ask, confirm, theme.

## Hard rules (production correctness)

These produce silent failures when violated. Memorize them.

1. **Subtitles are applied LAST** in the filter chain, after every overlay. Otherwise overlays hide captions.
2. **Per-segment extract -> lossless concat**, not a single-pass filtergraph. Otherwise every segment double-encodes when overlays are added.
3. **30ms audio fades at every segment boundary** (`afade=t=in:st=0:d=0.03,afade=t=out:st={dur-0.03}:d=0.03`). Otherwise you get audible pops.
4. **Overlays use `setpts=PTS-STARTPTS+T/TB`** to align overlay frame 0 with the overlay window start.
5. **Never cut inside a word.** Snap every cut edge to a word boundary from the TTS timestamps.
6. **Word-level verbatim timestamps only.** Use the ElevenLabs `/with-timestamps` endpoint. Never a phrase-level SRT for alignment.

## Directory layout

One project directory per video. Outputs go in `<project>/out/`.

```
<project>/
├── .clipwright.json        project config
├── browse-plan.json        declarative actions (preferred over demo.py)
├── demo.py                 (optional) Playwright user script — legacy path
├── script.json             voiceover (filled by Claude from the skeleton)
└── out/
    ├── video.mp4           raw recording
    ├── moments.json        timestamped action log (one per plan action)
    ├── segments.json       kept ranges + per-segment moment metadata
    ├── camera.json         output-timeline keyframes per action zoom
    ├── audio/<beat>.mp3    TTS per beat (stretched to target_seconds)
    ├── audio/<beat>.timestamps.json
    ├── subs/<beat>/NNN.png caption frames
    ├── subs/<beat>.json    caption index
    ├── outro.mp4           branded card
    └── final.mp4
```

## Setup

- `ELEVENLABS_API_KEY` in `.env` at project root. Ask and write `.env` if missing.
- `ffmpeg` + `ffprobe` on PATH.
- `./install.sh` at repo root (creates `.venv`, installs Clipwright, runs `playwright install chromium`).

## CLI

All subcommands read `.clipwright.json` by default. Flags override.

- `clipwright init <dir>` — scaffold a new project.
- `clipwright record --plan browse-plan.json` — execute a declarative plan (preferred).
  Legacy: `clipwright record [demo.py]` runs a user script.
- `clipwright segments` — from `moments.json`, emit `out/segments.json` (with per-segment moments).
- `clipwright keyframes` — from `segments.json`, emit `out/camera.json` (output-timeline camera).
- `clipwright edit-plan` — print segments + keyframes + total duration for review.
- `clipwright script init` — write a `script.json` skeleton (one clip per segment, empty text).
- `clipwright tts` — synthesize voiceover per clip, stretching audio to `target_seconds`.
- `clipwright caption` — chunk timestamps into 2-word UPPERCASE frames, render PNGs.
- `clipwright outro [--preset cyberpunk|minimal]` — render branded outro card.
- `clipwright render` — compose vertical, mix audio, overlay captions LAST, concat outro.
- `clipwright trim` — legacy: flat `edl.json` of kept ranges. Prefer `segments`.

## Process

1. **Inventory.** Read `.clipwright.json`. If missing, run `clipwright init`.
2. **Plan.** Write `browse-plan.json`. Decide the 3–6 **chapters** first (e.g.
   Library, Reader, Share, Stats), then write 3–8 actions per chapter. Each
   action declares:
   - `type`: `navigate | click | type | hover | scroll | wait | key`
   - `label`: shown to Claude when writing copy
   - `chapter`: chapter name — contiguous same-chapter actions become one segment
   - `wait`: seconds to dwell AFTER the action. **Default 2.5s.** Use 3–5s for
     moments a viewer must read (search results, reader settings toggles). Use
     1–1.5s only for true tempo beats (password field after email field).
   Aim for each chapter's summed `wait` + action time ≈ 10–16s in the source
   recording — that's the window the voiceover will cover.
3. **Record.** `clipwright record --plan browse-plan.json`. Verify
   `moments.json` has one entry per action (each carries its `chapter`).
4. **Segments.** `clipwright segments`. With chapters declared you should get
   exactly one segment per chapter. If you see more, a chapter label is
   missing on some action.
5. **Keyframes.** `clipwright keyframes`. Zoom patterns per action type:
   navigate/scroll 1.0 (flat), click/hover 1.0 → 1.5 → 1.0, type 1.0 → 2.0 → 1.0.
6. **Edit plan.** `clipwright edit-plan` — show the user total duration + per-segment
   breakdown. Get confirmation before spending TTS tokens.
7. **Script skeleton.** `clipwright script init` writes `script.json` with
   `target_seconds` and `hint` per clip. **You (Claude Code) fill the `text`
   fields next.** Rules for writing copy:
   - Target ~2.5 words/second. A 12-second clip ≈ 30 words.
   - **Short declarative sentences, periods for pacing.** TTS pauses on every
     period — lean on that. Good: *"Your library. Unified. Fifty titles, one
     clean grid."* Bad: *"Your library is unified and has fifty titles in a
     clean grid."* The first reads natural; the second reads like a run-on.
   - Fragments are fine. Imperatives are strong ("Tap. Done."). Drop filler
     connectives ("and", "so", "then") — let the period do the work.
   - Each clip's copy must describe what that segment's moments SHOW. The `hint`
     field lists the moments — use it verbatim for grounding. Don't invent.
   - Confirm the filled `script.json` with the user before TTS.
8. **TTS.** `clipwright tts`. Audio longer than `target_seconds` by >3% is
   time-stretched via `atempo` (pitch preserved). Timestamps are rescaled.
9. **Caption.** `clipwright caption`. Spot-check a PNG.
10. **Outro.** `clipwright outro --preset <name>`.
11. **Render.** `clipwright render`. Per-segment extract → concat → subtitles LAST.
12. **Self-eval.** `ffprobe out/final.mp4` — duration ≈ sum of `target_seconds` +
    outro ± 0.3s. Spot-check first caption frame aligns with first spoken word.

## Aspect ratios

`.clipwright.json` → `aspect`: `"9:16"` (default, 1080x1920), `"16:9"` (1920x1080),
or `"1:1"` (1080x1080). Recorder, composer, and outro all read this value.

## Anti-patterns

- Burning subtitles into the base before overlays. Subtitles are LAST. (Rule 1.)
- Single-pass filtergraph with overlays. Per-segment extract -> concat. (Rule 2.)
- Hard cuts in audio at segment boundaries. 30ms fades. (Rule 3.)
- Writing captions from estimated word durations. Use ElevenLabs character timestamps.
- Cutting on action timestamps without padding. Pre-roll 500ms, post-roll 1s by default.
- Re-running `clipwright tts` without checking `.env`. Costs real money.
- Hard-coding Vertex Reader strings in the outro. Use `BrandConfig` / the templates.
- Writing `script.json` copy from imagination. Use the `hint` + `segments.json` moments — voiceover must describe what the viewer sees in that segment.
- Skipping the `edit-plan` review. TTS costs tokens; confirm total duration first.
- Editing `moments.json` by hand. Re-record with an adjusted `browse-plan.json` instead.
- **One segment per action.** Action-scoped segments cut every 1–2s and feel frantic. Group 3–8 related actions under one `chapter`.
- **Sub-2-second `wait` everywhere.** A 1s wait after a click is too fast for the viewer to see what changed. Reserve short waits for rapid-fire inputs (typing email then password).
- **Long compound voiceover sentences.** TTS breathes at periods. `"Your library is unified, with fifty titles in one clean grid."` reads flat; `"Your library. Unified. Fifty titles, one clean grid."` reads like an ad.
- **Writing the plan without deciding chapters first.** Chapters are the outline; actions are the beats. Outline before you beat.

## Memory

If a `out/project.md` exists, read it on startup and summarize the last session in one sentence before asking how to continue. Append one section per session:

```markdown
## Session N — YYYY-MM-DD
**Changed:** ...
**Rendered:** out/final.mp4 (<duration>s)
**Outstanding:** ...
```
