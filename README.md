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
overlays composited with ffmpeg (no libass required); voiceover runs through
a pluggable TTS backend — **Kokoro** (Apache-2.0, near-human, default),
**Piper** (MIT, tiny, offline forever), or **ElevenLabs** (paid, highest
quality) — all emitting the same character-level alignment format.

## Features

- Browser recorder (Playwright Chromium) producing `video.mp4` + an
  action-annotated `moments.json`
- Dead-time trimming driven by the action log (pre-roll, post-roll, gap merge,
  gap split)
- Per-segment extract -> lossless concat -> subtitle overlay LAST render pipeline
- Pluggable TTS: Kokoro (default, free, Apache-2.0), Piper (free, MIT, offline), or ElevenLabs (paid)
- 2-word UPPERCASE caption chunking with word-boundary snapping
- Transparent PNG subtitle overlays (works on any ffmpeg build)
- PIL-rendered branded outro card with cyberpunk / minimal presets
- Vertical 1080x1920 by default; `--aspect 16:9` and `--aspect 1:1` supported

## Install

Requires:

- Python 3.10-3.12 (ML-based TTS backends lack wheels for 3.13+)
- `ffmpeg` / `ffprobe` on PATH
- Node.js ≥ 18 with `npm` (for the Remotion render backend)
- A POSIX shell

```
git clone https://github.com/dark-matter08/clipwright
cd clipwright
./install.sh
```

`install.sh` auto-discovers a usable Python (tries `python3.12`, `3.11`, `3.10`
on `PATH`, plus common Homebrew paths) — you don't need to set `PYTHON=` unless
you want to pin a specific one. It also:

- Creates `.venv` and installs the package in editable mode
- Runs `playwright install chromium`
- Fetches DejaVu fonts for caption rendering
- Installs Remotion backend deps (`remotion/node_modules`) — fails loudly if
  `npm install` errors; missing Node ≥ 18 fails upfront before anything else
  runs
- Generates default gradient backgrounds for the Remotion backend
- Installs Remotion's official [agent skill](https://www.remotion.dev/docs/ai/skills)
  into `~/.claude/skills/remotion` so Claude Code has Remotion-specific
  context when editing `remotion/**`. Pin with
  `CLIPWRIGHT_REMOTION_SKILL_REF=<sha|tag>`, skip with `./install.sh --no-skill`.
  `clipwright init` also installs a project-local copy at
  `<project>/.claude/skills/remotion`. Re-running the installer is a no-op when
  already up to date.

### Making `clipwright` available in new terminals

After install, the `clipwright` binary lives in `./.venv/bin/clipwright`. Either:

**Activate the venv** (simple, per-shell):

```
source .venv/bin/activate
```

**Or symlink it onto your PATH** (works in any new terminal):

```
ln -sfn "$PWD/.venv/bin/clipwright" /opt/homebrew/bin/clipwright
# or ~/.local/bin/clipwright if that's on your PATH
```

## Quickstart

The pipeline is declarative: you describe a browser flow in `browse-plan.json`,
Clipwright records it with annotated action moments, then builds segments,
camera keyframes, an edit-plan, a script skeleton (copy filled in separately),
TTS with timing-aware stretch, captions, optional outro, and renders.

```
clipwright init my-demo
cd my-demo
# edit browse-plan.json — list of navigate/click/type/hover/scroll/wait actions

clipwright record --plan browse-plan.json
clipwright segments
clipwright keyframes
clipwright edit-plan           # human/agent review checkpoint
clipwright script init         # writes script.json skeleton (empty text)
# fill in script.json "text" fields (Claude Code skill does this)

clipwright tts script.json
clipwright caption
clipwright outro --preset cyberpunk
clipwright render --backend remotion   # or --backend ffmpeg
```

Output: `out/final.mp4`.

### Render backends

- `--backend ffmpeg` — classic PNG-overlay compositor, no Node required
- `--backend remotion` — React-based renderer with animated camera zoom/focus,
  gradient backgrounds, and re-rendered captions. Requires `./install.sh` to
  have set up `remotion/node_modules`.

Pick a gradient background for the Remotion backend:

```
clipwright assets --gradient dark       # default
clipwright assets --gradient light
clipwright assets --gradient ./my.jpg
```

## Configuration

Each project has a `.clipwright.json` at its root. See
[`examples/hello-world/.clipwright.json`](./examples/hello-world/.clipwright.json).

### TTS providers

Select the voice engine via `tts_provider` in `.clipwright.json` or
`clipwright tts --provider <name>`:

| Provider | License | Cost | Quality | Install |
|---|---|---|---|---|
| `kokoro` *(default)* | Apache-2.0 | Free | Near-human | `pip install 'clipwright[kokoro]'` (~2 GB incl. PyTorch) |
| `piper` | MIT | Free, offline | Natural | `pip install 'clipwright[piper]'` (~200 MB incl. faster-whisper) |
| `elevenlabs` | Proprietary API | Free tier + paid | Highest | Requires `ELEVENLABS_API_KEY` |

Piper has no native word timestamps, so the backend forced-aligns its own
output with a small `faster-whisper` model (tiny.en, ~39 MB). Kokoro emits
token timings natively. All three providers write the same alignment shape
downstream.

### Environment

- `ELEVENLABS_API_KEY` — required only when `tts_provider = "elevenlabs"`

## Using Clipwright with Claude Code

Clipwright ships with a [`SKILL.md`](./SKILL.md) that teaches the agent the
full pipeline, the production-correctness rules, and the CLI surface. The
script copy (the `text` fields in `script.json`) is written by the Claude
Code runtime — the CLI only emits a skeleton.

Register it as a user-level skill so it's available in any project:

```
mkdir -p ~/.claude/skills
ln -sfn "$PWD" ~/.claude/skills/clipwright
```

Then in Claude Code, invoke `/clipwright` (or ask the agent to turn a flow
into a how-to video) from any working directory.

## License

MIT. See [`LICENSE`](./LICENSE).
