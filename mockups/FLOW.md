# Clipwright — page flow & transitions

_A chronological map of every screen, what triggers the move to the next, and where the current app has gaps._

---

## The single source of truth: one project → many videos → many clips

Clipwright's data model is three tiers:

- A **project** is a folder with `.clipwright.json` + `videos/<slug>/...`.
- A **video** is one renderable timeline (its own pipeline, segments, script, final.mp4).
- A **clip** is one narration block inside a video (one row in `script.json`).

Every screen is anchored to exactly one of those tiers. If you keep that hierarchy in mind, the flow writes itself.

---

## The app only has two top-level screens

There are **two top-level routes**, determined entirely by whether a project is open:

1. **ProjectPicker** — shown when `project === null`.
2. **Workspace** — shown when `project !== null`.

Everything else — clip detail, file viewer, final-render preview, timeline editor — is a **sub-view of Workspace**, switched in-place via Workspace state. There is no route swap, no unmount of the outer shell, no loss of navigation context.

That rule is what makes the app feel coherent: once a project is open, you never leave the Workspace shell.

---

## Screen 1 — ProjectPicker (no project open)

**Route.** `App.tsx` renders this whenever `project === null`. It's the app's cold-start screen.

**Purpose.** Choose or create a project.

**Key elements.**
- Hero + CLIPWRIGHT wordmark
- Three action cards: **New Project**, **Open Folder** (⌘O), **Clone from URL**
- "Recent" grid (last 8, sorted by last-open)
- Claude auth status pill (bottom-right)

**Exits.**
- Click a recent card, open via ⌘O, or complete "New Project" form → **Screen 2 (Workspace)** with `project` set.
- "Clone from URL" → currently stubbed with an inline error. When wired: clone into the user's Documents, then fall into **Screen 2**.

**Gap to close.**
- Hide the left `ProjectRail` on this screen — its list and the "RECENT" grid are duplicates when no project is open. Show the rail only once a project is loaded.
- Add a keyboard shortcut list at the footer (`⌘O` open, `⌘N` new, `⌘K` clone).

---

## Screen 2 — Workspace (project open)

**Route.** `App.tsx` when `project !== null`. This is the only project-level route.

**Purpose.** The everyday dashboard. One project, every video, every clip, every pipeline run, every Claude session — all on one canvas. The outer shell stays mounted for the entire session; only the center column changes.

**The outer shell (always visible while a project is open).**
1. **ProjectRail** — leftmost sidebar, switch between projects.
2. **Titlebar** — project name, path, aspect/fps chips, `CLOSE`, **mode toggle (`DETAIL | TIMELINE`)**.
3. **VideoRail** — tabs per video, `+ NEW VIDEO` to scaffold one, per-tab edit glyph to jump into Timeline mode.
4. **Left aside** — `PipelineBar` → `ClipList` → `FilesPane`.
5. **Right column** — `SessionsPane` + `ChatDock`.
6. **LogPane** — under the center column, shared across all modes.
7. **Footer** — voice/tts/caption pills, run status, video count, Claude heartbeat.

**The center column is the one thing that changes.** Workspace holds a `mode: "detail" | "timeline"` state. The center column's content is a function of `(mode, selectedClip, openFile, hasFinal)`:

| mode | selectedClip | openFile | hasFinal | Center renders |
| --- | --- | --- | --- | --- |
| `detail` | — | set | — | `FileViewer` |
| `detail` | set | — | — | `ClipDetail` |
| `detail` | — | — | true | `FinalRenderPane` (see Sub-view C) |
| `detail` | — | — | false | `EmptyCenter` (coaches the next pipeline step) |
| `timeline` | any | any | any | `TimelineMode` (see Sub-view D) |

All of the following are **sub-views of Workspace**, not separate routes. They render inside the center column while everything else stays put.

---

### Sub-view A — ClipDetail (mode=`detail`, clip selected)

Form-style editor for a single clip: chapter, target seconds, hint, narration textarea, audio waveform with play controls, synthetic/real caption preview, and the action row (SAVE / REGEN AUDIO / REGEN CAPTIONS / RE-RENDER).

**Entry.** Click a clip in `ClipList`.
**Exit.** Click a different clip, click a file, flip to `timeline` mode, or close the project.

