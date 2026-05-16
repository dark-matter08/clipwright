# Design System — Clipwright Studio

## Product Context

- **What this is:** Tauri + React desktop video editor with an AI
  collaborator (Claude Code) in the rail. Edits short-form video
  via a segment-based timeline plus a Remotion render pipeline.
- **Who it's for:** Indie creators producing demo videos and recap
  edits (product walkthroughs, manhwa recaps, screen recordings).
- **Space:** Adjacent to CapCut / Premiere on one side and
  Linear / Raycast / VS Code on the other. We lean toward the
  latter — calm, technical, dense.
- **Memorable thing:** _A video editor that reads more like a code
  editor than a Premiere clone._ Every design decision serves
  that thesis.

## Aesthetic Direction

- **Direction:** Industrial / Utilitarian, with a Brutalist edge —
  function-first, data-dense, monospace accents.
- **Decoration:** Minimal. Typography + per-lane tints do all the
  work. No decorative gradients, no soft shadows beyond `shadow-sm`
  on focused elements, no rounded-everything.
- **Mood:** Serious software for serious work. The user is a
  builder; the chrome stays out of their way.
- **Anti-patterns we deliberately avoid:** purple-gradient hero
  vibes, centered everything, bubbly border-radius, system-font
  fallback as primary typography.

## Theming

Two themes — **light** and **dark** — implemented as twin CSS
variable sets in `desktop/src/styles/tokens.css`. Tailwind's
`darkMode: ["class", '[data-theme="dark"]']` toggles every
`dark:` utility off the same attribute, and the token variables
swap values when the attribute changes. **One source of truth.**

A third mode — **system** — is the default for first-launch users:
no `data-theme` attribute, the OS preference picks via
`prefers-color-scheme`. A live `matchMedia` listener keeps system
mode reactive to OS flips.

Theme is persisted to `localStorage["clipwright.theme"]` and
applied to `<html>` at module load (before React mounts) so the
first paint is already correct — no flash of the wrong theme.

UI control: the **ThemeToggle** segmented control in TopBar
(`Laptop / Sun / Moon` icons). Compact, labelled, lives next to
the settings cog.

## Typography

- **Sans (UI / body):** `Inter` with `-apple-system` /
  `BlinkMacSystemFont` / `Segoe UI` fallbacks.
- **Mono (timecode, ids, code blocks):** `ui-monospace` →
  `SFMono-Regular` → `Menlo` → `Monaco`. Monospace is a
  first-class citizen here — the timeline transport's
  `00:09.7 / 02:05.0` readout, segment ids, the data badges in
  the rail header. It signals "this is precise."
- **Scale:** tight. `xs(11)` → `sm(12)` → `base(13)` → `md(14)` →
  `lg(16)`. Nothing larger because nothing in the chrome warrants
  a hero size.

## Color Tokens

All values are HSL space-separated triplets in
`desktop/src/styles/tokens.css` and exposed through Tailwind as
`hsl(var(--name) / <alpha-value>)` so opacity modifiers
(`bg-accent/15`, `border-warn/40`) compose for free.

### Surfaces — elevation hierarchy

| Token              | Light                 | Dark                  | Use |
|--------------------|-----------------------|-----------------------|-----|
| `bg` (`--surface-base`)  | `220 22% 96%`   | `216 16% 6%`    | Page background |
| `bg-subtle` (`--surface-subtle`) | `220 24% 92%` | `216 14% 10%` | Sidebars, rails |
| `surface` (`--surface`) | `0 0% 100%` | `220 12% 13%` | Cards, panels |
| `bg-raised` (`--surface-raised`) | `220 30% 99%` | `216 12% 13%` | Hovered surfaces |
| `surface-overlay` (`--surface-overlay`) | `0 0% 100%` | `220 14% 11%` | Modal bodies |
| `bg-inset` (`--surface-inset`) | `220 18% 88%` | `216 16% 8%` | Code blocks, textareas |

### Borders

| Token            | Light            | Dark            | Use |
|------------------|------------------|-----------------|-----|
| `border`         | `220 14% 72%`    | `218 10% 18%`   | Default divider |
| `border-subtle`  | `220 16% 84%`    | `220 12% 14%`   | Quiet separator |
| `border-strong`  | `220 12% 52%`    | `220 8% 32%`    | Emphasized edge |

### Foreground

| Token            | Light            | Dark            |
|------------------|------------------|-----------------|
| `fg`             | `220 28% 12%`    | `216 10% 91%`   |
| `fg-subtle`      | `220 18% 28%`    | `216 10% 68%`   |
| `fg-muted`       | `220 12% 44%`    | `217 8% 46%`    |
| `fg-disabled`    | `220 10% 62%`    | `217 8% 32%`    |
| `fg-on-accent`   | `0 0% 100%`      | `220 25% 8%`    |

### Accent (the brand cyan)

