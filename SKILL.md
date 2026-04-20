---
name: clipwright
description: Produce short-form how-to / demo videos from a scripted browser session. Record with Playwright, trim dead time, synthesize voiceover with ElevenLabs, burn 2-word UPPERCASE captions, and render a vertical (or 16:9 / 1:1) MP4 with a branded outro. Production-correctness rules are hard; creative choices are yours.
---

# Clipwright

## Principle

1. **One artifact per stage.** `video.mp4` + `moments.json` -> trimmed EDL -> voiceover + timestamps -> caption PNGs -> composed vertical -> final MP4. Each stage writes a file the next stage reads.
2. **Voice drives timing.** ElevenLabs character timestamps are the source of truth for caption alignment. Trim against the action log, not the speech.
3. **Ask -> confirm -> execute -> iterate.** Never render the final until the user has confirmed the script and the outro.
4. **Don't assume aesthetics.** Cyberpunk is the default template, not a mandate. Ask, confirm, theme.

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
├── demo.py                 Playwright user script (async def run(page))
├── script.json             voiceover script (title + beats)
└── out/
    ├── video.mp4           raw recording
    ├── moments.json        timestamped action log
    ├── edl.json            kept ranges after trim
    ├── audio/<beat>.mp3    ElevenLabs TTS per beat
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

- `clipwright init <dir>` — scaffold a new project (config, demo.py, script.json).
- `clipwright record [demo.py]` — run the Playwright script, produce `out/video.mp4` + `out/moments.json`.
- `clipwright trim` — from `moments.json`, emit `out/edl.json` of kept ranges.
- `clipwright tts [script.json]` — synthesize voiceover per beat, write mp3 + timestamps.
- `clipwright caption` — chunk timestamps into 2-word UPPERCASE frames, render PNGs.
- `clipwright outro [--preset cyberpunk|minimal]` — render branded outro card.
- `clipwright render` — compose vertical, mix audio, overlay captions LAST, concat outro.

## Process

1. **Inventory.** Read `.clipwright.json`. If missing, run `clipwright init`.
2. **Record.** Run `clipwright record`. Verify `video.mp4` exists and `moments.json` has ≥ 3 actions.
3. **Trim.** Run `clipwright trim`. Inspect `edl.json` — each range should contain at least one action.
4. **Script.** Confirm the voiceover script with the user before synthesizing. TTS costs tokens; measure twice.
5. **TTS.** Run `clipwright tts`. Verify each beat's duration is within 10% of the kept range it fills.
6. **Caption.** Run `clipwright caption`. Sample a random PNG and confirm legibility.
7. **Outro.** `clipwright outro` — confirm brand strings and palette before rendering.
8. **Render.** `clipwright render`. Runs per-segment extract -> concat -> subtitles LAST.
9. **Self-eval.** `ffprobe out/final.mp4` — duration should be `sum(edl ranges) + outro_duration ± 0.3s`. Spot-check the first caption frame for alignment with the spoken word.

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

## Memory

If a `out/project.md` exists, read it on startup and summarize the last session in one sentence before asking how to continue. Append one section per session:

```markdown
## Session N — YYYY-MM-DD
**Changed:** ...
**Rendered:** out/final.mp4 (<duration>s)
**Outstanding:** ...
```
