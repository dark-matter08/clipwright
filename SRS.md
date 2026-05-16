# Clipwright Studio — Software Requirements Specification

**Status:** Draft v2 · 2026-05-12
**Owner:** lucien
**Purpose of this document:** Anchor the project to a single product definition and a phased MVP plan. It replaces ad-hoc direction with a contract between (a) the desktop app, (b) the Python compute layer, and (c) Claude Code as the AI agent. Every feature decision below should be testable against the Goals and Non-Goals in §2.

## Contents

1. [Vision](#1-vision)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Users & Primary Journeys](#3-users--primary-journeys)
4. [System Architecture](#4-system-architecture)
5. [Data Model](#5-data-model)
6. [Functional Requirements](#6-functional-requirements)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [UI Specification](#8-ui-specification) — *includes IA, design principles, all screens, keyboard map*
9. [Claude Code Integration Specification](#9-claude-code-integration-specification)
10. [Reuse Map](#10-reuse-map-what-carries-over-from-current-code)
11. [Migration Plan](#11-migration-plan-from-todays-code-to-mvp)
12. [Phased Delivery Summary](#12-phased-delivery-summary)
13. [Open Questions](#13-open-questions--decisions-needed)
14. [Risks](#14-risks--mitigations)
15. [Success Metrics](#15-success-metrics-post-mvp)
16. [Telemetry & Privacy](#16-telemetry--privacy)
17. [Build, Distribution & Update](#17-build-distribution--update)
18. [Testing Strategy](#18-testing-strategy)
19. [Logging & Observability](#19-logging--observability)
20. [Security Model](#20-security-model)
- [Appendix A — Glossary](#appendix-a--glossary)
- [Appendix B — File reference index](#appendix-b--file-reference-index-current-code)

---

## 1. Vision

**Clipwright Studio is a local-first desktop video editor where Claude Code is a first-class collaborator.** A project starts one of two ways: **(a) Claude Code records it for you** by driving a Playwright browser session against your app, or **(b) you upload an existing video** (screen recording, webcam, anything). Either way you land on the same timeline. You can edit it manually with conventional tools (trim, voice-over, captions, zoom, annotations), or you can right-click a segment and ask Claude to do it. Claude reads the project, makes edits to JSON + assets on disk, and the timeline updates.

The project on disk is the source of truth: a directory of JSON + media files that is `git commit`-friendly, fully regeneratable, and identical whether produced by a human dragging a clip handle or by Claude Code editing the file. There is no cloud, no account, no proprietary database.

**One-line positioning:** *The desktop video editor that thinks. Edit by hand or by prompt — the project is plain files either way.*

---

## 2. Goals and Non-Goals

### 2.1 Goals (MVP-defining)

| # | Goal | Test |
|---|---|---|
| G1a | Import any MP4 / MOV file and see a usable segmented timeline within 30 seconds | Drag a 5-min screen recording in → segments appear automatically |
| G1b | Create a project by recording: describe a flow to Claude → it writes a `browse-plan.json`, drives Playwright, and seeds the timeline with one segment per chapter | "Record a demo of my app" → Claude opens a browser, records, returns to timeline view |
| G2 | Edit a single segment (trim, swap VO, toggle captions, change zoom) without re-running the entire pipeline | Edit segment 3 of 8 → only segment 3 re-renders, < 5s for short clips |
| G3 | Right-click any segment → "Ask Claude" opens a scoped chat that can modify that segment | "Make this punchier" → Claude rewrites VO text and re-runs TTS for that clip only |
| G4 | Export a final MP4 from the editor with the same render quality the CLI produces today | Pixel/audio parity with current `clipwright render` on the same inputs |
| G5 | The project directory is portable and regeneratable: zip it, move it, re-render on another machine | `clipwright render <project>` from CLI produces same MP4 the GUI did |

### 2.2 Non-Goals (explicit, to keep scope honest)

- **Not a Descript / Premiere clone.** No multi-cam, no advanced color grading, no audio sweetening, no transitions library on day one.
- **Not a cloud product.** No accounts, no sync, no hosted rendering, no telemetry sent off-device.
- **Not a webcam recorder / talking-head tool.** Use OBS, Loom, ScreenStudio for capture if you want that. We import what they produce.
- **Not a SaaS for the Python CLI users.** The CLI continues to work standalone for headless/CI use. The desktop is a sibling, not a replacement.
- **Not trying to host Claude Code itself.** We *invoke* the existing `claude` binary the user already has installed. We don't reimplement the agent.
- **Not multi-user collaboration in v1.** Single user, single machine.

---

## 3. Users & Primary Journeys

### 3.1 Personas

**Primary: "Indie shipper Maya"** — founder/DevRel, ships features and needs short vertical demos and longer YouTube explainers. Knows JSON, lives in the terminal, runs Claude Code daily. Currently uses Loom + manual editing in iMovie. *Pain:* every UI change forces a re-record. *Win:* her project is `git commit`-ed; when the UI changes she re-records and re-renders.

**Secondary: "Pragmatic dev Sam"** — wants to publish a tutorial walkthrough but doesn't write copy well. Imports a screen recording, asks Claude to script and caption it. Manually nudges segment boundaries.

**Out of scope for MVP: agencies, marketing teams, video editors-by-trade.** We will gain or lose them later; designing for them now dilutes everything.

### 3.2 Two primary journeys

The product has **two equal entry points**. Both land on the same timeline editor — the difference is only how the source footage gets there.

**Journey A — "Record with Claude" (G1b).**
Maya clicks **New Project → Record**. She types: *"Demo the new manga search feature on staging — open the app, search for One Piece, open a chapter, scroll the reader."* Claude proposes a `browse-plan.json` (4 chapters, ~12 actions, base URL pre-filled from project settings). She reviews, tweaks the wait timing on one action, clicks **Record**. Playwright opens, runs the plan, captures `sources/main.mp4` and a per-action `moments.json`. Clipwright Studio seeds `timeline.json` with one segment per chapter (using the existing chapter logic from SKILL.md). Maya arrives on the timeline with 4 labelled segments ready for VO, captions, and zoom.

**Journey B — "Upload & edit" (G1a).**
Maya drags `feature-demo.mp4` onto Clipwright Studio. In ~10s, the timeline shows 6 auto-detected segments (silence + scene detection). She scrubs, deletes segment 4 (a fumble), and asks Claude in the side panel: *"Write voice-over for segments 1–3, punchy launch tone."* Claude reads each clip's transcript and visible UI, writes draft VO into `script.json`, and clicks Preview. Maya likes 1 and 3, edits 2 by hand. She right-clicks segment 5: *"Zoom on the upload button at 0:14."* Claude updates `camera.json` for that segment. She clicks Render. The MP4 lands in `out/`. She commits the project.

**From either entry point**, the rest is identical: same timeline, same inspector, same Ask-Claude, same render. A "Record" project can later have additional footage uploaded as a second source; an "Upload" project can later have a `browse-plan.json` added to re-shoot a section. The two modes compose.

---

## 4. System Architecture

Three layers, three clean interfaces. Each layer is independently usable.

```
┌──────────────────────────────────────────────────────────────┐
│  L3  Claude Code (existing `claude` CLI, user-installed)     │
│      • Reads/writes project files via the clipwright skill   │
│      • Invoked per-segment with scoped context               │
└─────────────────────────────▲────────────────────────────────┘
                              │ stdin/stdout, file I/O
┌─────────────────────────────┴────────────────────────────────┐
│  L2  Python Compute Layer  (existing `src/clipwright/`)      │
│      • Pipeline stages as library functions + CLI            │
│      • TTS, captions, render, generate, inspire              │
│      • Emits typed events on a JSON-line stdout protocol     │
└─────────────────────────────▲────────────────────────────────┘
                              │ Tauri command channel + JSON
┌─────────────────────────────┴────────────────────────────────┐
│  L1  Desktop Editor  (Tauri + React, new)                    │
│      • Timeline UI, segment inspector, preview player        │
│      • Claude chat panel, "Ask Claude" per segment           │
│      • Project file watcher, hot reload of preview           │
└──────────────────────────────────────────────────────────────┘
```

**Critical principle:** the desktop never holds state the project files don't have. Close the app, reopen, identical state. Edit a file in Vim, the UI updates. This is what makes Claude Code integration trivial — Claude edits files; we watch them.

### 4.1 Process model

- Desktop is a single Tauri process (Rust + React).
- Python compute is spawned **per operation** as `clipwright <subcommand>` subprocess. No long-lived Python daemon in v1. Latency is acceptable because operations are scoped to single segments.
- Claude Code is spawned **per Ask-Claude invocation** as `claude --print --output-format stream-json ...` subprocess. We pipe its output into the chat panel.
- Preview player uses `<video>` against rendered segment files. Live preview during scrubbing uses the raw imported source.

### 4.2 Why this architecture wins

1. **Three layers, three teams can work independently.** Frontend team doesn't block on Python; Python team doesn't block on UI.
2. **CLI users keep their CLI.** No regression for the existing audience.
3. **Claude Code integration is essentially free.** We're not building agentic infrastructure — we're spawning a binary the user already has and parsing its JSON.
4. **Files-as-state means undo, history, and collaboration are git problems, not our problems.**

---

## 5. Data Model

A project is a directory. Everything is JSON or media. No SQLite, no app database.

### 5.1 Directory layout

```
my-video/
├── project.json              ← root manifest (schema_version, title, aspect, fps)
├── sources/
│   ├── main.mp4              ← imported video(s)
│   └── main.transcript.json  ← Whisper transcript (auto, lazy)
├── timeline.json             ← segments[], the editable timeline
├── voiceover/
│   ├── script.json           ← per-segment text + voice config
│   └── audio/<seg_id>.mp3    ← rendered VO + .timestamps.json + .cache.json
├── captions/
│   ├── style.json            ← font, size, color, position, max words/chunk
│   └── <seg_id>/             ← PNG frames + index json
├── camera.json               ← per-segment zoom/pan keyframes
├── annotations.json          ← click ripples, highlights, callouts
├── brand/                    ← optional, from `inspire`
│   ├── primary_color
│   ├── logo.png
│   └── hero.png
├── scenes/                   ← non-recording scenes (intro, broll, outro)
│   └── <slot>/               ← either generative output OR PIL outro
├── chat/
│   └── sessions/             ← Claude Code transcripts, one per session
└── out/
    ├── segments/<seg_id>.mp4 ← per-segment rendered output (cache)
    └── final.mp4
```

### 5.2 `timeline.json` schema (the editable core)

```jsonc
{
  "schema_version": 1,
  "segments": [
    {
      "id": "seg_001",                      // stable, never reused
      "source": "sources/main.mp4",         // which file
      "source_start": 12.40,                // seconds in source
      "source_end": 24.80,
      "target_duration": 12.40,             // desired output duration (TTS-stretched if VO present)
      "kind": "recording",                  // recording | scene | generated
      "scene_type": null,                   // when kind != recording: title | broll | outro
      "label": "Library overview",          // human-readable
      "chapter": "intro",                   // groups segments for navigation
      "voiceover": {
        "enabled": true,
        "script_clip_id": "vo_001"          // points into voiceover/script.json
      },
      "captions": { "enabled": true, "style_ref": "default" },
      "camera": { "enabled": true, "ref": "camera.json#seg_001" },
      "annotations": { "enabled": true, "ref": "annotations.json#seg_001" }
    }
  ]
}
```

**Why this shape:** every segment is independent. The renderer reads one segment, fans out to TTS/caption/camera/annotation operations, and writes one cached MP4. Editing segment 3 invalidates only segment 3.

### 5.3 `project.json` schema

```jsonc
{
  "schema_version": 1,
  "title": "Feature launch demo",
  "aspect": "9:16",                         // 9:16 | 16:9 | 1:1
  "fps": 30,
  "render_backend": "remotion",             // remotion | ffmpeg
  "tts_provider": "kokoro",                 // kokoro | elevenlabs | piper | vibevoice
  "voice_id": "af_sky",
  "created_at": "2026-05-12T...",
  "claude_skill_path": "~/.claude/skills/clipwright"
}
```

### 5.4 `voiceover/script.json` schema

```jsonc
{
  "schema_version": 1,
  "clips": [
    {
      "id": "vo_001",                 // referenced by timeline segment.voiceover.script_clip_id
      "segment_id": "seg_001",        // back-reference for orphan detection
      "text": "Your library. Unified. Fifty titles, one clean grid.",
      "target_seconds": 12.0,         // mirrors segment.target_duration; used by stretch logic
      "voice": {
        "provider": "kokoro",         // overrides project.tts_provider if set
        "voice_id": "af_sky",
        "model": null                  // ElevenLabs-only; null otherwise
      },
      "hint": "Library overview moment: search, add, grid view"  // for Ask-Claude grounding
    }
  ]
}
```

### 5.5 `camera.json` schema

```jsonc
{
  "schema_version": 1,
  "fps": 30,
  "viewport": { "w": 540, "h": 960 },  // recording-pixel space
  "segments": {
    "seg_001": {
      "keyframes": [
        { "t": 0.0,  "zoom": 1.0, "focus": [0.5, 0.5] },
        { "t": 1.5,  "zoom": 1.5, "focus": [0.62, 0.40] },
        { "t": 4.0,  "zoom": 1.0, "focus": [0.5, 0.5] }
      ]
    }
  }
}
```

Keyframe times are in *output-timeline* seconds relative to segment start. Mirrors the existing `CameraPlan` dataclass — only reformatted to be segment-keyed so a file watcher can dispatch by `camera.json#seg_001`.

### 5.6 `annotations.json` schema

```jsonc
{
  "schema_version": 1,
  "segments": {
    "seg_001": [
      {
        "id": "ann_001",
        "kind": "click_ripple",       // click_ripple | highlight_ring | callout
        "t_start": 1.40,              // output-timeline seconds within the segment
        "duration": 0.6,
        "bbox": { "x": 320, "y": 540, "w": 80, "h": 40 },  // recording-pixel space
        "label": null                 // string for callouts; null otherwise
      }
    ]
  }
}
```

### 5.7 `captions/style.json` schema

```jsonc
{
  "schema_version": 1,
  "default": {
    "font": "DejaVuSans-Bold",
    "size": 72,
    "color": "#FFFFFF",
    "stroke": { "color": "#000000", "width": 4 },
    "position": "bottom_center",     // top_center | center | bottom_center
    "y_offset": 240,                  // px from chosen edge
    "max_words_per_chunk": 2,
    "uppercase": true
  },
  "styles": {
    "subtle": { "color": "#E0E0E0", "size": 56, "uppercase": false, "max_words_per_chunk": 4 }
  }
}
```

Per-segment overrides set `timeline.json#segments[].captions.style_ref` to a key under `styles`. Default applies otherwise.

### 5.8 Sidecar cache files

Every stage that produces an artifact writes a sibling `.cache.json`:

```jsonc
{
  "schema_version": 1,
  "input_hash": "sha256:abc123...",   // hash of (inputs + provider config + tool version)
  "produced_at": "2026-05-12T13:42:11Z",
  "tool_version": "0.2.0"
}
```

Stage-specific examples already in the codebase: `out/audio/<seg>.mp3.cache.json`, `out/scenes/<slot>/result.cache.json`. P0.4 extends this pattern to captions and per-segment render outputs.

### 5.9 File-as-state invariants

1. The desktop UI is a pure projection of the files. Closing/reopening reproduces identical state.
2. All operations write atomically: tmp file → rename. Never a partial JSON on crash. (Enforced in `clipwright.schema.io._write_json_atomic`.)
3. Every operation emits a `.cache.json` sidecar with the SHA-256 hash of its inputs (already implemented for TTS and generate; P0.4 extends to caption, camera, render).
4. Segment IDs are stable across edits. Splitting `seg_001` produces `seg_001` + a new id; never renumbers downstream.
5. Cross-file references use `<relative_path>.json#<seg_id>` so the watcher can dispatch invalidations to the precise segment.
6. No on-disk file outside the project directory holds project state. The only exceptions are: OS keychain (API keys) and `~/.clipwright/recents.json` (the Hub's recents list).

---

## 6. Functional Requirements

Grouped by area. Each requirement has a stable ID for referencing in tickets.

### 6.1 Project creation — two equal modes

The **New Project** dialog asks: *Record* or *Upload*? Both produce a valid project directory matching §5.

#### 6.1.a Mode: Record (Playwright-driven, Claude-authored)

- **F-REC-1** "New Project → Record" launches a wizard: project name, target aspect, base URL, viewport (mobile/desktop preset).
- **F-REC-2** A "Describe your demo" textarea where the user types a natural-language description of the flow. A "✨ Draft plan with Claude" button spawns Claude with the clipwright skill loaded and the description + base URL in context; Claude writes `browse-plan.json` into the project. Power users can write/edit the JSON directly.
- **F-REC-3** Plan editor view: the `browse-plan.json` rendered as a sortable list of actions grouped by chapter. Inline edit of label, wait, fields. Add/delete/reorder actions. "✨ Ask Claude" per action ("make this wait longer", "tap the share button instead").
- **F-REC-4** "Record" button executes `clipwright record --plan browse-plan.json` as a subprocess. Playwright opens a visible browser window so the user can watch. Progress bar streams from the recorder's stage events.
- **F-REC-5** On completion, the recorder writes `sources/main.mp4` + `moments.json`. The editor seeds `timeline.json` with one segment per chapter using the existing `segments` logic. User lands on the timeline view.
- **F-REC-6** "Re-record" button on the timeline view: edits to `browse-plan.json` are detected; clicking re-record replays the plan, replaces `sources/main.mp4`, and **preserves the timeline structure** — same segment IDs, same VO/captions/camera, only the source footage changes. This is the regeneratable-on-UI-change unlock from doc.md.
- **F-REC-7** Partial re-record: select chapters to re-shoot; Playwright runs only those actions; the affected segments swap their underlying source range. (P1, not blocking for MVP.)
- **F-REC-8** Recording requires Playwright Chromium installed (existing `install.sh` flow). The doctor panel surfaces missing deps with one-click install.

#### 6.1.b Mode: Upload (any video, auto-segment)

- **F-UPL-1** Drag-and-drop or file-picker import of MP4 / MOV / WebM into the editor.
- **F-UPL-2** Auto-segment imported videos using one or both of:
  - **Silence detection** (`ffmpeg silencedetect`) on the audio track — primary signal for screen recordings with VO.
  - **Scene detection** (`ffmpeg scdet`) on the video — fallback for visual-only content.
  Target: produce 4–12 segments for a 5-min source. User can split/merge after. `--no-auto-segment` opt-out available.
- **F-UPL-3** Multiple sources supported: a project can hold N source files; segments reference any of them by path. Use cases: B-roll over a primary track, intercut webcam reactions, etc. (P1 for multi-source UI; P0 supports it in the data model.)

#### 6.1.c Shared

- **F-IMP-SH-1** Generate a Whisper transcript lazily on first request (faster-whisper, already a Piper dep). Cache as `<source>.transcript.json`. Used for word-boundary trim snapping and Ask-Claude context.
- **F-IMP-SH-2** Both modes write the same `project.json` + `timeline.json` shape. The only difference: a Record project has a `browse-plan.json` at the root and `record.<source>.json` metadata; an Upload project has neither.

### 6.2 Timeline editing

- **F-TL-1** Render a timeline of segment blocks; horizontal scroll; zoom in/out with `Cmd +/-`.
- **F-TL-2** Click a segment to select; multi-select with `Shift`.
- **F-TL-3** Drag segment edges to trim (snaps to word boundaries when transcript available — reuse the rule from SKILL.md "Never cut inside a word").
- **F-TL-4** Right-click → Split, Delete, Duplicate, Merge with neighbor.
- **F-TL-5** Drag segments to reorder. Updates `timeline.json#segments[].order` implicitly via array position.
- **F-TL-6** Undo/redo stack backed by file snapshots in `.clipwright/history/` (last 50 states). Cmd+Z scoped to current project.

### 6.3 Per-segment inspector

A vertical accordion panel (see §8.5.3) with five collapsible groups. Each group has an "✨ Ask Claude" affordance that prefills a context-specific prompt.

- **F-INS-1 Voiceover group:** edit script text, pick voice, pick provider, "Preview ▸" button (uses Piper for free local preview regardless of configured provider), "Regenerate" button (uses configured provider; shows cost estimate before invoking).
- **F-INS-2 Captions group:** on/off toggle, style override picker (from `captions/style.json#styles`), position override.
- **F-INS-3 Camera group:** zoom-curve preview, zoom-level slider, focus-point picker (click on the preview frame to set focus xy).
- **F-INS-4 Annotations group:** list of overlay events; add manually or auto-derive from Playwright bbox capture (reuse existing); per-event type picker (`click_ripple` / `highlight_ring` / `callout`).
- **F-INS-5 Trim group:** source-in / source-out timecode inputs; target-duration override; "Snap to word boundary" toggle (default on when transcript exists).
- **F-INS-6 Expand-state persistence:** which groups are expanded persists per-segment in `.clipwright/ui-state.json` so opening a segment returns to the user's last layout.

### 6.4 Preview

- **F-PRV-1** Preview pane plays the *current state* of the selected segment(s).
- **F-PRV-2** Raw scrubbing plays the source file directly (no compute).
- **F-PRV-3** "Render preview" button triggers a per-segment render for accurate preview (uses cached output if up-to-date).
- **F-PRV-4** Full-timeline preview plays cached per-segment MP4s sequentially. Stale segments trigger a re-render on demand.

### 6.5 Claude Code integration

This is the differentiator. Treat it as a P0 requirement, not a P1 polish.

- **F-CLD-1 Project-scoped chat panel.** A persistent side panel that runs `claude` in the project directory with the clipwright skill loaded. Conversation history persists in `chat/sessions/<id>.jsonl`.
- **F-CLD-2 Segment-scoped invocation.** Right-click segment → "Ask Claude" pops a quick-prompt input. Submitting spawns `claude --print` with a system context that includes: the segment JSON, its current script text, the transcript window, neighboring segment summaries, and an instruction to edit the relevant files and *not* describe the changes.
- **F-CLD-3 Streaming output rendered into the chat.** Use `--output-format stream-json` and parse the event stream.
- **F-CLD-4 File watcher reconciles UI on edit.** When Claude writes to `script.json` / `timeline.json` / `camera.json`, the watcher invalidates the affected segment's cache and refreshes the UI.
- **F-CLD-5 Prompt templates per inspector tab.** Each tab has a "✨ Ask Claude" button that pre-fills a useful prompt: VO tab "rewrite for [tone]"; Camera tab "find the UI element to zoom on at [time]"; Captions tab "rephrase shorter so it fits 12s at 2.5 wps".
- **F-CLD-6 Safety: Claude only edits files inside the project directory.** Enforced by spawning `claude` with `--cwd <project>` and no global write permissions.
- **F-CLD-7 Cost & action transparency.** A status bar shows: tokens used, files changed (with diff peek), and a one-click "Revert this session" backed by the history snapshots in F-TL-6.

### 6.6 Render

- **F-RND-1 Per-segment render.** Reuses existing composer with strict adherence to SKILL.md hard rules (subs LAST, per-segment extract, 30ms fades, etc.).
- **F-RND-2 Cache by content hash.** Re-rendering a segment with identical inputs is a no-op (already partially implemented; complete it).
- **F-RND-3 Final render.** Concat per-segment MP4s + outro using existing ffmpeg path. Output to `out/final.mp4`.
- **F-RND-4 Headless render mode.** `clipwright render <project>` from CLI produces an identical MP4. CI/automation friendly.
- **F-RND-5 Progress events.** Render emits the existing typed event stream (`StageStarted/Completed/Failed`), consumed by the UI for the progress bar.

### 6.7 Configuration

- **F-CFG-1** Settings dialog: default aspect ratio, default TTS provider/voice, default render backend, Claude binary path, API keys (stored in OS keychain, not project files), telemetry toggle (default off, see §16).
- **F-CFG-2** Per-project overrides in `project.json`. UI surfaces overrides as "Project default" vs "App default" labels.
- **F-CFG-3** `clipwright doctor` (already exists) surfaced as a UI panel: see §6.8.

### 6.8 Doctor / system health

The Doctor panel makes the status of every external dependency visible in one place. Reuses the existing `clipwright doctor` checks.

- **F-DOC-1** Inline checks for: Python interpreter, ffmpeg, ffprobe, Node ≥ 18, Playwright Chromium, the user's `claude` binary, each configured TTS provider's runtime (Kokoro torch import, Piper model download state), each configured generate provider's env keys.
- **F-DOC-2** Each row: name, status (✓ / ⚠ / ✗), one-line description, **action** button when broken: "Install", "Set API key", "Choose binary path".
- **F-DOC-3** The status-bar doctor indicator (§8.5.6) reflects the worst-status of all required checks. Optional providers are excluded unless the user has selected them.
- **F-DOC-4** Doctor runs on app launch, on Settings open, and on demand from the status bar.

### 6.9 Empty states & onboarding

Empty states are first-class screens, not afterthoughts. Each tells the user exactly what to do next.

- **F-EMP-1 No project open** (Hub on first run): shows the New Project / Open Existing cards prominently; a small "Watch 60-second tour" link below.
- **F-EMP-2 Project just created, Record mode, no plan yet:** workspace loads with the Plan Editor surfaced in the preview area (instead of an empty preview). A single textarea: *"Describe the demo you want to record"* with a `[✨ Draft plan with Claude]` button. Once a plan exists, the area collapses into a compact summary card; expanding it returns to the editor.
- **F-EMP-3 Project just created, Upload mode, no source yet:** preview area becomes a drag-target with `⬆ Drop a video here, or click to choose`. The timeline shows a placeholder row.
- **F-EMP-4 Source present, no segments selected:** preview plays the stitched project (or just the source if no segments yet); inspector shows project-level info (title, total duration, render budget summary).
- **F-EMP-5 Segment selected, no voiceover yet:** Voiceover group expanded by default; text area shows a faint placeholder *"What should this segment say?"* with a `[✨ Draft with Claude]` button using the segment hint.
- **F-EMP-6 First-time experience callouts:** non-blocking tooltips appear once per install on (1) the inspector accordion, (2) the Claude rail, (3) the Render button. Dismissible; persisted in `~/.clipwright/onboarding.json`.

---

## 7. Non-Functional Requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Cold launch time | < 2s on a 2022 MacBook Air |
| NFR-2 | Time to first usable timeline after drag-drop of a 5-min MP4 | < 30s including segment detection |
| NFR-3 | Per-segment re-render after one-word VO edit | < 5s (Kokoro local) |
| NFR-4 | Memory footprint with a 30-min project loaded | < 500 MB resident |
| NFR-5 | Platform support v1 | macOS arm64 + Intel. Windows v1.1. Linux v2. |
| NFR-6 | All data local. No outbound network calls except: TTS providers (when chosen by user), generative providers (BYOK only), Claude Code (the user's own credentials). | Pen-testable; documented in README |
| NFR-7 | App size on disk | < 200 MB bundle. Models lazy-downloaded on first use. |
| NFR-8 | Project format stability | `schema_version` field in every JSON; migrations live in `src/clipwright/schema/v{N}/migrate.py`. |
| NFR-9 | Accessibility | All interactive elements keyboard-reachable; WCAG AA color contrast in both themes; screen-reader labels on icon-only buttons. No formal certification claim. |
| NFR-10 | Localization | English-only v1. Strings extracted into one `i18n/en.json` so future locales are mechanical. |
| NFR-11 | Offline behavior | Fully usable offline once first-run model downloads are complete. UI hides any "online" affordances (cloud provider buttons disabled with tooltip "needs network") when `navigator.onLine === false`. |
| NFR-12 | Crash recovery | On unexpected exit, reopening the last project restores: selected segment, playhead position, inspector accordion state, Claude rail expansion. Persisted in `.clipwright/ui-state.json` (debounced, 200ms). |

---

## 8. UI Specification

### 8.1 Information architecture

The app lives in a **single window** with two top-level views:

1. **Project Hub** — landing page. List of recent projects, a big "New Project" button, settings. No editor chrome.
2. **Project Workspace** — the editor. Loaded when a project is opened.

Transition between them via the breadcrumb in the top bar (`◀ Projects · My Demo`). No multi-window juggling, no MDI, no detachable panels in v1.

### 8.2 Design principles

These are the rules a designer or engineer can use to resolve any future layout decision.

1. **The timeline is the spine.** Everything else is in service of editing what's on the timeline. Never push the timeline below the fold.
2. **Single focus per moment.** The inspector reflects exactly what's selected. Never a "global edit" mode that competes with segment context.
3. **Progressive disclosure over tabs.** The inspector is a vertical accordion, not a tab strip. You see all five property groups at once and expand what you need. Tabs hide three-fourths of the surface; accordions hide none.
4. **No modals except for destructive or system actions.** Trimming, scripting, Ask-Claude — all happen inline.
5. **Claude is always one keypress and one click away.** The chat panel collapses to a thin rail on the right edge (with a count badge if there's unread output); never hides entirely.
6. **The status bar is the truth bar.** Render readiness, stale segments, doctor health, autosave state — all visible at all times in the bottom edge.

### 8.3 Project Hub (landing view)

```
┌──────────────────────────────────────────────────────────────────┐
│  Clipwright Studio                                          [⚙]  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│    ┌──────────────────────┐  ┌──────────────────────┐            │
│    │  + New Project       │  │  📁 Open Existing    │            │
│    │  Record or upload    │  │  Pick a directory    │            │
│    └──────────────────────┘  └──────────────────────┘            │
│                                                                  │
│  Recent                                                          │
│  ─────────────────────────────────────────────────────────────   │
│   📹  Vertex Reader launch demo · 2:43 · edited 14m ago      ⋯  │
│   📹  Kwarry feature reveal · 1:18 · edited 2d ago           ⋯  │
│   📹  OSS release teaser · 0:42 · edited 1w ago              ⋯  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- **"+ New Project"** opens the two-mode chooser (§8.4).
- **"📁 Open Existing"** is a native folder picker that finds any directory containing `project.json`.
- **Recent list** is a `~/.clipwright/recents.json` of (path, title, last_modified). Right-click → reveal in Finder / remove from list / delete project (with confirm).
- **No login. No cloud. No sync banner.** The Hub looks the same whether you've used the app for 5 minutes or 5 months.

### 8.4 New Project flow

A single modal step with two equal cards, then mode-specific setup.

```
┌──────────────────────────────────────────────────────────────────┐
│  New Project                                              [✕]    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│    ┌──────────────────────┐   ┌──────────────────────┐           │
│    │   🎬                 │   │   ⬆                  │           │
│    │   Record with        │   │   Upload a video     │           │
│    │   Claude             │   │                      │           │
│    │                      │   │   Drag a file or     │           │
│    │   Drive a browser    │   │   choose from disk   │           │
│    │   flow with an       │   │                      │           │
│    │   agent              │   │                      │           │
│    └──────────────────────┘   └──────────────────────┘           │
│                                                                  │
│    Where to save: [~/Videos/clipwright/             ] [Choose…]  │
│    Project name:  [my-new-demo                                 ] │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

After mode selection the user lands in the Workspace immediately. Mode-specific first-run state (described in §6.9) seeds the right empty state.

### 8.5 Project Workspace (editor)

Four regions, fixed positions, predictable. The proportions below are defaults; the user can drag region dividers but cannot detach or hide them (except the Claude rail).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◀ Projects · My Demo                       [⌘K] [▶ Render] [⚙]           │  ← top bar (40px)
├───────────────────────────────────────────────────┬──────────────────────┤
│                                                   │                      │
│                                                   │   CLAUDE             │
│                  PREVIEW                          │                      │
│           (selected segment plays here)           │   ┌─ chat ──────────┐│
│                                                   │   │ you: …          ││
│                                                   │   │ claude: wrote…  ││
│              ▶  00:14 / 02:43                     │   └─────────────────┘│
│                                                   │                      │
│                                                   │   > _ (⌘K)           │
├───────────────────────────────────────────────────┤                      │
│ SEGMENT INSPECTOR  (selected: seg_003)            │   [◀ collapse]       │
│                                                   │                      │
│  seg_003 · "Open the reader" · 12.4s              │                      │
│  ▾ Voiceover      Kokoro · af_sky                 │                      │
│  ▾ Captions       Default style                   │                      │
│  ▸ Camera         zoom 1.0 → 1.5                  │                      │
│  ▸ Annotations    1 highlight                     │                      │
│  ▸ Trim           0:12.4 → 0:24.8                 │                      │
├───────────────────────────────────────────────────┴──────────────────────┤
│ TIMELINE                                                                  │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━     │
│  ▓ seg_001 ▓ seg_002 ▓ seg_003 [sel] ▓ seg_004 ▓ seg_005                 │
│  ░ audio waveform ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░             │
│  CAP: AB CD EF GH IJ KL                                                  │
├──────────────────────────────────────────────────────────────────────────┤
│ ⚡ ready · 0 stale · saved · doctor ✓ · last render 2m ago                │  ← status bar (24px)
└──────────────────────────────────────────────────────────────────────────┘
```

#### 8.5.1 Top bar (40px)

- Left: breadcrumb `◀ Projects · <project title>`. Clicking `Projects` returns to the Hub. Project title is double-click-to-rename.
- Right: `[⌘K]` button (focus chat input), `[▶ Render]` primary action, `[⚙]` settings.
- Nothing else. No tab strip, no recording-status indicator (record state lives on the timeline when in Record mode).

#### 8.5.2 Preview pane (top-left, ~55% width)

- Centered video with aspect-correct letterboxing.
- Transport: ▶/⏸, scrub bar with playhead, timecode, frame-step `J/L`, mute toggle.
- Aspect-ratio indicator (9:16 / 16:9 / 1:1) in a corner.
- When no segment is selected: shows the *project* as a stitched playback of all per-segment cached MP4s (stale segments draw a striped overlay).

#### 8.5.3 Segment Inspector (bottom-left, ~45% height, below preview)

**Accordion**, not tabs. Header row shows segment id + label + duration. Five collapsible groups in this order, expand state per-segment persisted in the project's `.clipwright/ui-state.json`:

1. **Voiceover** — text editor, voice picker, provider picker, [Preview ▸] (free Piper), [Regenerate] (configured provider, shows cost estimate), [✨ Ask Claude].
2. **Captions** — on/off toggle, style override picker, position picker, [✨ Ask Claude] ("shorten so it fits at 2.5 wps").
3. **Camera** — zoom-curve preview, focus point picker (click on the preview frame to set xy), [✨ Ask Claude] ("find the upload button at 0:14").
4. **Annotations** — list of overlay events, add/remove, type picker (ripple / highlight / callout), [✨ Ask Claude].
5. **Trim** — source-in / source-out timecode inputs, target-duration override, "Snap to word boundary" toggle.

Each accordion row collapses to a one-line summary (`Kokoro · af_sky`) so scanning the whole segment's state takes one glance.

#### 8.5.4 Timeline (full width, ~25% height, bottom)

- Horizontal segment strip with chapter color bands.
- Audio waveform of the source (one row).
- Caption preview row showing per-segment caption text density.
- Playhead synced to preview.
- **Interactions:** click to select; shift-click to multi-select; drag edges to trim (snaps to word boundaries when transcript exists); right-click context menu (split, delete, duplicate, merge with neighbor).
- **Zoom:** `⌘ +` / `⌘ -` to zoom in/out; `⌘ 0` fit-to-window.

#### 8.5.5 Claude rail (right side, ~25% width, collapsible)

- Default expanded; collapse to a 24px rail with chat-icon + unread badge.
- **Header:** session token count + cost-to-date for this session.
- **Body:** chat transcript. File-change events render inline as cards (`📝 wrote voiceover/script.json#vo_003 [Diff]`). Clicking a diff card opens an inline diff viewer.
- **Input:** multi-line textarea. Slash commands: `/preview`, `/render`, `/undo`, `/clear-chat`, `/help`.
- **Quick prompts** above the input are context-aware: with a segment selected, show: "Rewrite VO punchier", "Find element to zoom on", "Shorten captions".

#### 8.5.6 Status bar (24px, full width, bottom)

- Left: render readiness (`⚡ ready` / `⚠ 2 stale` / `⟳ rendering 3/5`).
- Middle: save state (`saved` / `unsaved` / `saving…`).
- Right: doctor health (✓ green / ⚠ yellow / ✗ red, clickable → opens Settings → System), last render time.

### 8.6 Keyboard map (always-active)

| Key | Action |
|---|---|
| `⌘K` | Focus Claude input |
| `⌘S` | Force save (autosave is on; this flushes pending writes) |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `Space` | Play/pause preview |
| `J` / `L` | Frame-step back / forward |
| `←` / `→` | Select previous / next segment |
| `[` / `]` | Trim selected segment in-point / out-point at playhead |
| `⌘D` | Duplicate selected segment |
| `⌫` (Backspace) | Delete selected segment (asks confirm if not undoable) |
| `⌘B` | Split selected segment at playhead |
| `⌘E` | Expand all inspector accordion sections |
| `⌘\` | Toggle Claude rail collapsed |
| `⌘ +/-/0` | Timeline zoom |
| `⌘ ,` | Open Settings |
| `⌘ ⇧ P` | Command palette (every action by name) |

### 8.7 Visual language hints (for design partner)

This is not a full design system, just the principles. A designer should pick concrete tokens.

- **Tone:** technical, calm, agent-confident. Closer to Linear / Raycast than Premiere / Final Cut.
- **Density:** medium. Aim for ~50% information density; Final Cut feels cluttered, ScreenStudio feels sparse — sit between.
- **Color:** monochrome base + one strong accent for the playhead and the Render CTA. Segment chapter bands use category colors but desaturated.
- **Typography:** one sans-serif (system or Inter) for UI, one monospaced for timecodes and segment IDs.
- **Motion:** transitions ≤150ms. Inspector accordion: 120ms cubic-out. Claude rail collapse: 180ms. Playhead: no animation, snaps to frame.
- **Dark mode is default**, light mode supported. Auto-follow system preference.

### 8.8 Hand-off package for designer

A designer (or Claude Design) gets everything they need from these sections, in this reading order:

1. §1 Vision
2. §3.2 Both user journeys
3. §6.9 Empty states & onboarding (see below)
4. §8.1–8.7 (this section)
5. §5.1 Directory layout (so screens visualize correct file structure)

They produce: Figma frames for Hub, New Project modal, Workspace (all four regions), each inspector accordion expanded, the chat rail, the empty/onboarding states, the Settings panel, the Render dialog, the Doctor panel. Nothing more in v1.

---

## 9. Claude Code Integration Specification

This is the highest-leverage and most distinctive piece. Detailed because it must be right.

### 9.1 Invocation contract

The desktop spawns the `claude` binary as a subprocess. **It never reimplements agent logic.** Two modes:

**Mode A — Persistent chat session.**
```
claude \
  --cwd <project_dir> \
  --output-format stream-json \
  --append-system-prompt "$(cat .clipwright/system-prompt.md)" \
  --resume <session_id>
```
Maintained for the open project. Bidirectional stdin/stdout.

**Mode B — One-shot scoped edit ("Ask Claude" on a segment).**
```
claude \
  --print \
  --cwd <project_dir> \
  --output-format stream-json \
  --append-system-prompt "$(build_segment_prompt seg_003)" \
  "<user request>"
```
Spawned fresh, exits when done. Output streamed into the chat panel as a transient sub-conversation.

### 9.2 The system prompt build

A small library in `src/clipwright/agent/` constructs the system prompt at invocation time:

- Project root path
- Current timeline summary (segments, durations, labels)
- For segment-scoped invocations: the segment JSON, its script clip, ±2 neighboring segments' labels, the transcript window for `[source_start - 1s, source_end + 1s]`
- A pointer to the clipwright skill: *"The clipwright skill at ~/.claude/skills/clipwright documents the file formats and editing primitives. Read it before editing."*
- Hard constraints: *"Edit only files inside this project. Do not run network requests. Do not modify project.json schema_version."*

### 9.3 File watcher → UI reconcile

A `notify`-based watcher (Rust side, via `notify` crate) on the project directory:

- `timeline.json` change → reload timeline state
- `voiceover/script.json` change → mark affected segments' VO caches stale
- `camera.json` / `annotations.json` change → mark affected segments stale
- Any media file change → invalidate any segment that references it

Debounced 200ms.

### 9.4 Session transcript persistence

Every Claude session writes `chat/sessions/<id>.jsonl`. The history panel shows past sessions per project. Git-friendly.

### 9.5 What we explicitly do not build

- A custom agent loop. We use `claude`.
- A tool-use protocol. Claude has tools (Read/Edit/Write) already; they operate on project files directly.
- Cost tracking infrastructure. Claude's own output reports usage; we display it.

---

## 10. Reuse Map: What Carries Over from Current Code

The pivot doesn't require throwing away the codebase. Here's what stays, what changes, what retires.

| Component | Path | Disposition | Notes |
|---|---|---|---|
| TTS providers (Kokoro, ElevenLabs, Piper) | `src/clipwright/tts/` | **Keep as-is** | Provider ABC + char-timestamp shape are perfect for the editor. Add VibeVoice in P2. |
| Caption chunker | `src/clipwright/captions/` | **Keep as-is** | 2-word UPPERCASE rules become defaults; UI exposes overrides. |
| Render composer (ffmpeg) | `src/clipwright/render/composer.py` | **Keep, refactor to per-segment entry point** | Today renders whole timeline; need `render_segment(seg_id)` entry. |
| Remotion backend | `remotion/` + `render/remotion_backend.py` | **Keep** | Already per-segment; ideal for the editor. Scene components (TitleCard, BrandedOutro) extend cleanly. |
| Pipeline + event stream | `src/clipwright/pipeline.py` | **Keep, generalize** | Convert from "linear build" model to "operation graph"; events already typed. |
| Caching pattern | `src/clipwright/generate/cache.py` + TTS cache | **Keep, extend to all stages** | SHA-256 sidecar pattern is the right one. Cover caption + camera + render. |
| Generative providers (Veo, Runway, DALL·E) | `src/clipwright/generate/` | **Keep, demote to P2** | BYOK pattern is correct. Reattach when scene-slot UI exists. |
| `inspire` brand extraction | `src/clipwright/inspire/` | **Keep, demote to P1** | Reattach via "Import brand from URL" in title-card editor. |
| Playwright recorder | `src/clipwright/record/` | **Keep as a first-class project creation mode** | "Record with Claude" is one of two equal entry points (see §6.1.a). Exposed as a Tauri command; the existing Python recorder is unchanged. |
| `browse-plan.json` schema | `src/clipwright/plan/schema.py` | **Keep as the authoring format for Record mode** | Lives at project root for Record projects; edited inline in the UI or by Claude. Headless CI/CLI flow is unchanged. |
| Chapter → segment logic | `src/clipwright/edit/segments.py` | **Keep, hot path for Record mode** | Drives the seeding of `timeline.json` from `moments.json`. |
| CLI `build` orchestrator | `src/clipwright/cli.py` (build command) | **Retire from desktop path; keep for CLI users** | Editor is not linear; it's event-driven. CLI users still benefit. |
| `clipwright doctor` / `status` | `src/clipwright/cli.py` | **Surface in UI** | Settings → System tab consumes these. |
| Outro PIL renderer | `src/clipwright/outro/` | **Keep as fallback** | Remotion BrandedOutro is the primary; PIL outro when no brand. |
| `desktop/` Tauri scaffold | `desktop/` | **Throw away and restart properly** | It's an empty default scaffold; no source. Start clean with the data model from §5 in mind. |
| Skill (`SKILL.md`) | repo root | **Keep, retarget** | Rewrite around the new project layout in §5. The clipwright skill remains how Claude understands the project. |

**Verdict:** ~70% of the existing Python carries over essentially unchanged. The desktop is greenfield. The skill needs a rewrite. The CLI surface contracts (fewer commands, more library functions).

---

## 11. Migration Plan: From Today's Code to MVP

### Phase 0 — Foundations (1–2 weeks)

Make the existing code editor-ready without building UI yet.

- **0.1** Define `project.json` + `timeline.json` schemas in `src/clipwright/schema/v1/`. Pydantic models. Migration scaffolding for `schema_version`.
- **0.2a** Write `import_video.py`: takes an MP4, runs silence + scene detection, emits a seeded `timeline.json`. New CLI: `clipwright import <video>`.
- **0.2b** Refactor existing recorder so `clipwright record --plan browse-plan.json` writes directly into the new project layout (`sources/main.mp4`, seeds `timeline.json` from chapters). No new UI work — this stays headless-friendly.
- **0.3** Refactor `composer.py` to expose `render_segment(project, seg_id) -> Path` as the primary entry. The current end-to-end render becomes a thin wrapper.
- **0.4** Extend the cache sidecar pattern (already in TTS + generate) to caption and render outputs. Every stage: `hash(inputs) → cached_output | recompute`.
- **0.5** Add `clipwright agent prompt <seg_id>` that prints the segment-scoped system prompt to stdout. Lets us iterate on the prompt without UI.

**Exit criterion:** from CLI alone, you can: `clipwright import demo.mp4 && clipwright render-segment seg_003` and get a single-segment MP4. The project directory matches §5.

### Phase 1 — Desktop MVP (3–5 weeks)

Build the UI. Reuse the Phase 0 backend via subprocess.

- **1.1** Tauri scaffold. React + TypeScript. Tailwind or shadcn/ui. State management: Zustand or signals.
- **1.2** Project open/create flow with **two equal modes: Record and Upload** (§6.1). File watcher. The Record mode includes: the "Describe your demo" wizard, the inline `browse-plan.json` editor, the Record/Re-record buttons, and the live browser-window-during-recording.
- **1.3** Three-region layout (preview / inspector / timeline / chat). Static first.
- **1.4** Timeline with select/trim/split/delete. Reads `timeline.json`, writes via subprocess `clipwright timeline edit ...`.
- **1.5** Inspector accordion (start with VO + Trim groups; Captions/Camera/Annotations in 1.6). Expand-state persisted per-segment per §F-INS-6.
- **1.6** Caption + Camera + Annotation editors.
- **1.7** Preview player (per-segment MP4 cache).
- **1.8** Claude chat panel — Mode A persistent session first.
- **1.9** "Ask Claude" segment-scoped invocations — Mode B.
- **1.10** Render dialog → `out/final.mp4`. Progress via event stream.

**Exit criterion:** Maya's journey in §3.2 works end-to-end on macOS.

### Phase 2 — Polish & expansion (post-MVP)

- Brand extraction reattach (`inspire` → title-card editor).
- Generative scene slots (Veo/Runway/DALL·E).
- VibeVoice multi-speaker / dialogue mode.
- Windows build.
- Voice library UI with previews.
- Annotation overlay templates beyond click-ripple/highlight.

---

## 12. Phased Delivery Summary

| Phase | Scope | Duration | Exit |
|---|---|---|---|
| **P0** | Backend refactor: schemas, import, per-segment render, cache everywhere | 1–2 wk | CLI produces single-segment MP4s; project dir matches §5 |
| **P1.a** | Tauri shell + New Project flow (Record + Upload) + timeline + preview (no Claude chat yet) | 2 wk | Both entry paths work end-to-end: drag-drop video → timeline; describe demo → plan → record → timeline. Trim + render works. |
| **P1.b** | Inspector accordion (VO, Captions, Camera, Annotations, Trim) + Doctor panel + empty states | 2 wk | Manual editing of all segment properties works; first-run experience matches §6.9 |
| **P1.c** | Claude chat panel + segment-scoped Ask Claude + file watcher | 1 wk | Maya's journey passes end-to-end |
| **P2** | Brand reattach, generative scenes, VibeVoice, Windows | open | — |

**Total to MVP: 6–8 focused weeks** if working ~half-time. The risk is scope creep within phases (don't add the second timeline track in P1.a). The unlock is shipping P1.c, because that's the moment "Claude Code video editor" becomes a real, demoable thing.

---

## 13. Open Questions & Decisions Needed

These need answers before P0 starts. None block writing this SRS, but they all surface in the first sprint.

| # | Question | Recommendation |
|---|---|---|
| Q1 | Frontend stack: vanilla React + shadcn vs. SolidJS vs. Svelte? | **React + shadcn/ui.** Largest ecosystem, Claude Design output is React-friendly. |
| Q2 | State management: Zustand, Jotai, Redux, signals? | **Zustand.** Minimal boilerplate; pairs well with file-watcher-driven reloads. |
| Q3 | Timeline rendering: HTML divs, Canvas, WebGL? | **HTML divs with `transform: translateX`** for v1. Canvas only if perf demands it past ~50 segments. |
| Q4 | Preview player: `<video>` with src swap, or HLS, or Remotion Player? | **`<video>` with per-segment MP4 cache** for v1. Remotion Player is overkill; HLS is overkill. |
| Q5 | Should we ship our own `claude` binary or require user-installed? | **Require user-installed.** Smaller bundle; respects their auth; their API key spend is their visibility. |
| Q6 | Whisper transcript: whisper.cpp (Metal) or faster-whisper (CTranslate2)? | **faster-whisper** — already a Piper dep, single codepath. |
| Q7 | History/undo: file snapshots vs. JSON patch log? | **File snapshots in `.clipwright/history/`** — dead simple, easy to inspect, easy to revert. |
| Q8 | License model: stay MIT or change for the desktop? | **Stay MIT.** Differentiator is product quality, not licensing. |
| Q9 | Naming: keep "Clipwright" for the desktop product or rename? | **"Clipwright Studio"** for the desktop, "Clipwright" alone keeps meaning the CLI/skill. |

---

## 14. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tauri/React learning curve eats P1.a | Med | Med | Spend 2 days on a throwaway prototype before committing to layout decisions |
| Claude Code subprocess UX is laggy or its stream-json format changes | Low | High | Pin a known-good `claude` version in docs; build a thin adapter layer in `agent/` so we can swap if needed |
| Per-segment cache invalidation bugs cause "why didn't it update" pain | High | Med | Invest in cache observability early — `clipwright cache status` shows hashes; UI surfaces stale state visually |
| Scope creep into "real video editor" features (transitions, color, multi-track) | High | High | Treat §2.2 Non-Goals as a literal gate. New feature requires deleting one. |
| The pivot loses CLI users who liked the existing `clipwright build` flow | Med | Low | The `build` command stays. The desktop is additive. |
| Auto-segmentation produces bad cuts and feels worse than starting with one segment | Med | Med | Ship with a `--no-auto-segment` option; let users opt in. Measure with real videos in P0. |
| Remotion render quality differs from ffmpeg path → confusing for users | Low | Med | One backend is the default (Remotion); the other is `--backend ffmpeg`. Document parity carefully. |

---

## 15. Success Metrics (post-MVP)

We are not building this to gather telemetry. But the project has succeeded if, qualitatively:

1. You (lucien) can replace your current Loom + iMovie workflow with it for shipping demos.
2. A second indie dev installs it, ships a video, and re-renders it after a UI change without re-importing.
3. "Ask Claude on this segment" works well enough that you reach for it before you reach for the manual editor.

If 1 + 2 happen, this is a viable product. If 3 happens, this is a *novel* product.

---

## 16. Telemetry & Privacy

The shortest meaningful section in this SRS, because the policy is short.

- **Default: no telemetry.** Zero events leave the device unless the user explicitly opts in (Settings → Telemetry → on).
- **If enabled (post-MVP):** an anonymous-id'd event stream covering: app launch, project created (Record vs Upload), render started/completed, doctor failures by category. No project content, no file paths, no transcript text, no API responses. Sent to a self-hosted endpoint, not a third-party SaaS.
- **Crash reports:** opt-in only. Bundled as a `.zip` the user explicitly chooses to send.
- **No analytics SDKs in the bundle.** Adding one requires changing this section.
- **Privacy notice** is a single page in the repo + Settings dialog. No tracking-consent banner.

---

## 17. Build, Distribution & Update

### 17.1 Build pipeline

- **Tauri build** produces a universal macOS `.dmg` (arm64 + x86_64) via `tauri build --target universal-apple-darwin`. Windows: `.msi` via `tauri build --target x86_64-pc-windows-msvc` (P2). Linux: `.AppImage` (P2).
- **Embedded Python compute layer.** Two options, decision deferred:
  - **Option A (preferred):** ship the Python source + a sidecar `python3` via PyOxidizer or `python-build-standalone`. ~60 MB cost, zero user-side install.
  - **Option B:** require user-installed Python ≥ 3.10 (matches current CLI). Smaller bundle, more install friction.
  Recommendation: A for v1.0; B for an internal dev build.
- **Models lazy-download on first use.** Kokoro (~2 GB) only when the user picks it. Stored under `~/.clipwright/models/`. Status visible in the Doctor panel.
- **Reproducible builds:** CI tag → GitHub Releases. Hashes published. Notarized on macOS, signed on Windows (post-MVP code-signing certificate cost ~$300/yr — defer until first user complains).

### 17.2 Releases & versioning

- Semver: `MAJOR.MINOR.PATCH`. Schema version in §5 is independent.
- Pre-1.0: every release allowed to break disk format with a one-shot migration step. Post-1.0: schema migrations are forward-only and tested with golden fixtures.
- Channels: `stable` and `beta`. No `nightly` v1.

### 17.3 Auto-update

- **In-app update notice**, not silent forced update. On launch, compare current version to the latest GitHub release tag; if newer, show a non-blocking toast in the Hub: *"Clipwright Studio 0.4.0 is available — see what's new"*.
- **One-click "Update now"** downloads the installer; the user re-runs it manually. No background install. Matches Linear, Raycast.
- **Opt-out:** Settings → Updates → "Don't check for updates."

---

## 18. Testing Strategy

Three tiers; each catches a distinct class of regression.

### 18.1 Unit tests (Python)

- Already present: 101 tests covering schema, TTS providers, captions, segments, generate cache, etc.
- **New required for MVP:** tests for `import_video.py` segmentation heuristics, `render_segment` cache invalidation, the Tauri command-channel adapter.
- Run on every PR via GitHub Actions; <10s total target.

### 18.2 Frontend tests (TypeScript)

- **Vitest** for component logic: timeline math, accordion state machine, file-watcher debounce.
- **Playwright (the test framework, not the recorder)** for end-to-end UI flows:
  - Hub → New Project → Upload → see segments
  - Hub → New Project → Record → plan editor → simulated record → see segments
  - Open project → select segment → Ask Claude (with a mocked `claude` binary) → file watcher reconciles UI
- Headless in CI; <2 min total target.

### 18.3 Golden-frame render tests

- A fixture project ships in `tests/fixtures/golden-project/`. The render output's first frame, midpoint frame, and last frame are pixel-hashed.
- CI fails if any of those hashes drift. Encoder updates that legitimately change output get a one-line PR description explaining the regen.
- Audio: a hash of the final MP3 sample stream after normalization.
- This is the only safety net against "we shipped an `ffmpeg` change and every video now has shifted captions" — a real risk given the production-correctness rules in SKILL.md.

### 18.4 Manual QA checklist (per release)

A short Markdown checklist in `docs/qa-checklist.md` covers what unit + e2e can't: voice quality A/B against last release, render speed on a known fixture, install-from-scratch on a fresh user, doctor passes on a clean machine. Run before tagging.

---

## 19. Logging & Observability

### 19.1 Where logs go

- **Desktop logs:** `~/Library/Logs/Clipwright Studio/app.log` (macOS) / `%LOCALAPPDATA%\Clipwright Studio\logs\app.log` (Windows). Rotating, 10 MB × 5 files.
- **Python subprocess stderr** is captured by the desktop and prepended with the operation id; appears in the same `app.log`.
- **Per-project run log:** `<project>/.clipwright/runs/<timestamp>.log` — every stage invocation, every Claude session, every render. Last 50 retained.

### 19.2 Log levels

- `ERROR` — operation failed; user-visible
- `WARN` — operation succeeded with caveats (cache miss, fallback used)
- `INFO` — stage transitions, file writes
- `DEBUG` — wire-level (ffmpeg cmds, Claude stream events). Off by default; toggled by `CLIPWRIGHT_DEBUG=1` env var.

### 19.3 Surfacing in the UI

- Status bar already surfaces health (§8.5.6).
- **"View logs" link** in the Doctor panel opens the `app.log` in the OS default text editor.
- **"Diagnose this segment" affordance** in the inspector's right-click menu writes a focused log bundle (last render, last TTS call, last Claude session for that segment) and opens it for sharing.

### 19.4 Observability principle

Every user-visible failure should map to a single log line tagged with the operation id printed in the error toast. Searching that id in the log finds the full trace. No exception is acceptable.

---

## 20. Security Model

The threat model is small because the architecture is small: a local app editing local files.

### 20.1 Trust boundaries

| Boundary | Who's trusted | What's controlled |
|---|---|---|
| Project directory | User | Read/write within the project |
| User home directory outside project | User | Read-only (recents, settings, models) |
| Network | Untrusted | Only outbound, only to provider endpoints the user configured |
| Claude subprocess | User-installed binary | `--cwd <project_dir>` confines its filesystem reach |

### 20.2 Secrets

- API keys (ElevenLabs, OpenAI, Runway, Google Vertex) are stored in the **OS keychain** (macOS Keychain, Windows Credential Manager), never in `project.json` or any project file.
- Keys are read at provider-invocation time and passed via env vars to the subprocess. They never appear in logs (logger redacts any env var matching `*_API_KEY`).
- The keychain entry name is namespaced: `clipwright.<provider>`. Removing the app removes the entries.

### 20.3 Filesystem confinement

- The desktop's Tauri config grants filesystem access only to:
  - The project directory the user has opened (allowlist updated when a project loads)
  - `~/.clipwright/` (settings, recents, models, onboarding state)
  - The OS-standard temp directory (for atomic-write tmp files)
- Anything outside requires a native file picker (user-mediated).
- The Python subprocess inherits a `CLIPWRIGHT_PROJECT_DIR` env var and refuses to write outside it. (Code-level invariant, asserted in I/O helpers.)
- Claude subprocess is spawned with `--cwd <project_dir>`; its file tools operate from there. (User can still grant tools that escape if they configure their own Claude tools, but we don't add any.)

### 20.4 Network safety

- TTS / generate provider calls go directly from the desktop or Python subprocess to the configured endpoint. No clipwright-hosted proxy.
- Outbound endpoints are listed in `docs/network-endpoints.md` and surfaced in the Doctor panel.
- The auto-update check hits `api.github.com/repos/<org>/clipwright/releases/latest`. This is the only endpoint clipwright ever calls on its own behalf.

### 20.5 What's explicitly out of scope

- No DRM, no content fingerprinting, no upload-to-third-party warnings beyond the existing provider docs.
- No sandboxed plugin system. (Provider extensions, if any, require a code change + reinstall.)

---

## Appendix A — Glossary

- **Segment:** an editable unit on the timeline. Has a single source range, optional VO, captions, camera, annotations. Identified by stable `seg_NNN` id.
- **Chapter:** a logical grouping of contiguous segments. Display-only; used for navigation, labeling, and (in Record mode) seeding the initial segmentation.
- **Clip:** the rendered MP4 output of a single segment (cached under `out/segments/<seg_id>.mp4`).
- **Scene:** a non-recording segment — title card, b-roll, outro. May be `kind="scene"` (PIL/Remotion-rendered from project data) or `kind="generated"` (Veo/Runway/DALL·E output).
- **Project:** the directory on disk holding everything for one video. Defined in §5.1.
- **Workspace:** the editor view inside the desktop app, as opposed to the Project Hub. Defined in §8.5.
- **Hub:** the landing view that lists recent projects and offers New / Open. Defined in §8.3.
- **Inspector:** the per-segment editing panel; a vertical accordion with five property groups. Defined in §8.5.3.
- **Claude rail:** the always-visible chat panel on the right edge of the workspace. Defined in §8.5.5.
- **Skill:** the Claude Code skill at `~/.claude/skills/clipwright` that teaches Claude the project format and editing primitives. Loaded into every Claude invocation from the workspace.
- **Mode A / Mode B:** two ways the desktop spawns `claude` — persistent chat session (A) and one-shot scoped invocation (B). Defined in §9.1.
- **Record mode / Upload mode:** the two equal entry points for creating a project. Defined in §6.1.
- **Doctor:** the system-health panel that checks ffmpeg, Python, Claude binary, providers, etc. Defined in §6.8.
- **EDL:** edit-decision list — what `timeline.json` is, in classical NLE terminology.
- **Sidecar cache:** a `.cache.json` file next to a generated artifact, holding the input hash and tool version. See §5.8.
- **BYOK:** "bring your own key" — provider API credentials supplied by the user, never bundled or proxied. Applies to generative providers (§6.1 of clipwright today) and to all future paid providers.
- **BYOC:** "bring your own compute" — the same idea applied to inference endpoints (e.g. VibeVoice hosted on the user's Modal/RunPod). Defined in §1.

## Appendix B — File reference index (current code)

For implementers planning Phase 0 refactors. Paths relative to repo root.

- TTS provider ABC: [src/clipwright/tts/base.py](src/clipwright/tts/base.py)
- Pipeline + events: [src/clipwright/pipeline.py](src/clipwright/pipeline.py)
- Generate cache pattern: [src/clipwright/generate/cache.py](src/clipwright/generate/cache.py)
- Caption chunker: [src/clipwright/captions/chunker.py](src/clipwright/captions/chunker.py)
- Composer (per-segment refactor target): [src/clipwright/render/composer.py](src/clipwright/render/composer.py)
- Remotion entry: [remotion/src/Video.tsx](remotion/src/Video.tsx)
- Playwright recorder: [src/clipwright/record/playwright_recorder.py](src/clipwright/record/playwright_recorder.py)
- Brand extraction: [src/clipwright/inspire/extractor.py](src/clipwright/inspire/extractor.py)
- Current CLI: [src/clipwright/cli.py](src/clipwright/cli.py)
- Current skill: [SKILL.md](SKILL.md)

---

*End of SRS v1.*