| Token            | Light             | Dark              | Use |
|------------------|-------------------|-------------------|-----|
| `accent`         | `188 90% 36%`     | `188 96% 53%`     | Primary CTA, playhead |
| `accent-hover`   | `188 95% 30%`     | `188 90% 47%`     | Hover state |
| `accent-active`  | `188 100% 24%`    | `188 88% 40%`     | Pressed state |
| `accent-soft`    | `188 80% 88%`     | `188 50% 18%`     | Tinted selection bg |
| `accent-soft-fg` | `188 90% 24%`     | `188 86% 78%`     | Text on `accent-soft` |

The accent shifts a notch darker in light mode to maintain AA
contrast on near-white surfaces. The hue is identical in both
modes so brand recognition is preserved.

### Status — info / ok / warn / danger

Each status color has three values: filled (`--name`), soft
(`--name-soft` — tinted background), soft-fg (`--name-soft-fg` —
text on the tinted background). The pattern matches the accent
family.

### Lanes (timeline tracks)

The timeline's three concurrent tracks each get a hue family:

- **Video** — blue (`217 91%` family).
- **Audio** — purple (`258 80–85%` family).
- **Captions** — amber (`38 92%` family).

Each lane has `--lane-<name>` (vivid accent for stripes / icons /
waveform bars), `--lane-<name>-bg` (lane floor), `--lane-<name>-border`
(clip-block border), `--lane-<name>-fg` (clip-block text).

This replaces ~16 hardcoded hex literals previously living in
`Timeline.tsx`'s `LANE_TINTS` and `TRACK_TINTS` records.

### Special

- `--playhead` — same hue as accent. The vertical line + diamond
  handle on the timeline.
- `--ring-focus` — same as accent. Focus rings throughout.
- `--render` / `--render-hover` / `--render-fg` — render CTA. Same
  as accent today but exposed as its own token in case we want
  the Render button to differentiate later.

## Spacing

- **Base unit:** 4px. Tailwind's default spacing scale (px-1
  through px-12) is used as-is.
- **Density:** compact. Dialog padding is `px-5 py-3`. Row gaps
  are typically `gap-1` to `gap-3`. The editor is dense by design
  — users want as much timeline visible as possible.

## Border Radius

- `sm` (4px) — chips, small badges, tags.
- `DEFAULT` (6px) — most controls, buttons, inputs.
- `lg` (8px) — modal cards.
- Full circles (`rounded-full`) — pill indicators, status dots.

## Motion

- **Approach:** minimal-functional. Animation is reserved for
  state transitions that improve comprehension.
- **Easing:** `ease-out` for entrances, `ease-in-out` for shifts.
- **Duration:** `120ms` (fast) / `150ms` (default) / `180ms`
  (slow). Slow is still fast.
- **Named keyframes** (see `tailwind.config.ts`):
  - `stepFade` (200ms) — wizard panel transitions.
  - `pillPulse` (240ms) — active step indicator on arrival.
  - `themeFade` (200ms) — page-wide fade around theme toggle.

## Migration Notes (this commit)

The token API was designed to maximize back-compat. The existing
Tailwind color names (`bg.*`, `border.*`, `fg.*`, `accent.*`,
`danger`, `warn`, `ok`) point at CSS variables now instead of
literal hex. Every component that used those tokens — about 30
files — gets light mode for free, zero migration required.

Migrations done explicitly:

- `Timeline.tsx` — `LANE_TINTS` and `TRACK_TINTS` records
  rewritten to use `bg-lane-video-bg` / `border-lane-video-border`
  / etc. instead of hardcoded hex strings.
- `index.css` — `theme("colors.border.DEFAULT")` calls replaced
  with `hsl(var(--border))` since the runtime CSS-var lookup is
  what actually theme-swaps.
- `main.tsx` — `./lib/theme` imported as a side-effect so the
  initial theme is applied before React mounts.

Things explicitly NOT changed:

- Modal backdrops (`bg-black/60`) — semi-transparent black
  works in both modes as page-darken.
- Preview pane's `<video>` element (`bg-black`) — videos look
  natural on black regardless of theme.

## Decisions Log

| Date       | Decision                                          | Rationale |
|------------|---------------------------------------------------|-----------|
| 2026-05-15 | Light + dark via twin CSS variable sets           | Single source of truth; opacity modifiers compose naturally via the HSL-with-alpha pattern |
| 2026-05-15 | Same accent hue in both modes, darker in light    | Brand recognition + AA contrast on light surfaces |
| 2026-05-15 | Per-lane timeline tints extracted to tokens       | Was 16+ hardcoded hex in Timeline.tsx; now theme-aware |
| 2026-05-15 | Three-state theme (system / light / dark)         | System default keeps existing dark-only users at parity while reactive OS-flip works for new users |
| 2026-05-15 | Theme provider initializes at module load         | Prevents flash of wrong theme on first paint |
| 2026-05-15 | Existing Tailwind names preserved (`bg`, `fg`...) | Zero-migration light-mode for ~30 existing components |
| 2026-05-15 | Light palette boosted (chroma + elevation deltas) | First pass felt monochromatic ("sea of gray-blue"); slate-tinted surfaces, wider elevation steps, vivid lane colors |
| 2026-05-15 | `@import` moved BEFORE `@tailwind` directives    | CSS spec requires imports first; PostCSS was silently dropping `tokens.css` so theme toggle had nothing to swap |
