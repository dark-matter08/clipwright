# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0-alpha] — 2026-05-13

### Added — schema v2: project as a collection of videos

**Breaking change to the on-disk format** (auto-migrated). A project no
longer maps 1:1 to a single deliverable. It's now a collection that
holds **N videos**, each with its own timeline + audio + captions +
render output. Use cases this unlocks:

- **Recap channels:** one project per manhwa / show, one video per
  chapter recap. Voice, aspect, brand stay shared.
- **Demo libraries:** one project per app, one video per feature.
- **Episode series:** one project per podcast/show, one video per
  episode.

New on-disk layout:

```
my-project/
├── project.json                       (schema_version: 2)
├── videos/
│   ├── chapter-1-recap.json           ← was timeline.json
│   └── chapter-2-recap.json
├── voiceover/
│   ├── audio/<video_id>/<seg>.{mp3,timestamps.json,cache.json}
│   └── scripts/<video_id>.json        ← was voiceover/script.json
├── captions/<video_id>/<seg>/...
├── chat/sessions/<video_id>/<date>.jsonl
└── out/
    ├── segments/<video_id>/<seg>.mp4
    └── final/<video_id>.mp4
```

Migration: v1 projects auto-upgrade on first `load_project`. Originals
back up to `<project>/.clipwright/v1-backup/`. Re-runs are idempotent.

CLI:
- `clipwright video list` — show every video in the project.
- `clipwright video new <id> [--title TEXT]` — create an empty video.
- `clipwright import <video> --add --video <id>` — append source to a
  specific video (B-roll) or create a new video on the fly.
- All per-segment commands gain `--video <id>` (default `main`).

Desktop:
- **Videos sidebar** on the far left of the Workspace. Click a video
  to switch the editor's focus. "+ New video" inline.
- **Add Source dialog** has two modes: append to current video (B-roll)
  or start a new video.
- **Per-video Claude chat sessions.** Switching videos switches chat
  context — each chapter / episode keeps its own conversation history.
- Top bar, status bar, render dialog, inspector, preview — all wired
  to the currently-selected video.

### Added — multi-source per video (SRS F-UPL-3)

A project can now hold N source videos per video. Use cases: B-roll over a primary track, intercut
  webcam reactions, recording a fix after the original capture.
  - `clipwright import <video> --add` appends a video to an existing
    project. Picks a unique `sources/<stem>.mp4` filename (with a
    numeric suffix on collision; non-alphanumeric chars sanitized).
    New segments append to the timeline with stable IDs; existing
    segments and `project.json` are untouched.
  - Desktop: **"+ Source" button** in the top bar opens an Add-source
    dialog with the same auto-segment / scene-detection options as
    New Project.
  - Inspector's **Trim group gets a Source picker** when a project has
    >1 source. Each segment can point at any source file in the
    project. Switching the source updates `timeline.json` atomically.
  - New Tauri commands: `add_source_cmd`, `list_sources`.

### Fixed

- **Desktop now finds `claude` and other user-installed CLIs.** macOS GUI
  apps inherit a minimal system PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
  so binaries installed via nvm, Homebrew, bun, or `~/.local/bin` were
  invisible to the Tauri process — Claude rail showed "CLI MISSING" even
  with Claude Code installed. New `path_env::enrich()` runs at app
  startup: spawns the user's login shell to read `$PATH`, then merges in
  known package-manager locations (Homebrew, nvm globbed for newest
  version, bun, cargo, `~/.claude/local/`, `~/.local/bin`).

- **Record-mode navigation no longer dies at 30 s.** `page.goto` now
  uses `wait_until="domcontentloaded"` with a 15s cap; the previously-
  unbounded `wait_for_load_state("networkidle")` is capped at 3 s and
  best-effort. Tolerant of modern apps with WebSockets, SSE,
  long-polling, analytics beacons, or hot-reload pings.

### Changed (desktop UX)

- **Preview pane fills the available space.** Was a fixed 270×480 frame
  floating in a much larger area; now uses `aspect-ratio` + `max-h/w-full`
  so the 9:16/16:9/1:1 frame scales to whatever room the workspace gives
  it. Preview column also gets a 2× flex weight relative to the inspector
  since the 9:16 aspect is canvas-tall.

- **Preview placeholder card** replaces the native broken-video glyph
  when no per-segment render exists yet. Card shows aspect + a "Click
  Render Preview" hint instead of a confusing play-button overlay.

- **Status bar doctor reflects reality.** Was hardcoded `✓`; now aggregates
  Clipwright + Claude CLI checks and renders the worst status as
  `✓ / ⚠ / ✗` with a per-check tooltip showing install paths.

### Security

- **Tighten Tauri asset-protocol scope** (SRS §20.3 P2). Previously `**`
  (any file on disk readable via `asset://`); now restricted to the file
  kinds the preview player actually streams: project sources (mp4 / mov /
  webm), cached per-segment renders, the final render, and caption PNGs.
  Any other path on disk is rejected by Tauri before reaching the
  renderer process.

### Changed

