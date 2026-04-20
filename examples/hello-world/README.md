# hello-world

Minimal Clipwright demo: navigate `example.com`, read two short voiceover beats,
render a vertical MP4 with captions and an outro card.

## Run

```
export ELEVENLABS_API_KEY=...
clipwright record
clipwright trim
clipwright tts
clipwright caption
clipwright outro --preset cyberpunk
clipwright render
```

Output: `out/final.mp4`.

## What each command does

- `record` — Playwright Chromium runs `demo.py`, writes `out/video.mp4` + `out/moments.json`.
- `trim` — converts `moments.json` into `out/edl.json` (kept time ranges).
- `tts` — ElevenLabs synthesizes each beat in `script.json` into `out/audio/<id>.mp3` + character timestamps.
- `caption` — chunks timestamps into 2-word UPPERCASE frames and writes PNGs under `out/subs/<id>/`.
- `outro` — renders `out/outro.mp4` from the cyberpunk template.
- `render` — composes each segment (blurred backdrop + centered source), overlays captions LAST, concats with the outro.