---

### Sub-view B — FileViewer (mode=`detail`, file selected)

Plain text viewer (pretty-prints JSON) for any artifact under the project. Used to inspect `segments.json`, `script.json`, `camera.json`, captions, etc.

**Entry.** Click a file in `FilesPane`.
**Exit.** Click its close button, click a clip, flip to `timeline` mode.

---

### Sub-view C — FinalRenderPane (mode=`detail`, nothing selected, `hasFinal === true`) — PROPOSED

Large `<video>` preview of `out/final.mp4`, aspect-constrained per `project.config.aspect`. Meta strip: duration, filesize, clip count, render timestamp. Three actions: `OPEN IN TIMELINE` (flips mode), `REVEAL IN FINDER`, `RE-RENDER`.

**Entry.** Deselect any clip and file while a final render exists.
**Exit.** Select a clip/file or flip to timeline mode.

**Gap to close.** Does not exist today — the `EmptyCenter` placeholder is shown instead. This is the most visible deviation from the mockup plan.

---

### Sub-view D — TimelineMode (mode=`timeline`) — the editor, as a sub-view

The "video editor" is just another center-column mode, not a separate screen. It keeps the entire outer shell — ProjectRail, Titlebar, VideoRail, left aside (incl. ClipList), SessionsPane, ChatDock, LogPane, Footer — so users retain every navigation affordance while fine-tuning.

**What the center column becomes.**
- **TransportBar** — timecode, SkipBack / Rewind / Play-Pause / FastForward / SkipForward, Select/Cut/Magnet tool toggles, `RENDER` / `EXPORT`.
- **PreviewPane** — HTML5 `<video>` in an accent-glow frame, aspect-constrained.
- **Timeline** — multi-lane V1 (clip blocks), A1 (voice waveform), A2 (music bed), C1 (caption chunks), KEY (camera keyframe diamonds + bezier zoom curve), ruler with 1s ticks / 5s labels, playhead triangle.
- **MiniInspector** — narration textarea + REGEN AUDIO / REGEN CAPTIONS / RE-RENDER CLIP docked under the timeline, bound to whatever clip is currently selected in `ClipList`.

**What is removed from the old full-screen editor, and why.**
- The editor's **own titlebar**: redundant — the Workspace titlebar already has name, path, aspect/fps, close.
- The editor's **LibraryRail** (VIDEO/AUDIO/TEXT/FX tabs): redundant — the `ClipList` in the left aside already indexes this video's clips.
- The editor's full **Inspector**: redundant — its narration edit and regen actions now live in `MiniInspector` under the timeline, and the full-detail form is still one mode-toggle away in `ClipDetail`.

**Entries to timeline mode.**
- Click **`OPEN EDITOR ›`** in `PipelineBar` (gated on `video.hasSegments`) → `setMode("timeline")`.
- Click the **pencil icon on a VideoRail tab** (new) → selects that video AND sets mode to timeline.
- Press **`⌘E` / `Ctrl+E`** → toggles timeline mode.
- Click **`OPEN IN TIMELINE`** from FinalRenderPane.
- Click the `DETAIL | TIMELINE` toggle in the titlebar.

**Exits from timeline mode.**
- Press **`Escape`** or click the toggle → `setMode("detail")`.
- Click a file in `FilesPane` → auto-exits to `detail`, shows `FileViewer`.

**Shared state while in timeline mode.**
- Selecting a clip on the `Timeline` or in `ClipList` updates the same `selected` state — flipping back to `detail` shows that same clip in `ClipDetail`, and vice versa. No context loss across mode flips.
- Regen actions in `MiniInspector` call the same IPC as `ClipDetail` — same logs stream to `LogPane`.

---

## Workspace state reference

| State | Type | Purpose |
| --- | --- | --- |
| `mode` | `"detail" \| "timeline"` | Which family of sub-views the center column renders. |
| `activeSlug` | `string \| null` | Which video the VideoRail has selected. |
| `activeVideo` | `VideoState \| null` | Loaded data for `activeSlug`. |
| `selected` | `string \| null` | Clip id shared between `ClipList`, `ClipDetail`, `Timeline`. |
| `openFile` | `{abs, rel} \| null` | File open in `FileViewer`. Non-null forces mode to `detail`. |
| `activeRun` | `number \| null` | Running pipeline process id. Drives footer spinner + LogPane. |
| `progress` | `{stage, pct} \| null` | Live progress from `onProgress`. |
| `logs` | `string[]` | Rolling log buffer fed from `onLog`. |

