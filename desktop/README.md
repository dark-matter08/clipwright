# Clipwright Studio (desktop)

Tauri 2 + React + TypeScript + Tailwind + Zustand. The desktop shell for
Clipwright projects, per [`SRS.md`](../SRS.md) §8.

## Phase 1.1 status

End-to-end loop working: Hub → folder picker → Rust reads `project.json`
+ `timeline.json` → Workspace renders the timeline.

Interactive editing, preview playback, Claude rail, and the New Project
wizard land in P1.2–P1.9.

## Run

```
bun install         # first time
bun run tauri:dev   # dev mode with HMR
bun run tauri:build # bundled production app
```

Or, frontend only (no Tauri shell), useful for layout iteration:

```
bun run dev
```

## Layout

- `src/` — React app
  - `App.tsx` — Hub vs Workspace switcher
  - `components/` — one file per region (Hub, Workspace, TopBar, Preview,
    Inspector, Timeline, ClaudeRail, StatusBar)
  - `lib/` — types, Tauri command wrappers, Zustand store, `cn()` helper
- `src-tauri/` — Rust backend
  - `src/lib.rs` — Tauri builder + command handlers
  - `src/project.rs` — `open_project` command
  - `src/recents.rs` — `~/.clipwright/recents.json` persistence
- `tailwind.config.ts` — visual language tokens per SRS §8.7

## Tauri commands

Single source of truth: `src/lib/tauri.ts` (frontend) ↔ `src-tauri/src/`
(backend). Every cross-process call goes through `lib/tauri.ts`; no
`invoke()` with magic strings in components.
