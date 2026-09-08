# Clipwright Studio

A desktop editor for short-form video, with Claude Code living in the rail
next to your timeline.

You import a video or record a browser session, and Clipwright gives you a
segment-based timeline, per-segment voiceover with character-accurate
captions, and a render pipeline that only rebuilds what changed. Claude sits
beside all of it with full context on the project — the timeline, the script,
the transcript — so you can say "tighten the third beat" instead of hunting
for the right JSON field.

The project is a directory of JSON and media on disk. You can `git commit` a
video and regenerate it when the product changes.

```
Clipwright Studio (Tauri + React)  ← the app you use
        │
        ├── clipwright (Python)    ← the engine: TTS, captions, render, cache
        ├── Remotion                ← React compositions for panel/recap renders
        └── Claude Code             ← the agent in the rail, driving both
```

## Install

Requires:

- Python 3.10–3.12 (the ML TTS backends have no wheels for 3.13+)
- `ffmpeg` / `ffprobe` on PATH
- Node.js ≥ 18
- [pnpm](https://pnpm.io) (for the desktop app)
- [Claude Code](https://docs.claude.com/en/docs/claude-code) on PATH, for the rail

```bash
git clone https://github.com/dark-matter08/clipwright
cd clipwright
./install.sh
```

`install.sh` finds a usable Python (tries `python3.12`, `3.11`, `3.10` plus the
common Homebrew paths — set `PYTHON=` only to pin one), creates `.venv`,
installs the engine in editable mode, runs `playwright install chromium`,
fetches the DejaVu fonts used for caption rendering, and installs the Remotion
dependencies.

Then start the app — from the repo root, no subdirectory:

```bash
pnpm install         # first time only
pnpm dev
```

`pnpm build` produces a bundled application.

## Using it

**New project.** Import a video (copied into `sources/`, transcribed with
Whisper, segmented at transcript breaks) or record a browser session from a
declarative `browse-plan.json` of Playwright actions. Pick one or more
[templates](engine/clipwright/templates/data) — they carry the editorial
guidance Claude follows for that kind of video.

**Persona.** The `Persona` button opens a panel where you describe who Claude
*is* when it writes for this project — identity, voice, structural rules,
vocabulary to prefer and ban, pacing, and the failure mode to avoid. Every
video in the project inherits it; individual videos can opt out. This is the
single biggest lever on how the output reads.

**Timeline + Inspector.** Segments carry a source range, a target duration, a
voiceover clip, captions, and camera keyframes. Edit them directly, or
right-click a segment to ask Claude about just that one.

**Claude rail.** A persistent chat scoped to the current video, with the
project's state in its system prompt. It edits the JSON on disk; the app
reloads from disk, so you both work on the same files.

**Render.** Per-segment renders are content-hashed and cached, so changing
segment three rebuilds segment three. The final concat lands at
`out/final/<video_id>.mp4` and the Preview pane picks it up.

## What a project looks like on disk

```
my-project/
├── project.json                  title, aspect, fps, TTS provider, templates
├── videos/<id>.json              the timeline: segments, per-video overrides
├── sources/                      source media (recordings, panels, imports)
├── voiceover/
│   ├── scripts/<id>.json         one clip per segment — the words
│   └── audio/<id>/               synthesized mp3 + character-level timings
├── captions/<id>/                per-segment caption PNGs + index
├── camera/<seg_id>.json          zoom/pan keyframes
├── out/
│   ├── segments/<id>/            per-segment cached renders
│   └── final/<id>.mp4            the deliverable
└── .clipwright/                  recap config, persona, Claude session state
```

## The engine (CLI)

The app shells out to these; you can also run them directly. Every per-video
command takes `--video <id>`.

| Command | Does |
|---|---|
| `clipwright import <video.mp4>` | Import a video as a new project or video |
| `clipwright record-project <dir> --plan browse-plan.json` | Record a Playwright session into segments |
| `clipwright tts-segment <seg_id>` | Synthesize voiceover for one segment |
| `clipwright caption-segment <seg_id>` | Render caption PNGs for one segment |
| `clipwright render-segment <seg_id>` | Render one segment mp4 |
| `clipwright render-final` | Concat every segment into the final mp4 |
| `clipwright status` | Per-video artifact state — what's built |
| `clipwright video doctor <id>` | What's wrong — missing sources, stale renders |
| `clipwright doctor` | Preflight: tools, Python version, API keys, config |
| `clipwright templates list` | Show available project templates |
| `clipwright tts-sample --provider <p> --voice <v>` | Audition a voice — prints a playable mp3 path |
| `clipwright agent prompt` | Print the system prompt Claude receives |

### TTS providers

Set per project in `project.json#tts_provider`, overridable per video and per
clip.

| Provider | License | Cost | Quality | Install |
|---|---|---|---|---|
| `kokoro` *(default)* | Apache-2.0 | Free | Near-human | `pip install 'clipwright[kokoro]'` (~2 GB, includes PyTorch) |
| `piper` | MIT | Free, offline | Natural | `pip install 'clipwright[piper]'` (~200 MB, includes faster-whisper) |
| `openai` | Proprietary API | Paid | High | `pip install 'clipwright[openai]'`, needs an OpenAI key |
| `elevenlabs` | Proprietary API | Free tier + paid | Highest | Needs `ELEVENLABS_API_KEY` |

Captions need character-level timings, and only ElevenLabs returns them.
Kokoro emits token timings natively; Piper and OpenAI return audio alone, so
their output is force-aligned with a small `faster-whisper` model (tiny.en,
~39 MB) — that's what the extra installs. All providers write the same
alignment shape downstream.

**Auditioning voices.** A voice name tells you nothing about how it sounds, so
every voice picker has a Preview button that synthesizes one line and plays it
inline. Samples are cached per provider+voice, so re-auditioning is free and
doesn't re-bill a paid API. From the CLI: `clipwright tts-sample --provider
openai --voice onyx` prints a playable mp3 path.

## Claude Code integration

The rail invokes `claude --print` under the project directory with a system
prompt built from live project state (`clipwright agent prompt`). Two vendored
skill sets ship with the repo so any contributor's rail picks them up:

- [`SKILL.md`](./SKILL.md) — the Clipwright pipeline, its file formats, and the
  production-correctness rules (subtitles last, per-segment extract, 30 ms
  fades, word-boundary cuts).
- [`.claude/skills/remotion-*`](./.claude/skills) — the Remotion team's twelve
  agent skills, pinned at a known revision, with Clipwright's overrides in
  `remotion-best-practices/CLIPWRIGHT_NOTES.md`.

## Docs

- [`SRS.md`](./SRS.md) — the product spec: architecture, data model, UI, and
  the Claude integration contract
- [`DESIGN.md`](./DESIGN.md) — the design system Clipwright Studio is built on
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup and the DCO sign-off
- [`CHANGELOG.md`](./CHANGELOG.md)

Clipwright was extracted from a production pipeline built for
[Vertex Reader](https://vertexreader.site) and then generalized.

## License

MIT. See [`LICENSE`](./LICENSE).