---

## The canonical chronological flow

```
1. Launch app
       ↓
2. Screen 1 — ProjectPicker
   → click "New Project" → fill form → CREATE
       ↓
3. Screen 2 — Workspace opens, outer shell mounts once.
             Everything below is center-column state transitions.
   → VideoRail is empty → click "+ NEW VIDEO"
   → video scaffolded, "main RECORD" tab appears, selected
   → center (mode=detail, no clip, no final) → EmptyCenter: "run RECORD to capture browse-plan"
   → click BUILD → Record      (stage 1)
   → click BUILD → Segments    (stage 2)   → hasSegments = true, OPEN EDITOR & ⌘E unlock
   → click BUILD → Keyframes   (stage 3)
   → click BUILD → Script init (stage 4)   → clips appear in ClipList
   → click a clip → Sub-view A (ClipDetail) — edit narration, SAVE
   → click TTS → audio written → waveform appears in ClipDetail
   → click CAPTION → captions JSON written → chunks appear in ClipDetail
   → click RUN ALL → chains remaining stages → final.mp4 written → hasFinal = true
   → deselect clip → Sub-view C (FinalRenderPane) — preview final.mp4
   → click OPEN IN TIMELINE (or press ⌘E)  — mode flips to timeline, shell stays put
       ↓
4. Sub-view D — TimelineMode (still Screen 2, mode=timeline)
   → scrub timeline, pick a clip — ClipList highlights the same clip
   → MiniInspector under the timeline shows narration + regen buttons
   → click REGEN AUDIO / REGEN CAPTIONS / RE-RENDER CLIP
   → LogPane streams output (still visible, same log buffer as detail mode)
   → press Escape → mode flips back to detail, clip selection preserved
       ↓
5. Back to Sub-view A (ClipDetail) on the same clip — zero context loss.
   Ready for next pipeline iteration or the next video.
```

Every subsequent session starts at step 2 (recent project in ProjectPicker → Workspace) and picks up wherever the pipeline left off — the state chips on each VideoRail tab tell you at a glance, and the previous `mode` / `selected` / `activeSlug` can be persisted per project.

---

## Concrete implementation diff to fix the coherence issues

Ordered by impact. Each item is a ~30–80-line change; none require backend/IPC work.

1. **Collapse `VideoEditor` into a Workspace sub-view.** Delete the `View` union in `App.tsx`. Move the editor's Transport / Preview / Timeline / MiniInspector out of `routes/VideoEditor.tsx` into `components/timeline/` and embed them in Workspace behind `mode === "timeline"`. Drop the editor's own titlebar and LibraryRail — they're redundant with the Workspace shell.
2. **Add the `DETAIL | TIMELINE` mode toggle** to the Workspace titlebar, plus a pencil glyph on each VideoRail tab that sets `activeSlug` and `mode` in one click.
3. **Bind `⌘E` / `Ctrl+E`** in `App.tsx`'s existing key handler (symmetric with `Escape`) to toggle Workspace mode. (`Escape` in timeline mode returns to detail; in detail mode it's a no-op.)
4. **Build Sub-view C (FinalRenderPane).** Replace `EmptyCenter` when `activeVideo.hasFinal && !selectedClip && !openFile`. Reuse the `PreviewPane` component from the timeline so both modes look identical.
5. **Suppress `ProjectRail` on the ProjectPicker screen.** In `App.tsx`, render the rail inside the `project ? … : …` branch, not outside it.
6. **Coach the RECORD-stage empty state.** In `EmptyCenter`, branch on `activeVideo.phase`: if `phase === "record"`, show `Click "BUILD → Record" to capture browse-plan.json`.
7. **Unify footers.** Move the Claude-ready pill into the Workspace footer so it's always visible once the app is open. Keep ProjectPicker's bottom-right pill for the no-project state.
8. **Persist `mode` + `selected` + `playhead` per project.** Write to `.clipwright.json` (or a sibling `ui-state.json`) so reopening a project resumes the exact view it was in.
