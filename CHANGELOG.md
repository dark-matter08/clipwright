# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