- **Project-scoped Claude sessions** (SRS §9.3). Mode A persistent chat
  now uses `claude --resume <session_id>` where the id lives in the
  project at `.clipwright/claude-session`. Replaces `claude --continue`,
  which resumed the most recent session in `cwd` and bled chats across
  projects opened from the same shell. Sessions are also serialized via
  `--output-format json` so the assistant reply and the session id are
  recoverable as one structured payload. Atomic writes (tmp + rename) on
  the session file so a crash mid-write can't poison Mode A.

## [0.1.0-alpha] — 2026-05-13

The first release of **Clipwright Studio** — a Tauri desktop app that wraps
the existing Python CLI in a real editor and pairs every segment with a
Claude Code agent. See [SRS.md](./SRS.md) for the full product spec and
[desktop/](./desktop/) for the source.

### Added — v1 project schema

- `clipwright.schema` module with versioned dataclasses, atomic JSON I/O
  (tmp + rename), and forward-version rejection. Project state is now a
  plain directory of `project.json` + `timeline.json` + sibling files.
  See SRS §5.

### Added — per-segment Python pipeline

Every editing operation is its own CLI command, content-hash-cached via a
sidecar `.cache.json`, idempotent on unchanged inputs:

- `clipwright import <video>` — Upload mode. Copies the source, runs
  silence + scene detection, seeds the timeline.
- `clipwright record-project <dir>` — Record mode. Drives Playwright per
  `browse-plan.json`, produces a chaptered timeline.
- `clipwright tts-segment <seg_id>` — synthesize the voiceover for one
  segment; stretch to `target_seconds`.
- `clipwright caption-segment <seg_id>` — chunk timestamps into 2-word
  UPPERCASE PNG frames in the new layout.
- `clipwright render-segment <seg_id>` — render one segment's MP4,
  honoring SKILL.md's hard correctness rules (subs LAST, per-segment
  extract, 30 ms boundary fades).
- `clipwright render-final` — concat every segment into `out/final.mp4`,
  re-rendering only what's stale.
- `clipwright agent prompt [<seg_id>]` — build the Mode A / Mode B
  system prompt for a Claude Code invocation.

### Added — Clipwright Studio desktop app

A Tauri 2 + React + TypeScript + Tailwind + Zustand stack. Local-first
project editor with:

- **Project Hub** with recents + folder picker + a New Project wizard
  exposing both Record and Upload modes equally.
- **Workspace** with a preview pane, accordion inspector, segment
  timeline, collapsible Claude rail, and status bar — laid out per
  SRS §8.5.
- **Timeline editing:** split / delete / duplicate / merge / move via
  context menu or keyboard (`⌘B`, `⌘D`, `⌫`, `⌘←/→`), 50-step undo/redo
  (`⌘Z` / `⇧⌘Z`), `⌘+ / ⌘- / ⌘0` zoom, atomic persistence on every
  mutation.
- **Inspector accordion** with five groups: Voiceover (text editor +
  voice config + regenerate), Captions (toggle + regenerate), Camera
  + Annotations (toggle), Trim (numeric inputs).
- **Preview player** that streams the per-segment cached MP4 via the
  Tauri asset protocol.
- **Claude integration:** Mode A persistent chat using the user's own
  `claude` CLI with `--continue`; Mode B per-segment Ask-Claude
  triggered from the timeline context menu. Both modes pipe the
  `clipwright agent prompt` output via `--append-system-prompt`. Chat
  history is persisted to `chat/sessions/<date>.jsonl`.
- **Render dialog** wired to `clipwright render-final`.

### Documentation

- [SRS.md](./SRS.md) — full software requirements specification
  (vision, goals, architecture, data model, functional reqs, UI spec,
  Claude integration, testing/security/distribution policy).
- README updated with a Clipwright Studio pointer.

### Security

- All Tauri-channel `seg_id` arguments validated against
  `^seg_[a-z0-9]+$` at the Rust boundary, mirroring the Python schema
  invariant.
- Claude subprocess invocations use the `--` separator before any
  user-controlled message string.
- API keys are read from environment variables inside the Python
  providers; the desktop never touches them.
- All schema JSON writes are atomic (tmp + rename) — crashes can't
  leave a partial file on disk.

### Tests

- 199 Python tests (101 schema + 98 per-segment + agent prompt).
- 3 Rust unit tests for the seg_id validation boundary.
- Frontend smoke-tested end-to-end via `bun run tauri:dev` against a
  generated test project. Vitest + Playwright scaffolding lands in P2
  per SRS §18.2.

### Known gaps

These are deferred to P2, per the SRS:

- Drag-edge trim with word-boundary snap (needs transcript integration).
- Drag-to-reorder via mouse (keyboard `⌘←/⌘→` covers the use case).
- Per-keyframe Camera editor and per-overlay Annotation editor.
- `vibevoice` backend (schema reserved for it, no module yet).
- Tightened Tauri asset-protocol scope (currently `**`, should narrow
  to the open project + `~/.clipwright/`).
- Vitest + Playwright frontend test scaffolding.
