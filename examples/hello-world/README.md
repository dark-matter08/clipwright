# hello-world

Minimal Clipwright demo: navigate `example.com`, read two short voiceover beats,
render a vertical MP4 with captions and an outro card.

## Quickstart (one command)

```
# Edit script.json to fill in the "text" fields first, then:
clipwright build --yes
```

Output: `out/final.mp4`.

## Step-by-step (power-user)

```
clipwright record --plan browse-plan.json
clipwright segments
clipwright keyframes
clipwright review                    # inspect segments + total duration
# fill script.json "text" fields (or run: clipwright script init --draft)
clipwright tts
clipwright caption
clipwright outro --preset cyberpunk
clipwright render --backend remotion
```

## What each command does

- `record --plan` — Playwright Chromium executes `browse-plan.json`, writes `out/video.mp4` + `out/moments.json`.
- `segments` — groups moments by chapter into `out/segments.json` (replaces legacy `trim`).
- `keyframes` — builds output-timeline camera keyframes → `out/camera.json`.
- `review` — prints the segment breakdown and total duration for confirmation before TTS spend.
- `script init` — writes a `script.json` skeleton with one clip per segment. Add `--draft` to auto-fill copy from action hints.
- `tts` — synthesizes each clip in `script.json` → `out/audio/<id>.mp3` + character timestamps. Subsequent runs cache unchanged clips.
- `caption` — chunks timestamps into 2-word UPPERCASE frames → PNGs under `out/subs/<id>/`. Subsequent runs cache unchanged clips.
- `outro` — renders `out/outro.mp4` from the cyberpunk template.
- `render` — composes each segment (blurred backdrop + centered source), overlays captions LAST, concats outro → `out/final.mp4`.
