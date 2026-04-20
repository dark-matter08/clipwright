# Clipwright

Clipwright turns a scripted browser session into a short-form how-to video:
record, trim dead time, add voiceover with character-accurate captions, brand
it with an outro, and render a vertical (or 16:9 / 1:1) MP4.

It exists as two things in one repository:

- A standalone Python CLI (`clipwright ...`)
- A [Claude Code](https://docs.claude.com/en/docs/claude-code) skill (see
  [`SKILL.md`](./SKILL.md)) so an agent can drive the whole pipeline

Clipwright was extracted from a real production pipeline built for
[Vertex Reader](https://vertexreader.site) and then generalized. The browser
recorder is Playwright-based; captions are PIL-generated transparent PNG
overlays composited with ffmpeg (no libass required); voiceover uses
ElevenLabs' character-level `with-timestamps` endpoint.

## Features

- Browser recorder (Playwright Chromium) producing `video.mp4` + an
  action-annotated `moments.json`
- Dead-time trimming driven by the action log (pre-roll, post-roll, gap merge,
  gap split)
- Per-segment extract -> lossless concat -> subtitle overlay LAST render pipeline
- ElevenLabs TTS with `with-timestamps` alignment
- 2-word UPPERCASE caption chunking with word-boundary snapping
- Transparent PNG subtitle overlays (works on any ffmpeg build)
- PIL-rendered branded outro card with cyberpunk / minimal presets
- Vertical 1080x1920 by default; `--aspect 16:9` and `--aspect 1:1` supported

## Install

Requires Python 3.10+, ffmpeg/ffprobe on PATH, and a POSIX shell.

```
git clone https://github.com/DarkMatter/clipwright
cd clipwright
./install.sh
```

Or manually:

```
python -m venv .venv && source .venv/bin/activate
pip install -e .
playwright install chromium
```

`uv` users:

```
uv venv && source .venv/bin/activate
uv pip install -e .
uv run playwright install chromium
```

## Quickstart

```
clipwright init my-demo
cd my-demo
# edit demo.py and script.json

clipwright record demo.py
clipwright trim
clipwright tts script.json
clipwright caption
clipwright outro --preset cyberpunk
clipwright render
```

Output: `out/final.mp4`.

## Configuration

Each project has a `.clipwright.json` at its root. See
[`examples/hello-world/.clipwright.json`](./examples/hello-world/.clipwright.json).

Environment:

- `ELEVENLABS_API_KEY` for the TTS step

## Using Clipwright with Claude Code

Drop this repository into your project and point Claude Code at
[`SKILL.md`](./SKILL.md). The skill teaches the agent the pipeline, the
production-correctness rules, and the CLI surface.

## License

MIT. See [`LICENSE`](./LICENSE).
