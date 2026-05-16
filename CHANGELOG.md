# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — post-merge cleanup (waves 1-3)

A correctness sweep of the surface area that landed in the
`feat/stoic-hermann-16101f` merge plus the v2 desktop refactor.

**Wave 1 — agent-facing correctness**

- `SKILL.md`: full rewrite for the v2 schema + Clipwright Studio
  reality. The prior version still referenced `clipwright edit-plan`
  (renamed to `review`) and a single-video pipeline; agents reading it
  would emit commands that no longer exist. The new SKILL teaches the
  per-segment cached pipeline (`record-project`, `import`,
  `render-segment`, `render-final`, `tts-segment`, `caption-segment`),
  the v2 directory layout (`videos/<video_id>.json`,
  `out/segments/<video_id>/`), the two entry modes (Record vs Upload),
  and the Studio Mode-B contract.
- `script_skeleton._draft_text`: kill the
  "Introducing a new feature. Introducing a new feature. …" placeholder
  loop that shipped to TTS verbatim on empty hints. Returns empty so
  the agent/human is forced to write copy.
- `clipwright generate hero`: actually copy the generated PNG to
  `brand/hero.png` so the Remotion `TitleCard` scene picks it up. The
  prior docstring claimed a symlink that the code never wrote.
- `clipwright init`: restore browse-plan scaffold scroll `wait: 1.2`
  (had been bumped to 2.5 with no rationale).

**Wave 2 — security pass**

- Generative providers (Veo / Runway / DALL·E) now refuse to run
  without `--experimental`. They were shipping unverified: Veo polls
  the wrong long-running-op endpoint (`get_hyperparameter_tuning_job`),
  Runway's text-to-video path always calls `image_to_video.create`
  (400s without `prompt_image`). The gate fires before any filesystem
  or network work, with a clear "Refused — pass --experimental"
  message and exit 2.
- `desktop/src-tauri/src/claude.rs` — Play-button runner hardening:
  - Wider metacharacter rejection (`; & | ` $ < > \n \r \\ " ' ( ) { }`).
  - Argv tokens containing a `..` path segment are refused (defense
    in depth against future CLI changes that might open argv paths
    literally).
  - Compile-time-style invariant: a `#[test]` pins every
    `CLIPWRIGHT_RUN_PREFIXES` entry to a matching
    `Bash(<prefix>:*)` in `ALLOWED_TOOLS_FOR_ACCEPT_EDITS`. Drift
    between the two lists is now caught by CI, not by users.
- Schema healing (`normalize_v2_video_ids`) now writes an audit trail
  to `<project>/.clipwright/migrations.log` — one JSONL line per
  rename `{ts, kind, old, new}`. Idempotent: re-running on an already-
  normalized project does not duplicate log entries.

**Wave 3 — code quality**

- Three duplicate `_read_cache_hash` / `_write_cache` implementations
  (in `tts_segment`, `caption_segment`, `render_segment`) consolidated
  into `clipwright.cache`. Future schema changes to the sidecar shape
  land in one file.
- `clipwright/generate/dalle.py`: switch from deprecated
  `response_format="url"` (urllib download + temp file) to inline
  `b64_json`. One HTTP hop instead of two, no SSL/timeout pitfalls.
- `clipwright doctor`: new "Skill ↔ CLI sync" check parses SKILL.md
  for `clipwright <cmd>` mentions and flags any that don't resolve to
  a registered Typer subcommand. Catches future drift like the
  `edit-plan` rename.

**Test deltas:** 302 → 321 Python tests; 3 → 8 Rust tests. Lint clean.

### Added (Play button on `clipwright …` code blocks in chat)

**What's new:** when Claude's reply contains a fenced code block
with a `clipwright …` command (or its `uv run` / `uvx` /
`python -m` variants), the rail now renders an inline **Play**
button. Clicking it runs the command in the project's sandbox
and shows the stdout + stderr below the block. Successful runs
re-color the button green and let you re-run; non-zero exit
goes red and shows the error. Project state refreshes
automatically when the command completes.

**Why:** Claude often replies with "you'll need to re-render
seg_004 to pick up the change" followed by the exact command.
Previously the user had to copy-paste into a terminal. Now it's
one click, with output visible inline and the rest of the UI
syncing on completion.

**Security model:** the Rust runner (`run_clipwright_command`)
parses the command string itself — **no shell is invoked.**
It strips the recognized prefix (must be one of the documented
allow-list), tokenizes the remainder via `split_whitespace`,
and calls `Command::new(clipwright_bin).args(tokens)` directly.
Shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `<`, `>`)
are rejected up-front with a clear error. Pipes/redirects are
the user's job to run themselves in a terminal — surfacing this
explicitly avoids silently dropping their intent.

**Implementation:**

- **Backend** (`desktop/src-tauri/src/clipwright.rs`,
  `claude.rs`):
  - New `clipwright::run_with_output(args, cwd)` — like the
    existing `run` but doesn't error on non-zero exit (failed
    renders still print useful diagnostics).
  - New `claude::run_clipwright_command(project_dir, command)`
    Tauri command. Validates prefix, rejects metachars,
    tokenizes, runs, returns `CommandResult` with stdout,
    stderr, exit_code, duration_ms.
  - `CLIPWRIGHT_RUN_PREFIXES` const mirrors the agent-prompt
    shell allow-list — a comment in claude.rs notes the
    requirement to keep them in lockstep.
- **Frontend** (`desktop/src/lib/tauri.ts`,
  `desktop/src/components/MarkdownView.tsx`,
  `desktop/src/components/ClaudeRail.tsx`):
  - `runClipwrightCommand` wrapper + `CommandResult` type.
  - `MarkdownView` takes an optional `onRunCommand` prop; when
    set, its `pre` override walks children, extracts the code
    text, checks against `RUNNABLE_PREFIXES` (mirrors backend),
    and replaces the stock `<pre>` with a `RunnableCodeBlock`
    widget. Inline / non-runnable blocks render unchanged.
  - `RunnableCodeBlock` is its own stateful component with
    `idle | running | ok | error` states and inline output
    panes for stdout / stderr.
  - `ClaudeRail` defines `onRunCommand` that calls the Tauri
    command + then refreshes the project state (same pattern
    as the post-turn refresh below). Threaded through to
    `ChatBubble` (assistant messages only) and
    `LiveAssistantBubble`.
- **MarkdownView pre-vs-code intercept**: the runnable block
  REPLACES the `<pre><code>` wrapper rather than nesting
  inside it. Walking `children` is done with a small
  `extractCodeText` helper so a future rehype transform that
  inserts wrappers won't break detection.

### Fixed (Stale UI after Claude renders / mutates project files)

**What was broken:** Claude would render a final mp4, regenerate
TTS, edit `videos/<id>.json`, or add a new video — and the UI
wouldn't reflect any of it until the user manually closed and
reopened the project. The screenshot in the bug report shows
"No final render yet" in the Preview while the chat clearly
says "Done. Final video is at: out/final/…". The Tauri
commands that Claude invokes via subprocess (e.g.,
`clipwright render-final`) mutate disk; the frontend's
in-memory `project` state never knew to re-read.

**Fix:** the rail's `send()` function now refreshes project
state in its `finally` block — success OR error path. After
every Claude turn:

```ts
const fresh = await openProject(project.project_dir, videoId);
loadProject(fresh);
```

`loadProject` is the same store action `RenderDialog`'s explicit
post-render refresh uses; running it after every chat turn
cascades to every downstream consumer (Preview's
`finalAvailable` probe, Timeline tracks, Inspector segment
data, sidebar video count, etc.).

**Why one hook covers many places:** the chat rail is the
single entry point for Claude-driven disk mutations.
Direct-from-UI mutations (Inspector edits, segment ops via
keyboard shortcuts, the explicit Render dialog) already
refresh through their own Tauri commands that return fresh
`ProjectState`. The gap was specifically the chat path.

**Edge cases handled:**

- Errors caught silently (no toast on refresh miss) — a
  transient refresh failure shouldn't pile on top of whatever
  the user's looking at.
- `finally` runs on cancel/error too — partial mutations
  still get reflected.
- The Play button (new, above) wires through the same
  refresh, so clicking Play on a rendered command syncs the
  UI the same way.

### Added (Vendored Remotion best-practices skill, always invoked)

**What's new:** the repo now ships the Remotion team's
[`@remotion/skills`](https://github.com/remotion-dev/skills)
`remotion` skill, vendored at
`.claude/skills/remotion-best-practices/`. The Claude rail's
agent prompt is wired to **always** invoke this skill at the
start of any turn that touches Remotion code, so every project
created via Clipwright Studio gets the Remotion team's
domain-specific guidance baked into Claude's context without
the user having to remember to pre-select it.

**What the skill covers** (~4,000 lines across `SKILL.md` + 35
rule files): compositions, sequencing, timing, audio,
voiceover, captions (including SRT import + transcribe),
ffmpeg, silence-detection, trimming, transitions, text
animation, tailwind, fonts, 3D, GIFs, transparent videos, and
more. The headline rule: **CSS transitions and Tailwind
`transition-*`/`animate-*` classes DO NOT render correctly in
Remotion** — animate via `useCurrentFrame()` + `interpolate()`.

**Why vendored, not symlinked or fetched:**

- Every contributor's rail picks it up automatically when they
  clone the repo. No separate install step, no out-of-band
  configuration.
- The skill stays at a known commit
  (`277510e78245ac0fa275d7cb6520d52e0ac2e212`, 2026-05-07);
  an upstream change won't silently affect existing projects.
  Refresh instructions live in
  `.claude/skills/remotion-best-practices/ATTRIBUTION.md`.

**Project-specific overrides** (Clipwright-side notes alongside
the upstream skill at
`.claude/skills/remotion-best-practices/CLIPWRIGHT_NOTES.md`):

- **TTS**: upstream defaults to ElevenLabs. Clipwright's actual
  provider comes from `project.json#tts_provider` /
  `recap_overrides.voice_provider` / clip-level `voice` — DO
  NOT default to ElevenLabs.
- **FFmpeg**: upstream uses `npx remotion ffmpeg`. Clipwright's
  backend shells out to the system `ffmpeg` binary; keep using
  `subprocess.run(["ffmpeg", ...])` in `render_segment.py`,
  `render_final.py`, `import_video.py`.
- **Captions**: use Clipwright's per-segment caption JSON
  under `captions/<video_id>/`, not raw SRT.
- **Asset paths**: Clipwright keeps source media in `sources/`,
  voiceover in `voiceover/audio/`, output in `out/`, NOT the
  upstream's stock `public/` convention.
- **Composition entry**: `remotion/src/Root.tsx` (not the
  stock `src/Root.tsx`); the project is already wired to
  Clipwright's render pipeline — do not scaffold a fresh one.

The agent prompt tells Claude to read `CLIPWRIGHT_NOTES.md`
**LAST**, after the upstream skill, so these overrides have
the final word.

**Implementation notes:**

- **Vendor**: `.claude/skills/remotion-best-practices/SKILL.md`
  + `rules/*.md` (35 files, ~4030 LOC total) copied from
  upstream verbatim. `.git` dir not preserved. Attribution
  and refresh instructions in `ATTRIBUTION.md`.
- **Prompt wiring** (`src/clipwright/agent/prompt.py`):
  `_section_skill()` now takes a `project: Project` arg and
  emits an additional paragraph when `project.render_backend
  == "remotion"`. The paragraph names the skill, the trigger
  conditions (touching Remotion code, render code, captions,
  audio, or composition timing), what it teaches, and the
  CLIPWRIGHT_NOTES.md override pointer. Call site at
  `build_segment_prompt` updated.
- **Content validation**: spot-checked the four most-relevant
  rule files (`trimming.md`, `silence-detection.md`,
  `voiceover.md`, `ffmpeg.md`). No malicious content, no
  phone-home, no unexpected external deps. Coverage maps
  closely to Clipwright's pipeline.
- **Tests**: existing 23 `test_agent_prompt` tests pass —
  the new section adds output but doesn't alter the contract
  of any other section.

### Added (Skills in the rail popover + skill pre-selection per video)

**What's new:**

- The rail's slash-command popover now also lists **Claude Code
  skills** discovered under `~/.claude/skills/<name>/SKILL.md`
  (user-level) and `<project>/.claude/skills/<name>/SKILL.md`
  (project-level). Each skill row shows the skill name, the
  frontmatter description, and a `skill · user` / `skill ·
  project` chip (amber-tinted) to distinguish it from the
  command (`cmd · …`) and built-in (`built-in`) rows.
- The Videos sidebar's **"+ New video (empty)"** form gained a
  **Default skills** picker that appears after the id + title
  inputs. The user can search-filter the catalog and check any
  number of skills to pre-select. On Create, the selection is
  persisted into the video manifest's `recap_overrides.default_skills`,
  and the agent prompt injects a line telling Claude to invoke
  those skills proactively (via the Skill tool) without waiting
  for an explicit `/skill-name` from the user.

**Implementation notes:**

- **Backend (`claude.rs`)**:
  - New `Skill` struct (`name`, `description`, `source`).
  - New `list_skills(project_dir)` Tauri command. Walks both
    skills roots, reads each `SKILL.md` for frontmatter
    (`description:` only — the directory name is authoritative
    for the skill's invocation name).
  - `collect_skills` deliberately ignores the frontmatter
    `name:` field — relying on the directory name avoids the
    silent-mismatch trap (CLI uses dir name to resolve
    `/skill-name`).
  - Project-level skills override user-level on name collision.
- **`create_video_cmd`** (`project.rs`) gained an optional
  `default_skills: Option<Vec<String>>` arg. Empty/blank entries
  are filtered out. Skills are written into the new video's
  `recap_overrides.default_skills`. No schema migration —
  `recap_overrides` is the existing free-form override bag.
- **Agent prompt** (`prompt.py`): reads
  `recap_overrides.default_skills` and appends a line
  `**Pre-selected skills for this video:** \`skill1\`, \`skill2\`. …`
  to Claude's system prompt with explicit instructions to
  invoke them proactively. Empty list → no line emitted.
- **Frontend (`tauri.ts`)**: `listSkills` + `Skill` type;
  `createVideo` gained an optional `defaultSkills: string[]`
  arg.
- **Rail (`ClaudeRail.tsx`)**:
  - Loads skills alongside slash commands on project open.
  - New `SlashEntry` discriminated union (`kind: "builtin" |
    "command" | "skill"`) so the popover renders the right
    chip per row. Builtins keep accent tint; skills use warn
    tint; commands stay neutral.
  - The popover's match list merges built-ins + custom
    commands + skills, all filtered by the same prefix query.
- **Sidebar (`VideoSidebar.tsx`)**: `CreateForm` extended with
  a `Default skills` panel — filter input, scrollable
  checkbox list, selected-skill chips with quick-remove, and
  a small "skills get injected into Claude's system prompt"
  footer. State lives in the parent so Cancel resets it.

**Tests:** existing 23 `test_agent_prompt` tests pass — the
new injection only fires when `recap_overrides.default_skills`
is non-empty, so legacy projects emit identical prompts.

### Added (Slash-command autocomplete in the Claude rail)

**What's new:** type `/` in the rail's text input and an
autocomplete popover appears just above the textarea, listing
every matching slash command. Filter narrows as you type; ↑↓
navigate; Enter or Tab accepts; Esc closes. Commands with an
`argument-hint:` in their frontmatter (e.g. `<file>`) keep the
popover-after-name behavior by leaving a trailing space when
accepted, so you can keep typing the argument.

**Where commands come from:** the rail discovers custom slash
commands from two locations on every project open, matching
the upstream Claude Code convention:

| Location | Tag in popover | Precedence |
|---|---|---|
| `~/.claude/commands/**/*.md`            | `user`    | Lower (fallback). |
| `<project>/.claude/commands/**/*.md`    | `project` | Higher (overrides user on name collision). |

Subdirectories become `:`-separated namespaces:
`commands/qa/test.md` → `/qa:test`. The popover surfaces the
frontmatter `description:` as the row hint and
`argument-hint:` as an inline placeholder next to the name.

**Built-in fallbacks** (always present, handled locally by the
rail, no CLI call):

- `/clear` → triggers the FreshChatButton path (archives today's
  log, wipes the session id, starts fresh).
- `/cancel` → cancels the in-flight turn (no-op when idle).

Custom commands send through verbatim to `claude --print`; the
CLI expands the markdown template just as it would in an
interactive shell.

**Implementation notes:**

- **Rust (`claude.rs`)**: new `list_slash_commands(project_dir)`
  Tauri command. Walks both directory trees recursively, parses
  YAML-ish frontmatter for `description:` and `argument-hint:`
  (no YAML dep — these fields are simple key-value pairs in
  every command file I've seen), merges with project precedence,
  returns sorted by name.
- **`SlashCommand` struct** with `name`, `source`, `description`,
  `argument_hint`. Serializes to camelCase via the existing
  patterns.
- **Frontend (`tauri.ts`)**: `listSlashCommands` wrapper +
  matching TS type.
- **`ClaudeRail.tsx`**:
  - State: `slashCommands` (loaded on project open) and
    `slashIndex` (highlight position).
  - Memoized `slashMatches` filters by the prefix after `/`,
    requiring no whitespace yet (typing args closes the
    popover). Built-ins `clear` / `cancel` are merged in.
  - Textarea keydown intercepts arrow / Enter / Tab / Esc when
    the popover is open; otherwise the existing Enter-sends
    behavior runs unchanged.
  - New `<SlashCommandPopover>` component renders the floating
    list using a `position: absolute; bottom: full;` anchor
    relative to a new wrapper div around the textarea. Uses
    `onMouseDown + preventDefault` for the click target so the
    textarea doesn't lose focus before the click registers.
  - `send()` intercepts `/clear` and `/cancel` literals before
    forwarding to the CLI, mapping them to the existing
    `onFreshChat` and `onCancel` paths respectively.

### Changed (Preview is now two modes — Final + Raw; Segment mode removed)

**What was wrong:** the three-mode toggle (Segment / Final /
Raw) had real conflict. Segment's "play one clip from source,
pause at the end" overlapped with Raw (when the project had a
single source video) and with Final (once a render existed).
The pause-at-end logic was wired through Final mode via a
shared `segmentRange` `useMemo`, so clicking Play on Final
**paused at the boundary of whichever segment was selected** —
the bug that prompted this cleanup.

**Fix:** Preview now has exactly two modes.

- **Final** (always present, default): plays
  `out/final/<video_id>.mp4`. The whole file is continuous;
  `<video>.currentTime` IS timeline time. No pause-at-end, no
  segment-boundary trickery. When the mp4 is missing, a
  placeholder reads "No final render yet — click Render in the
  top bar."
- **Raw** (only when all `kind:"recording"` segments share a
  single video source): plays the unedited source mp4
  end-to-end. The timeline playhead still tracks which segment
  is on screen by walking segments and mapping source-time back
  to timeline-time inside `onTimeUpdate` / `onSeeked`.

The store union narrowed from `"segment" | "final" | "raw"` to
`"final" | "raw"`; the default mode flipped from `"segment"` to
`"final"`. There is no more "play one segment from source"
mode — when the user wants to inspect a clip pre-render they
either Render the final or use the Raw view.

**Side effects:**

- **Timeline.tsx**: `seekToGlobalTime` is now a 1:1
  pass-through to `requestSeek` (it used to convert
  global→segment-local in Segment mode). Clicking a segment
  still auto-selects it but no longer separately seeks
  segment-local; the Preview seeks the same timeline-time
  for both modes.
- **PlaceholderCard**: dropped the still-image and
  "select-a-segment" empty states (Segment-mode-only). Two
  remaining states: "No video yet" (no segments) and "No
  final render yet" (have segments, no mp4).
- **Footer readout**: dropped the source-range numbers; now
  shows `final · <video_id>` or `raw source · unedited`.

**Outcome:** clicking Play on Final plays the entire mp4
straight through. Clicking a segment seeks the playhead to
that segment's start without freezing playback. Raw mode is
unaffected and continues to give the "highlight my edit" view
as the source plays.

### Fixed (Timeline visibility per preview mode — Final shows tracks, Raw hides them)

**What was wrong:** the previous wiring was inverted relative to
the user's mental model and also stale.

- **Raw mode** showed the segmented timeline. But Raw is the
  unedited source — the slices on the tracks are precisely the
  thing Raw isn't; showing them implied "here's how Raw is
  cut," which it isn't.
- **Final mode** hid the tracks unless `finalAvailable` was
  `true`. The probe only re-fired through `loadProject`, so
  when Claude rendered the final via its own subprocess
  (`render-final` invoked from chat), the flag stayed `false`
  and the tracks stayed hidden — even though the final mp4
  was on disk and playing in the preview pane.

**Fix:** the gating is now keyed off `playbackMode` only.

- **Final mode → always show tracks.** The user reads the
  tracks as "the edit plan I'd assemble" — meaningful whether
  or not a rendered mp4 exists yet. We dropped the
  `finalAvailable` gating in `Timeline.tsx`.
- **Raw mode → hide tracks.** A short placeholder reads
  "Raw source playback — switch to Segment or Final to see
  the edit-plan tracks."

The `finalAvailable` probe + store value remain in place for
other consumers (and future use, e.g. enabling/disabling the
Final toggle itself).

### Changed (Chat history now persists tool calls + results for resume)

**Problem:** the chat JSONL log only persisted two roles —
`user` and `assistant` — and only the assistant's final
`result` text. A turn that ran 12 tool calls before crashing
or being cancelled left zero trace on disk; reloading the rail
showed only the user's prompt and nothing else, forcing the
user to re-explain context.

**Fix:** `run_claude_streaming` now walks each stream-json
payload and writes intermediate `tool_use` and `tool_result`
entries to the per-video log in real time, alongside the
existing user / assistant lines. A mid-turn refresh or kill
preserves the full audit trail; a resume starts with the chat
history fully populated.

**Schema (additive, back-compat):** `ChatHistoryEntry`
gained five optional fields, all `#[serde(default,
skip_serializing_if = "Option::is_none")]` so existing log
lines deserialize unchanged and new tool entries don't bloat
with trailing nulls:

| Field          | Role(s)         | What it carries |
|----------------|-----------------|-----------------|
| `tool_id`      | tool_use, tool_result | Links the pair. |
| `tool_name`    | tool_use        | e.g. `Bash`, `Read`. |
| `tool_input`   | tool_use        | The CLI's `input` object verbatim. |
| `tool_output`  | tool_result     | The tool's reply (string or content blocks). |
| `tool_error`   | tool_result     | `true` if the CLI flagged the result as error. |

**Implementation notes:**

- New `append_chat_entry()` lower-level helper writes a
  caller-supplied JSON value to the log file. The legacy
  `append_chat_log()` is now a 3-line wrapper around it.
- New `capture_tool_payload()` introspects each stream
  payload — `type:"assistant"` for `tool_use` parts, `type:"user"`
  for `tool_result` parts — and writes an entry per block.
  Best-effort: a log-write failure doesn't abort the turn.
- Frontend `ChatHistoryEntry` type extended with the same
  optional fields (role union now includes `tool_use` /
  `tool_result`).
- `ClaudeRail.tsx` history-map branches on role:
  - `tool_use` → render `HistoryToolChip` and look ahead for
    a matching `tool_result` by `tool_id` to merge into the
    same chip (so input + output appear together).
  - `tool_result` → skipped if its `tool_use` partner was
    already rendered, otherwise shown as an orphan chip
    (handles legacy log fragments and partial writes).
  - `user` / `assistant` → existing `ChatBubble` path.
- A new `HistoryToolChip` wrapper places the chip inside a
  matching assistant-style container so replayed tools
  visually align with surrounding bubbles (a bare chip read
  as a different speaker).

### Added (Claude rail idle timeout is now user-configurable)

**What was broken:** The Claude rail killed any subprocess that
went 120s without emitting a stream-json line, with an error
message recommending YOLO as the cure. YOLO doesn't help — it
only changes how the CLI handles permission prompts. Long
autonomous turns (deep tool chains, heavy thinking, big
yolo-mode bashes) legitimately go silent past 120s, and the
watchdog killed them anyway. Users in YOLO kept hitting "claude
timed out after 120s" on healthy work.

**Fix:** New idle-timeout picker in the Claude rail header,
next to the permission picker. Five presets:

| Label    | Wire value | Behavior |
|----------|-----------|----------|
| idle 2m  | 0         | Default. Existing behavior preserved. |
| idle 5m  | 300       | Light bump. |
| idle 15m | 900       | Comfortable for autonomous yolo runs. |
| idle 30m | 1800      | Generous; wall-clock 2h cap is still the upper bound. |
| idle off | -1        | Watchdog disabled. Only the wall-clock cap fires. |

Persisted per-project in the existing
`<project>/.clipwright/claude-timeout.json` as a new
`idle_seconds` field. The wall-clock `wall_seconds` setting is
preserved on writes — both fields share one file with a
read-merge-write `save_idle_seconds` helper so neither
clobbers the other.

The Rust enforcement clamps to `[30, 3600]` so a typo can't
either hair-trigger the kill or remove the cap entirely. `-1`
is the only special value that disables the watchdog. The wall
timeout (default 2h) is always on as a backstop, including
when idle is off.

**Honest error message.** The timeout reason used to recommend
YOLO unconditionally. It now names BOTH causes — silent
permission denial AND legitimately-long turns — and points at
the matching fix for each:
> "no output for {N}s. Two common causes: (1) the CLI silently
> denied a tool (Bash patterns not in the auto-edits allow
> list) — try the rail's permission picker (auto-edits or
> yolo); (2) the turn legitimately needs longer (long thinking
> or tool chains) — raise the idle timeout in the rail header,
> or set it to Off so only the wall-clock cap fires."

**Implementation notes:**

- `desktop/src-tauri/src/claude.rs`:
  - `CLAUDE_IDLE_TIMEOUT` const renamed to
    `CLAUDE_IDLE_TIMEOUT_DEFAULT` + new `CLAUDE_IDLE_MIN` /
    `CLAUDE_IDLE_MAX` for clamping.
  - New `load_idle_timeout(project_dir) -> Option<Duration>`:
    `None` = watchdog off.
  - New `load_idle_seconds_raw()` and `save_idle_seconds()`
    helpers (the latter merges into the existing file so
    `wall_seconds` survives).
  - Two new Tauri commands: `get_idle_timeout`,
    `set_idle_timeout`.
  - `run_claude_streaming` captures `idle_timeout` once at
    start (don't re-read mid-stream — a config edit shouldn't
    change policy half-way through a turn).
  - Watchdog branch now `if let Some(idle_cap) = idle_timeout`
    so the check is skipped entirely when off.
  - `ClaudeError::Timeout::reason` switched from `&'static
    str` to `String` so the message can carry the dynamic
    idle-seconds value.
- `desktop/src-tauri/src/lib.rs`: register the two new
  commands.
- `desktop/src/lib/tauri.ts`: `getIdleTimeoutSeconds` /
  `setIdleTimeoutSeconds` wrappers; raw seconds on the wire
  (Rust is the source-of-truth for clamps).
- `desktop/src/components/ClaudeRail.tsx`: new `idleSeconds`
  state loaded alongside `permMode`; new `IdleTimeoutPicker`
  component (siblings with `PermissionModePicker`, easier to
  maintain together). Uses the shared `Dropdown` constrained
  to string values, so the preset wire encoding goes through
  `parseInt` at the boundary.

### Changed (New Project dialog is now a 3-step wizard, template required)

**What changed:** The "everything on one screen" layout was
quietly hurting: people would click straight into Upload /
Record from the mode chooser, skip past the **optional**
Template picker below it, and end up running Claude without any
genre-specific guidance. Those projects produced generic output
and the user usually didn't know why.

**New flow:**

1. **Templates** — pick at least one. The Next button is
   disabled until something is selected, and the footer hint
   makes it obvious ("Pick at least one template to continue").
   Primary template is highlighted; you can still bind multiple.
2. **Mode** — Upload vs. Record. Shows a confirmation chip of
   the template(s) you bound in step 1 so the choice carries
   forward visibly.
3. **Configure** — the same Upload / Record form as before,
   reachable only after the first two steps. "Back" returns to
   the Mode step (and Back from there returns to Templates).

A step counter sits in the header (`Step 2 of 3 · Mode`) plus a
pill indicator strip below it with three dots that fill in as
you progress. The active pill gets a brief scale-up pulse on
arrival so the eye locks onto the new position; completed steps
swap their number for a ✓ in muted accent.

**Animations:** added two short keyframes to `tailwind.config.ts`:

- `stepFade` (200ms ease-out): a small upward slide + fade
  applied to each step's content panel via
  `key={step}` + `animate-stepFade`. React remounts the panel on
  step change so the keyframes fire each time.
- `pillPulse` (240ms ease-out): the active step pill's
  scale-up + fade-in. Subtle, not theatrical — the dialog still
  feels like a tool, not a marketing page.

**Error recovery:** if the Python subprocess fails after submit,
the dialog now bounces back to whichever config form the user
came from (Upload or Record) instead of the Mode chooser — the
old behavior wiped the typed-in fields. Implementation: capture
`previousStep` before flipping to `running`, restore it on
error.

### Added (New Project dialog now exposes project-default TTS provider + voice)

**What's new:** Both Upload and Record steps of the New Project
dialog gained a **Voice (default)** field — two dropdowns,
provider + voice, dependent (changing provider auto-snaps the
voice to that provider's catalog default unless the current
voice still fits the new catalog). Pick once at creation time
and the choice is persisted in `project.json#tts_provider` and
`project.json#voice_id`. Per-video and per-clip overrides still
win on top of this when set; this is just the project-wide
default that everyone falls through to.

**Why:** Until now, every fresh project hardcoded
`tts_provider="kokoro"` and `voice_id=""` regardless of what the
user actually wanted. Changing that required either editing the
JSON by hand or going video-by-video through the Settings
dialog's "This video" tab. The Hub-level pick was the obvious
missing piece.

**Implementation (top-down):**

- **NewProjectDialog**: new `ttsProvider` + `voiceId` state at
  the dialog level (survives Upload ↔ Record toggling). A new
  `<VoiceFieldRow>` component renders the dependent dropdowns,
  reusing `VOICE_PROVIDER_OPTIONS` / `VOICES_BY_PROVIDER` from
  `lib/voiceCatalog.ts`. Template-system primary still seeds the
  pickers, with the existing "touched" latch so the user's
  explicit pick survives a later template change.
- **`lib/tauri.ts`**: `ImportVideoArgs` and `RecordProjectArgs`
  gained optional `ttsProvider` + `voiceId` fields. Empty / omitted
  preserves back-compat for older callers.
- **Tauri (`new_project.rs`)**: `import_video_cmd` and
  `record_project_cmd` accept `tts_provider: Option<String>` +
  `voice_id: Option<String>` and forward them as
  `--tts-provider` / `--voice-id` to the Python CLI when
  non-empty.
- **Python CLI**: `clipwright import` and `clipwright
  record-project` gained `--tts-provider` and `--voice-id`
  options (defaults preserve the historical `kokoro` / `""`).
- **Python lib**: `import_video()` and `record_project()` (plus
  the inner `_seed_from_recording()`) take new `tts_provider` /
  `voice_id` kwargs and write them straight into the seeded
  `Project` instance instead of the hardcoded literals.

**Back-compat:** Existing projects on disk are unchanged.
Templates that set `tts_provider` / `voice_id` defaults still
seed the dialog as before. Non-desktop callers (CLI without the
new flags) still default to `kokoro` / `""`. All 33 import/record
tests pass.

### Fixed (Timeline hides its tracks in Final mode when no final mp4 exists)

**What was broken:** Preview was switched to Final mode and the
pane correctly showed "No final render yet — click Render in the
top bar". But the Timeline below kept rendering the full
edit-plan tracks (Video / Audio / Captions blocks for every
segment). That's misleading: those tracks aren't what's playing
(nothing is), they're the inputs that **would** assemble into a
final. The user reasonably read it as "the rendered final has
these segments" and got confused.

**Fix:** The Timeline now mirrors the Preview's empty state when
`playbackMode === "final"` and `out/final/<video_id>.mp4` is not
on disk. Tracks are replaced by a short placeholder pointing the
user at the Render button or the Segment / Raw modes. As soon as
Render completes, the probe re-runs and the tracks come back.

**Implementation:**

- New Tauri command `final_exists_cmd(project_dir, video_id) ->
  bool` in `project.rs`. Pure filesystem probe, no JSON parsing.
- Store gained `finalAvailable: Record<string, boolean>` (keyed
  by `video_id`) and an async `refreshFinalAvailable(videoId)`
  action that calls the new command and stores the result.
- The refresh fires automatically on `loadProject` and on
  `switchVideo`. After a successful render in `RenderDialog`,
  `loadProject(r.project)` already runs — that re-fires the
  probe so the tracks reappear without an extra hook.
- Timeline reads `finalAvailable[currentVideoId]` and shows the
  placeholder only when the value is **explicitly `false`** —
  `undefined` (probe in flight) keeps the tracks visible so we
  don't flash an empty state on initial load.

**Note on the "raw segments tab" question:** The segments on the
timeline ARE the edit plan, not raw scene detection — for a
fresh import they happen to coincide (scene detection seeded the
plan), but every split / merge / delete the user or Claude makes
mutates the same list. We didn't add a separate Raw-segments
tab; the existing Segment / Final / Raw preview modes already
give the user three perspectives on the same plan. If you want
a true "compare against original scene cuts" view, file a
follow-up — we'd need to snapshot the initial segmentation at
import time first.

### Fixed (Timeline no longer crushes short segments to fit the viewport)

**What was broken:** With a long timeline (e.g. an 11-segment
recap with a 3.7s clip wedged between 16.7s and 47.5s clips),
`autoDensity` divided the available width by total duration and
clamped to `MIN_PX_PER_SEC=6`. The short clip rendered ~22px
wide — the label clipped to a single character and the segment
visually overlapped its neighbors (see the user's screenshot).
The fit-to-viewport behavior was actively fighting the already-
enabled horizontal scroll.

**Fix:** `autoDensity` now picks the **larger** of two densities:
- `fit = usable / totalSec` — fills the viewport for short
  timelines.
- `readabilityFloor = MIN_SEG_PX / shortestSegmentSec` — keeps
  the shortest segment at least 64px wide.

For short timelines `fit` wins (no behavior change). For long
timelines `readabilityFloor` wins and the timeline scrolls
horizontally instead of compressing. `MIN_PX_PER_SEC` /
`MAX_PX_PER_SEC` remain as sanity clamps.

Function signature changed from `autoDensity(n, totalSec, w)` to
`autoDensity(segments, totalSec, w)` since the floor needs the
shortest segment's duration, not just the count.

### Added (Preview now has a RAW tab for inspecting the unedited source)

**What's new:** When a video's segments all slice the same
recording-flow source mp4 (the common upload/record case), the
Preview pane's mode toggle gains a third option: **Raw**. It
plays the original `sources/<file>.mp4` end-to-end, unclipped,
so you can confirm the underlying material is fine without
re-rendering and without scrubbing each segment. The Timeline
playhead still tracks playback — as the raw source plays, the
highlighted segment on the timeline shows you which edit you're
currently looking at. Material that was cut out shows up as
gaps where the playhead simply doesn't advance.

**Availability:** The RAW toggle only appears when every
`kind === "recording"` segment in the project shares the same
`source` field AND that source ends in `.mp4|.mov|.webm|.m4v`.
Panel-based projects (manhwa-recap) and multi-source projects
(B-roll alongside main) hide the option since "the raw video"
isn't a coherent concept there.

**Implementation notes:**

- **PreviewMode** type extended to `"segment" | "final" | "raw"`;
  the store's `playbackMode` mirrors the same union.
- **rawSourcePath** `useMemo` does the detection — returns
  `null` (and hides the toggle) unless the segments are
  source-coherent.
- **Timebase mapping.** Raw mode's `<video>.currentTime` is in
  the source's timebase. `onTimeUpdate` and `onSeeked` walk
  segments to find the one whose `source_start..source_end`
  contains `videoT`, then map back to timeline time as
  `cursor + (videoT - source_start)` where `cursor` is the
  running sum of preceding `target_duration`s. If `videoT`
  falls in a gap (material was edited out), the playhead stays
  put — that's the "highlight my edit" UX.
- **Seek-from-Timeline.** Clicking the timeline in raw mode
  goes the other way: find the segment whose
  `[cursor, cursor+target_duration)` contains the click time,
  map back to `source_start + offset`, seek the source video.
- **Auto-seek + pause-at-end disabled** in raw mode (the whole
  point is to play the source end-to-end).
- **Fallback.** If the user is on RAW and switches to a project
  where raw isn't available, the mode resets to `"segment"`.

### Fixed (Segment-mode preview now works on imported videos before any render)

**What was broken:** A fresh upload (e.g.,
`VertexReader - DemoVideos`) yields a video manifest with N
scene-detected segments pointing at `sources/main.mp4`, but **no
rendered mp4s anywhere** — `out/` doesn't exist yet. Both Preview
modes pointed at `out/final/<video>.mp4`, so the user saw "No
final render yet" and had no way to scrub the imported segments
without paying for a full render first. The 11 segments WERE
real (visible in the timeline), they just had no playable
preview.

**Fix:** Segment mode now plays the segment's `source` file
**directly**, clipped to `source_start..source_end`. For a
recording-flow upload that's the user's original mp4 — they can
scrub each scene-detected segment immediately, no render
required. Final mode is unchanged: still plays
`out/final/<video>.mp4`.

**Implementation notes:**

- **Two playback strategies, one component.** `mode === "final"`
  loads `out/final/<video>.mp4`; `mode === "segment"` loads
  `<project>/<seg.source>` directly. The `mp4Path` `useMemo`
  picks per mode + segment kind.
- **Timebase reconciliation.** The store's `playbackTime` is
  always in TIMELINE seconds (so the Timeline scrubber stays
  simple). In Final mode that's also `<video>.currentTime`. In
  Segment mode `<video>.currentTime` is in the SOURCE's
  timebase, so the Preview converts both directions:
  - `onTimeUpdate`: `timelineT = segmentPositioned.start +
    (videoT - seg.source_start)`
  - `seekRequest`: `videoT = seg.source_start +
    (timelineT - segmentPositioned.start)`, clamped to
    `[source_start, source_end]` so a scrub can't drift into
    adjacent material.
  - Timeline's playhead math simplified: it now just reads
    `playbackTime * pxPerSec` since the store value is already
    in the right timebase.
- **Auto-pause at the segment boundary** — in source-clipped mode
  that's `source_end`; in final-clipped mode it's the timeline-
  relative end. The footer's `range` readout adapts to show
  whichever timebase is active.
- **Auto-seek on segment change** — clicking a different segment
  in the timeline now seeks the `<video>` to that segment's
  `source_start` immediately, so "click → see that beat" lands
  with no extra step.
- **Still-image segments (manhwa panels)** can't be played in a
  `<video>` element. We detect this by checking the source
  extension (`.webp` / `.png` / `.jpg` / `.jpeg` / `.gif`) and
  surface a dedicated placeholder pointing the user at Final
  mode: *"Still-image segment. Switch to Final mode to see the
  rendered clip, or click Render in the top bar to generate
  one."*

**Net for the imported-video case:** open the project → click any
segment in the timeline → it plays. Drag the scrubber to walk
through the scenes. Hit space to play, watch it auto-pause at
the segment boundary. No render needed.

### Fixed (Videos sidebar row truncation)

- **Long video titles now truncate cleanly with an ellipsis** and
  show the full title on hover via a native OS tooltip. Previously
  "DemoRecap — Pig Slaughtering" wrapped across two lines AND the
  metadata line ("democrap---pig-slaughtering · 11 segments")
  wrapped across three more, blowing up the row to ~80px tall.
  The CSS gotcha: `truncate` on a flex child only takes effect
  when both the parent has `min-w-0` (so it can shrink below
  content width) AND the child has an explicit `w-full`. Both
  added. The tooltip combines the title + the on-disk slug + the
  segment count so a quick hover gives you everything the row
  used to show on multiple lines.

### Added ("First video name" field + clearer New Project / Upload flow)

- **New Project dialog (Upload mode) now lets you name the first
  video separately from the project.** A project is a *collection*
  of videos; the file you upload becomes the first video, and you
  may add more later (record-with-Claude or upload another file).
  Until now the upload flow conflated the two — the project name
  and the first video both inherited the filename, and you couldn't
  rename the first video. Two fields now:
  - **Project name** — the parent collection (existing field,
    clearer copy: *"You can add more videos later via the sidebar
    — record-with-Claude or upload another file."*).
  - **First video name** *(new)* — titles only the first video.
    Defaults to the uploaded file's stem. Shows a live `video_id:
    <slug>` preview beneath the field so the user can see the
    sanitized on-disk slug that's going to scope per-video paths
    (`videos/<slug>.json`, `out/segments/<slug>/`, etc.).
- **Independent autofill.** Both fields default to the file stem
  on first upload, but editing one doesn't override the other.
  Example: project "Eternally Regressing Knight" + first video
  "Chapter 1" works without one nuking the other on type.
- **Tauri `import_video_cmd`** accepts optional `video_id` +
  `video_title` parameters. Falls back to `"main"` / `""` when
  omitted so the existing back-compat callers don't change
  behavior. The args flow through to `clipwright import --video
  <id> --video-title <title>` which the Python CLI already
  supported (see `cli.py` `import_` command).
- The `videoId` is sanitized via the same regex as
  `clipwright.schema.v2.video.sanitize_video_id` so the slug
  matches what the renderer + agent prompt will see on disk.

### Added (Multi-template binding per project)

- **A project can now bind multiple templates.** Concrete use case
  the user asked for: a manhwa-reader platform producing chapter
  recaps wants `manhwa-recap-single` (primary, drives the
  panel-based Remotion preset) AND `product-demo` (secondary, so
  every video also frames itself as product marketing — CTA, value
  prop, etc.). Either template alone misses half the intent; both
  together produce the right output.
- **Schema:** new `Project.template_ids: list[str]` field. The
  legacy `template_id: str` is still serialized as a mirror of
  `template_ids[0]` so projects written by this version stay
  readable by older binaries. On load we accept either shape —
  projects bound before this change get their legacy id promoted
  into the new list automatically.
- **The FIRST entry is the primary.** It drives:
  - `render_preset` selection (manhwa vs legacy)
  - Default project settings (aspect, fps, tts_provider, voice_id)
    when `--overwrite-defaults` runs
- **Secondaries contribute behavioral guidance only.** Their
  `system_prompt` blocks are appended to the agent prompt under a
  per-template header labeled `(secondary)`. When two or more
  templates are bound, the prompt now prepends a "Combined
  template lens" section that explicitly tells Claude: *"Apply
  ALL of them simultaneously — overlapping constraints, not
  alternatives. When a per-template rule conflicts with another,
  prefer the primary template's direction."*
- **Stale-id tolerance.** If a bound template id no longer exists
  on disk (deleted from the user's templates dir between binding
  and load), the prompt emits a degraded `[missing: <id>]` note
  instead of crashing — other bindings still load.
- **CLI:** `clipwright templates apply <id1> <id2> ...` now
  accepts multiple ids. First arg is the primary; subsequent args
  are secondaries. Pass `-` alone to clear all bindings. Resolves
  + validates every id *before* mutating disk so a typo doesn't
  leave the project in a partial state.
- **Tauri:** new `apply_templates_cmd(project_dir, template_ids,
  overwrite_defaults)` command. The old single-template
  `apply_template_cmd` is preserved as a back-compat shim
  delegating to the multi-template path.
- **`TemplatePicker` is now a true multi-select.** Each card has a
  checkbox; the currently-primary card shows a "★ primary" badge.
  Selected-but-not-primary cards show a "make primary" link that
  promotes them without rebuilding the selection. A header counter
  reads `"2 templates selected. The first one (★) is the primary"`
  and a "Clear all" button wipes the selection.
- **Dialogs updated.** Both the New Project dialog (when creating)
  and the Template dialog (when rebinding) now use the multi-
  select picker. The Template dialog header explains the manhwa-
  recap + product-demo use case verbatim so users discover the
  pattern.
- **TopBar badge** shows the primary template's friendly name plus
  a `+1` / `+2` chip when secondaries are bound. Hover tooltip
  spells out the full ordered list. Reads `"templates:"` (plural)
  vs `"template:"` (singular) so the count is immediately legible.
- **Render dispatch reads the primary.** `_should_use_manhwa_preset`
  is evaluated against `template_ids[0]` (or the legacy single
  field on older manifests) — secondaries don't affect which
  renderer runs.
- **7 new tests** cover the schema round-trip (multi-id + legacy
  promotion), the agent prompt concat (both templates injected with
  primary/secondary labels + the combined-lens prelude), missing-
  binding tolerance, the CLI's multi-arg parsing + `-` clear
  sentinel, and the render dispatch's primary-only rule. Suite:
  **302 Python tests passing** (was 295 + 7).

### Fixed (Playhead handle/line alignment)

- **The scrubber's diamond handle and the vertical playhead line
  now sit on the same x-position.** The previous wrapper used
  `flex flex-col items-center` with a `marginLeft: -6` on the
  handle — those two centering rules combined produced a 6-pixel
  horizontal offset between the diamond and the line. Both pieces
  now use explicit absolute positioning relative to a zero-width
  wrapper anchored at the playhead time, so their visual centers
  land on `globalPlayhead * pxPerSec` exactly.

### Added (Timeline auto-fits + Render-scope picker)

- **Timeline density auto-fits the viewport width.** The previous
  `autoDensity` used a hardcoded 1020px target so on a 1900-px wide
  screen the timeline only filled about half the available area. A
  new `ResizeObserver` measures the tracks container live and
  recomputes pixels-per-second so the lanes stretch edge-to-edge.
  Updates fire whenever the user resizes the window, opens/closes
  the Inspector drawer, or expands the Claude rail — the timeline
  stays correctly fitted in all four panel-state combinations.
  The static fallback density is still used on the first paint
  (before the observer has measured) so the UI doesn't pop on
  load.
- **Render-scope picker in the Render dialog.** Two-option toggle:
  - **Whole video** (default) — renders all segments and concats
    into `out/final/<video_id>.mp4`. For recording-flow projects,
    per-segment caches kick in so only edited segments re-render.
    For manhwa-recap projects, the whole Remotion composition
    re-runs (no per-segment cache exists yet — see the deferred
    section below).
  - **Just `<seg>`** — only available when a segment is selected
    AND the project is NOT manhwa-recap. Routes through
    `clipwright render-segment`, writes to
    `out/segments/<video>/<seg>.mp4`, skips the concat. The final
    mp4 stays at its previous state; the stale-final banner in
    Preview tells the user to do a "Whole video" run when they're
    done iterating. Useful for rapid back-and-forth on one beat
    without paying the full render cost each time.
  - **Force re-render** checkbox kept — applies in both scopes.
  - **Manhwa-recap explanation inline:** the segment option shows
    "Disabled: manhwa-recap renders as one Remotion pass" so the
    user knows why the option is grayed out instead of guessing.
- **Render dialog success path** now reports the correct output
  path per-scope: full → `out/final/<video_id>.mp4`, segment →
  `out/segments/<video_id>/<seg_id>.mp4`.

### Deferred (next turn): per-segment Remotion rendering for manhwa templates

The user asked for **"render only the segments I changed"** but
that doesn't work today for manhwa-recap projects — the Remotion
`ManhwaRecap` composition renders the whole video in a single
monolithic `npx remotion render` invocation. To unlock selective
renders for manhwa we need:

1. Split the Remotion render into **per-segment passes** — for each
   segment, compute its frame range
   (`start_frame = sum(prev target_durations) * fps`) and pass
   `--frames=start-end` to `npx remotion render`, writing to
   `out/segments/<video>/<seg>.mp4`. Each render's inputs JSON
   stays the same shape, but the player only renders the slice.
2. **Content-hash caching per segment** — same pattern as the
   recording flow's per-segment caches: hash `(segment manifest +
   panel mtimes + audio mtime + caption mtimes + camera mtime)`,
   write to `<seg>.cache.json`, skip the render when the hash
   matches.
3. **Concat** the per-segment mp4s into the final via ffmpeg's
   concat demuxer — already wired in `render_final.py`'s
   `_concat()`, just need to route manhwa through it.
4. Enable the "Just `<seg>`" render-scope option for manhwa once
   (1)–(3) ship.

This is structurally similar to what we did for the recording
flow; it's just a fair bit of Remotion + caching plumbing.
Skipped this turn for scope; will pick up next.

### Fixed (Voiceover label + Rust defaults + stale-final banner + narrow-layout responsiveness)

- **Voiceover panel no longer reads "disabled" when the segment has
  script content.** The summary now treats non-empty script text as
  "enabled" for display purposes; on save we also flip
  `seg.voiceover.enabled = true` on the segment manifest AND patch
  its `script_clip_id` so the agent + renderer can link the segment
  to its clip without guessing. Older agent-authored manifests
  (which often omitted `enabled: true`) no longer mislead the user
  about what's wired up.
- **Rust recap-config defaults aligned with Python.** The Tauri
  `get_recap_config` was returning `target_duration_seconds: 0`
  and `outro.duration_seconds: 5.0` on fresh projects — bypassing
  the Python defaults (90s / 3s) the user had configured. Now both
  sides default to 1:30 target + 3s outro, and the Settings dialog
  shows those numbers populated immediately on a fresh open instead
  of zeros.
- **"Final needs re-render" banner** appears at the top of the
  Preview pane when TTS or captions have been regenerated since the
  last final render. Closes the "I regenerated my voiceover but
  nothing changed" gap — the fresh mp3/PNGs don't appear in the
  assembled mp4 until the user clicks Render in the TopBar, and now
  the UI says so explicitly. Banner dismisses when the final
  re-renders successfully. Backed by a `finalStaleToken` map in the
  store, keyed per-video so flags don't carry across video
  switches.
- **Preview footer is compact.** When the Inspector drawer is open
  (Preview shrinks), the footer used to wrap "Use Render in the
  top bar to regenerate" across three lines. It's now `truncate`-
  styled and pulls down to a single line; the segment-range
  readout sheds its "clip " prefix to save horizontal space.
- **Bumped window minimums** to `1180×720` (default size:
  `1440×900`). The previous `960×600` was too small to comfortably
  fit Videos sidebar + Preview + Inspector + Claude rail open at
  once — content was overlapping or wrapping. The window is still
  resizable; the user can collapse rails as they used to.

### Deferred (next turn): LLM-driven "regenerate with options"

The user asked for **"the captions if i want regenerated should
show me various caption options"** (and the same for voiceover
text). That's a substantial flow that wasn't shipped this turn —
captured here so it doesn't slip:

1. New Tauri command `claude_regenerate_options(segId, kind:
   "voiceover" | "captions", n_options: 3)` that builds a focused
   prompt via `clipwright agent prompt <seg>` and asks Claude
   for N alternative rewrites with the segment + full-project
   context. Returns `Array<{ id, text, rationale }>`.
2. Inspector's **Regenerate** button gains a dropdown menu: "Run
   with current text" (existing behavior) vs "Generate N options
   with Claude" (new flow).
3. A modal shows the N options with their rationales; user picks
   one, we write to `script.json` (for voiceover) or
   `captions/style.json` (for captions), then auto-trigger
   `clipwright tts-segment` / `clipwright caption-segment` to
   rebuild the asset. The stale-final banner already takes care
   of the "now re-render the final" hint.

Skipped this turn for scope; will pick up next.

### Added (API key management for OpenAI / ElevenLabs)

- **User-scoped credentials store** at
  `~/.clipwright/credentials.json` (honors `$CLIPWRIGHT_HOME` /
  `$XDG_CONFIG_HOME` for non-standard layouts). Atomic write via
  temp + rename; **`chmod 0600`** on Unix so other accounts on a
  shared machine can't scrape the file (best-effort no-op on
  Windows).
- **Env-var override.** `OPENAI_API_KEY` /
  `ELEVENLABS_API_KEY` beat the on-disk value when set — useful
  for CI / headless runs. An exported-but-empty env var
  (`export OPENAI_API_KEY=`) falls through to the file rather than
  shadowing it.
- **Frontend never sees the raw secret values.** The
  `get_credentials_status` Tauri command returns a presence-only
  view: `{has_openai_key, has_elevenlabs_key, openai_key_from_env,
  elevenlabs_key_from_env, credentials_path}`. So a stray
  `console.log` in dev tools can't leak the key. The settings
  dialog uses write-only password inputs.
- **Partial updates** — `set_credentials({ openai_api_key })`
  doesn't require re-typing the ElevenLabs key. Each field can be
  left `null` (don't touch), empty string (wipe), or a new value.
- **Project Settings → API keys section** under the project tab.
  Labeled "app-wide" so the user knows the values persist across
  projects. Each provider row shows:
  - Status badge: `configured` (file), `from env` (yellow — env
    var is providing the key), or `not configured` (gray).
  - A masked input that reads "•••••• (type to replace, leave
    empty to keep)" when a key is already stored.
  - **Save** button only enables when the input has content.
  - **Clear** button explicitly wipes a stored key (hidden when
    the env var is winning since you can't clear that here).
  - **"get key"** link to each provider's dashboard
    (`platform.openai.com/api-keys`,
    `elevenlabs.io/app/settings/api-keys`) so the user can grab a
    fresh key without leaving the dialog.
- **Inspector inline warning** — when a segment's Voiceover panel
  shows OpenAI or ElevenLabs as the provider and that provider's
  key isn't configured, an amber banner appears between the
  picker and the action buttons: "OpenAI API key is not
  configured. Open Settings → API keys (gear icon in the top
  bar) to paste your key, or set the OPENAI_API_KEY env var.
  Regenerate will fail without it." Hidden for local providers
  (Kokoro / Piper) which don't need keys.
- **`is_provider_configured(provider)`** Python accessor in the
  new `clipwright.credentials` module — used by callers (and
  available to the TTS pipelines) to fail-fast with a clear
  message before spending render time on a doomed turn. Local
  providers always return True; paid providers check the
  file/env resolution.
- **9 new Python tests** cover round-trip persistence, malformed
  JSON tolerance, env-over-file precedence, blank-env fall-
  through, `chmod 0600` enforcement, `is_provider_configured` per
  provider including case-insensitivity. Suite: **295 Python
  tests passing** (was 286 + 9).

### Fixed + Added (Inspector pushes, Segment plays clipped final, dropdowns, per-video overrides)

- **Inspector drawer now pushes the Preview, not overlays it.** The
  previous absolute-positioned drawer sat on top of the Preview and
  felt like it overlapped the Claude rail. The middle column is now
  a flex row: Preview takes the remaining space, the Inspector
  occupies a fixed 420px on the right when open, 0px when closed.
  Smooth `width` transition; Preview always fully visible (just
  smaller).
- **Segment mode no longer asks for per-segment renders.** It now
  plays the assembled `out/final/<video>.mp4` clipped to the
  selected segment's time range (auto-seek to `seg.start`,
  auto-pause at `seg.end`). One mp4 drives both modes — the toggle
  just changes which slice plays. The "Render Preview" button is
  gone from Segment mode (it was redundant with the TopBar Render);
  the footer instead shows `clip 0.0s → 5.0s` so the user knows the
  active range.
- **Timeline lanes now fill the full container width.** Previously
  the lane background ended at `totalDuration * pxPerSec`, leaving
  dead gray space on the right when the timeline was shorter than
  the viewport. Lanes (and the time ruler) now `flex-1` past the
  content width, with `minWidth` preserved so scrolling still
  works for long timelines. The trailing space reads as the same
  lane, not as void.
- **Provider + Voice dropdowns** in the segment inspector.
  Replaced two free-text inputs with two dependent themed
  `Dropdown`s sourced from a new voice catalog
  (`desktop/src/lib/voiceCatalog.ts`). Provider options:
  **Kokoro** (local, free, default), **OpenAI** *(new — alloy, echo,
  fable, onyx, nova, shimmer)*, **ElevenLabs** (Rachel/Domi/Bella/
  Antoni/Elli/Josh/Arnold/Adam/Sam), **Piper** (curated en_US/en_GB
  medium-quality voices). Each option has a one-line hint shown in
  the menu and as the trigger tooltip.
  - **Voice picker is provider-aware**: switching provider snaps
    the voice to that provider's default unless the previous voice
    is in the new catalog. No more `af_sky` left over when you
    switch to OpenAI.
  - **OpenAI added as a Python TTS provider** (`VALID_TTS_PROVIDERS`
    in `src/clipwright/schema/v2/project.py`) so projects with
    `tts_provider: "openai"` validate cleanly.
- **Per-video recap overrides.** New optional field
  `Video.recap_overrides: dict[str, Any]` carries per-video values
  for: target duration (already a separate field), narration style,
  additional notes, outro description, outro duration, voice
  provider, voice id. The agent prompt resolves each field
  per-video → per-project → cyberpunk-title default. Per-video
  values are surfaced in the prompt with their scope made explicit
  (*"Target duration: 240 seconds for this specific video (per-video
  override; project default is 90s)."*).
- **Project Settings dialog → two-tab layout.** A new tab bar at the
  top of the dialog switches between **"Project default"** (the
  existing script + outro panels) and **"This video · <video_id>"**
  (the new per-video overrides). The per-video tab shows the
  project default next to each field as a placeholder so the user
  always knows what they'd be overriding. Saving the video tab
  writes to `Video.recap_overrides` via `save_video`; clearing a
  field removes the override key so the project default takes
  over. Per-video voice override uses the same Dropdown pair with
  an explicit `(use project default)` first option.
- **Schema migration:** `Video.from_dict` tolerates missing
  `recap_overrides` (defaults to `{}`); `to_dict` only emits it
  when non-empty so untouched manifests stay clean.

### Fixed (Captions track clipped) + Added (Inspector as on-demand drawer)

- **Timeline now fits all three tracks.** The bottom strip was
  allocating 160px; the new track heights (header 32 + ruler 24 +
  video 52 + audio 32 + captions 28 + gaps + padding) wanted ~220px,
  so the Captions lane was getting hidden under the status bar.
  Bumped the workspace's timeline slot to 220px — all three lanes
  now render with clear margins above and below.
- **Inspector is a slide-in drawer**, not a permanent panel.
  Previously the per-segment editor sat below the Preview pane and
  ate ~30% of the vertical real estate at all times. Most of the
  time you don't need it — selection is enough; the trim /
  voiceover / captions form is a "when I want to edit this one
  thing" surface.
- **Drawer behavior:**
  - **Anchored to the right edge of the middle column**
    (between Preview and Claude rail), 420px wide, absolute-
    positioned so the Preview keeps its full size when closed.
  - **Slides in via `translate-x` transition** with `pointer-events-
    none` when off-screen so it can't intercept clicks on the
    Preview underneath.
  - **Header** shows `Inspector · seg_NNN` for the currently-
    selected segment and a close (X) button.
  - **ESC closes** — standard modal-ish convention.
- **Four discoverable ways to open the inspector:**
  - **TopBar button** — new `Inspect` button (lucide
    `SlidersHorizontal` icon) with active state when the drawer
    is open.
  - **Double-click any segment block** in the Timeline — works
    on all three lanes (Video, Audio, Captions).
  - **Segment context menu** — new top item `Inspect (⏎)`.
  - **Enter key** when a segment is selected — keyboard-only flow.
- **Preview now fills the full middle column when the drawer is
  closed**, which is the default state on every project open. No
  more 30% tax on vertical screen real estate for a panel you don't
  need most of the time.

### Added (CapCut-style timeline UI)

- **Distinct track lanes.** The three tracks (Video / Audio /
  Captions) now read as actual lanes, not just stacked flex rows.
  Each gets:
  - **Its own color identity** — blue for video (primary lane,
    52px tall), purple for audio (32px), amber for captions (28px)
  - **A 3px accent stripe** running through the label gutter so you
    can tell the lane apart even when the label is scrolled out
  - **A lucide icon** in the label gutter (Film / Volume2 / Captions)
    next to the lane name
  - **A tinted gradient background** on the lane floor so the row
    has a clear top/bottom edge
- **Per-clip visual identity per track:**
  - **Video clips** keep the full label + duration + chapter chip
  - **Audio clips** render a **stylized waveform** (24 vertical bars
    with stable pseudo-random heights keyed by the segment id — same
    seg always renders the same bars, no per-render reshuffle).
    Real mp3 waveform extraction is a P2 polish pass; this is the
    visual standin meanwhile.
  - **Caption clips** render a `cc · <label>` peek when wide enough,
    or `cc · seg_NNN` on tight clips so we never visually crash
- **Transport in the Timeline header.** A play/pause button + a
  monospace `mm:ss.t / mm:ss.t` timecode readout sit at the left of
  the Timeline header (CapCut puts these at the bottom of the
  viewport — same shape, same affordance). The play button mirrors
  the playback state (accent-filled when playing, raised-bg when
  paused) and dispatches `requestPlayPause` into the store →
  Preview's `<video>` honors it.
- **Spacebar toggles play/pause** anywhere in the workspace (not
  while typing in a textarea/input — the existing `isInTextField`
  guard prevents that). Standard editor convention.
- **Cleaner selected-clip highlight** — selected clips now get a
  2px accent `ring-2` (was 1px) plus `z-[5]` so they pop above
  neighbors instead of getting clipped by overlapping borders.

### Fixed (Final video wasn't displaying) + Added (scrubber + playhead)

- **Final-mode `<video>` couldn't load the mp4.** The Tauri asset
  protocol scope was still pinned to v1 paths
  (`**/out/final.mp4`, `**/out/segments/*.mp4`), so the v2 paths
  (`out/final/<video_id>.mp4`, `out/segments/<video_id>/<seg>.mp4`)
  failed `convertFileSrc()` access checks — the `<video>` element
  fired `onError` and the Preview pane fell back to the "No final
  render yet" placeholder even when the mp4 sat right there on
  disk. Scope updated to:
  - `**/out/final/*.mp4` + legacy `**/out/final.mp4`
  - `**/out/segments/**/*.mp4` (recursive — covers per-video dirs)
  - `**/sources/panels/**/*.{webp,png,jpg,jpeg}` (manhwa-recap
    panel sources)
  - Existing source-video extensions kept for back-compat.
- **CapCut-style scrubber + playhead.** The Timeline now has a
  vertical playhead with a grab handle that tracks the `<video>`
  element's currentTime in real time. Three new interactions:
  1. **Click the time ruler** at any position → video seeks there.
  2. **Drag the playhead handle** → live scrub through the video
     (window-level pointermove listener so a fast scrub doesn't
     drop frames when the cursor leaves the strip).
  3. **Click a video block in Final mode** → seek + select. In
     Segment mode the click still just swaps the selected segment
     since the per-segment preview starts at 0 of its own clip.
- **Playback state lifted into the store** so the Preview pane
  (owns the `<video>`) and the Timeline (draws the playhead) can
  stay in sync without prop drilling:
  - `playbackTime` updated 4× per second via `onTimeUpdate` from
    Preview, read by Timeline to position the playhead overlay.
  - `playbackPlaying` mirrors play/pause so the playhead gets a
    subtle glow during playback.
  - `seekRequest: { time, token }` is the one-shot signal —
    Timeline writes; Preview's `useEffect` watches the token and
    calls `video.currentTime = time`. The token bumps every
    request so clicking the same playhead position twice still
    re-seeks (paused-frame use case).
  - `playbackMode` mirrors Preview's Segment/Final toggle so the
    Timeline knows whether the playhead is plotted against
    segment-local time or the assembled final timebase. Switching
    modes resets the playhead since the timebases don't translate.
- In **Segment mode** the playhead is positioned as
  `selectedSegment.start + video.currentTime` so a per-segment
  preview at t=1.2s shows the playhead at segment-start + 1.2s on
  the global timeline — same visual position as if you were
  playing the assembled final at that point.
- Scrubbing in Segment mode that crosses into a different segment
  auto-selects that segment and seeks the (newly-loaded) per-segment
  video to the right local time.

### Added (Defaults rebalance + per-video override + multi-track Timeline)

- **New project defaults**:
  - **Target duration: 1:30 (90s)** — every project starts with a
    concrete duration instead of "unset, fall back to template".
  - **Outro duration: 3s** (was 5s).
  - **Outro description fallback** — when the user hasn't typed
    one, the agent prompt now uses a cyberpunk-themed default:
    *"Cyberpunk-themed outro card. Project title \"<title>\" appears
    center-screen in a neon-accented sans-serif over a deep
    blue/violet background with subtle scanline/glitch. Voiceover (1
    line): tease the next chapter and prompt a follow."* The project
    title is injected so every outro is self-branded.
  - The Project Settings dialog's outro placeholder + preview banner
    show the cyberpunk-title default verbatim so the user can see
    what Claude will be told before typing their own.
- **Per-video target duration override.** Each video now has an
  optional `target_duration_seconds_override` field on its manifest.
  When set, it beats the project-level default in the agent prompt
  — useful for "this one chapter needs 3 minutes even though the
  project default is 90s". A new badge in the Timeline header
  (`TARGET 90s · project`) shows the effective value and the source
  (`project` / `override`). Click → inline number input → save flows
  through `save_video`, the next Claude turn picks up the change.
  The agent prompt phrasing tells Claude exactly which scope applies:
  *"Target duration: 240 seconds for this specific video (per-video
  override; project default is 90s)."*
- **Multi-track Timeline.** The Timeline pane now renders three
  horizontal lanes — **Video**, **Audio**, **Captions** — aligned on
  a single time axis with a nice tick ruler (2s/5s/10s/30s/etc. by
  zoom level), inspired by Remotion's timeline demo. Each segment
  occupies the same horizontal slice on all three rows; the Video
  block carries the label, while Audio + Captions blocks tint
  differently (blue / amber) and indicate availability with a
  dimmed style when the matching `voiceover.enabled` /
  `captions.enabled` ref is off. The right-click "Ask Claude…"
  context menu works from any track — every block shares the same
  handler, so you can right-click whichever lane is most visible
  for the segment you want.
- **Tests** updated to reflect new defaults (target=90, outro=3) +
  added coverage for the cyberpunk-title fallback (with and without
  a project title), per-video override winning in the agent prompt,
  and the "no override → project default" labeling. Suite: **286
  Python tests passing** (was 280 + 6 net new).

### Added (Final-video preview + Project Settings dialog)

- **`Segment` / `Final` preview toggle.** The Preview pane now has
  a mode toggle at the top: `Segment` shows the cached per-segment
  render (existing behavior); `Final` plays the assembled
  `out/final/<video_id>.mp4`. Closes the "I rendered a video, where
  is it?" gap — manhwa-recap renders monolithically through Remotion
  and never produces per-segment caches, so the user previously had
  no way to see their finished video inside the app.
- **Mode-aware empty states** — when Final has no file yet, the
  placeholder reads "No final render yet · Click Render in the top
  bar" (instead of the segment mode's "Click Render Preview below").
- **Mode-aware footer** — Final hides the per-segment Render Preview
  button (irrelevant) and shows a hint pointing at the TopBar Render.
- **Project Settings dialog** (TopBar gear icon) — per-project
  preferences that flow into Claude's system prompt and OVERRIDE the
  template's defaults:
  - **Target duration in seconds** — fixes "the LLM compressed my
    3-min recap into 60s to fit the template". When set, the prompt
    section explicitly tells Claude "USE 180s (write 25–35 segments
    of 5–8s each instead of 12 segments)" so it stops compressing.
  - **Narration style** — one-line voiceover direction.
  - **Additional notes** — free-form project memory (audience, tone,
    no-go topics, recurring character names).
  - **Outro spec** — reusable description + target duration. Claude
    appends a matching final segment to every video in the project,
    so the user describes their outro once and every chapter video
    closes the same way. The agent prompt tells Claude to mark this
    segment `scene_type: "outro"` so the renderer can treat it
    specially.
  - **Live preview banner** in the dialog shows exactly what gets
    injected into the next Claude turn — no overrides means no
    section, so brand-new projects don't get a noisy prompt.
- **Storage** at `<project>/.clipwright/recap-config.json` —
  follows the same per-project sidecar pattern as
  `claude-permissions.json` / `claude-timeout.json`. Atomic write
  via temp + rename. Tolerant load (malformed JSON → defaults, legacy
  string-only outro shape upgraded to the structured shape).
- **Settings button now functional** — the TopBar's gear icon
  previously read "Settings (P1.x)" and was disabled. Now opens the
  new dialog.
- **9 new tests** cover the round-trip persistence, malformed-JSON
  tolerance, the `has_overrides` flagging, prompt section omission
  when defaults, and each override (duration / narration / notes /
  outro) ending up in the rendered system prompt with the right
  emphasis. Suite: **280 Python tests passing** (was 271 + 9).

### Fixed (Wall-clock timeout was too tight for real recap workflows)

- **Wall-clock default raised from 10 min → 2 hours** and made
  per-project overridable. (Originally bumped to 30 min, then to 2 h
  per user feedback — multi-chapter and longer-arc recaps need the
  headroom.) Real manhwa-recap turns routinely run
  15–25 minutes: Claude downloads 30–80 panel images, reads several
  of them, writes a 12–18 segment manifest, runs `tts-segment` +
  `caption-segment` + `render-segment` per segment, then
  `render-final` through Remotion. The previous 10-min cap was
  killing actively-working turns mid-render.
- **Per-project override** at `<project>/.clipwright/claude-timeout.json`:
  `{"wall_seconds": <int>}`. Clamped to `[60, 14400]` (1 min .. 4
  hours) so a typo can't disable the cap entirely. Power users
  running unusually long workflows (multi-chapter recaps, longer
  manga arcs) can dial up without touching code.
- **Timeout error now mentions the escape hatches.** "Hit Cancel to
  stop a long turn at any time, or raise this cap by writing
  `{"wall_seconds": <int>}` to <project>/.clipwright/claude-timeout.json
  (default 1800s, max 14400s)." Points at both the immediate
  in-app action and the persistent override.
- **The idle timeout (120s of silence) is unchanged** — that's the
  real "Claude is genuinely stuck" backstop and a healthy
  long-running turn never trips it because stream-json emits
  events constantly.

### Added (Custom themed dropdown)

- **One reusable `Dropdown<T>` component** replaces every native
  `<select>` in the app. The macOS native menu rendered white-on-blue
  on top of our dark UI — looked broken even when it wasn't. The new
  one matches our theme tokens (bg-raised menu, accent-tinted selected
  row with a Lucide `Check`, hover highlight, Lucide `ChevronDown`
  trigger), keeps every native affordance, and adds a few:
  - **Keyboard nav** — ArrowUp/Down/Home/End, Enter to pick, Escape to
    close, Tab to escape without picking.
  - **Click-outside to close** via a document-level mousedown listener
    active only while open.
  - **Auto-scroll** the highlighted row into view as the user arrow-keys.
  - **Per-option hints** — `option.hint` shows as a small-text
    description in the open menu AND as the trigger's `title` tooltip
    when that option is selected (preserves the contextual help the
    old `<select>` had via `<option title>`).
  - **Layout variants** via `triggerClassName` + `wrapperClassName` —
    the same component renders as a tiny mono badge in the rail header
    AND as a full-width form input in the Inspector.
- **Three call sites converted**: the rail's model picker and
  permission-mode picker (right-aligned mini dropdowns with hint
  rows for each option's policy), and the Inspector's per-segment
  Source picker (full-width form variant). No more white-on-blue
  flash on macOS.

### Added (Remotion `ManhwaRecap` composition — visual P2)

- **A second Remotion composition** alongside the legacy
  `ClipwrightVideo`, dedicated to the manhwa-recap template (and any
  future panel-based preset). Lives at
  `remotion/src/ManhwaRecap.tsx`; `Root.tsx` registers both
  compositions so the Python backend picks one by template_id.
- **`PanelSegment` renderer** — each segment shows a still panel
  with native Ken Burns motion (zoom + pan_x + pan_y interpolated
  per-frame), an audio track, themed captions, and a chapter chip
  overlay. With no camera keyframes a gentle default 1.0→1.08 zoom
  applies so even untouched panels feel alive — static is opt-in.
- **`ChapterChip` overlay** — top-right badge per segment that fades
  in over 0.3s, dwells, and fades out before the segment ends. The
  chip background uses the active theme's accent color so dark-
  fantasy, cyberpunk, romantic, and minimal-dark all look distinct
  from one chip component.
- **Theme tokens** — `dark-fantasy` (near-black + blood-red),
  `cyberpunk` (deep blue/violet + neon cyan), `minimal-dark`
  (charcoal + light grey), `romantic` (warm dark + rose). Each
  theme carries `{background, accent, accentFg, chipBorder,
  captionFg, captionBg}` so adding a new theme is a 6-color JSON
  entry in `remotion/src/themes.ts`.
- **`manhwa_backend.py` builder** — assembles the `ManhwaInputs`
  props JSON from a v2 project's per-video tree:
  - **Asset staging** under `remotion/public/_manhwa/<video_id>/`
    (`panels/<seg>.<ext>` + `audio/<seg>.mp3`) so Remotion's
    `staticFile()` can resolve everything.
  - **Camera-keyframe translation** — reads `<project>/camera/<seg>.json`
    with the new `{t, zoom, pan_x, pan_y}` shape AND tolerates the
    legacy `focus: [x, y]` shape from `clipwright.outro.camera` by
    translating focus anchors to pan deltas.
  - **Caption synthesis** — coalesces word-level voiceover
    timestamps (`<seg>.timestamps.json`) into 5-word chunks so
    captions read like Reels-style sentences, not word-by-word
    strobing. Falls back to whole-segment script text when
    timestamps are absent.
  - **Theme defaults** — picks `dark-fantasy` for `manhwa-recap-*`
    templates and `minimal-dark` for `product-demo`. The Python
    side accepts a `theme_override` parameter for future UI
    customization.
- **`render-final` template-aware dispatch.** When a project's
  `template_id` resolves to a template with `render_preset`
  starting with `manhwa-recap`, `render_final` routes through the
  new Remotion backend instead of the per-segment ffmpeg concat
  path. Everything else still falls through to the legacy
  recording-mode path — no behavior change for existing projects.
- **New `panel` scene_type.** The Segment schema gained `"panel"`
  as a valid `scene_type` so a manhwa-recap segment with `kind:
  "scene"` is schema-conformant. The other types (title, broll,
  outro, intro, hero) are untouched.
- **10 new tests** cover: per-segment input building, asset
  staging into Remotion's `public/`, caption synthesis from
  timestamps, camera keyframe pass-through (both new and legacy
  `focus` shapes), missing-source error path, zero-segments error,
  theme defaulting + override, and the `render-final` dispatch
  hook. Suite: **271 Python tests passing** (was 261 + 10).

### Fixed (silent permission timeout) + Added (model selector + tool drawer)

- **Auto-edits silent-timeout fixed.** The previous allow list only
  covered `WebFetch`, `WebSearch`, and `Bash(clipwright …)`. Any
  other tool (Read/Glob/Grep, `Bash(curl …)`, `Bash(ffprobe …)`,
  `Bash(ls …)`, `Task`, …) hit the CLI's implicit dialog, which
  can't render in `--print` mode — so the call just hung silently
  until our 120s idle timeout fired with the misleading "stuck on a
  permission prompt" message. No prompt was ever shown to the user
  because no prompt could exist.
  - Broadened `ALLOWED_TOOLS_FOR_ACCEPT_EDITS` to cover read-only
    file tools (`Read`, `Glob`, `Grep`, `LS`), `Task` for subagent
    dispatch, and the common shell prefixes a recap turn needs:
    `curl`, `wget`, `ffmpeg`, `ffprobe`, `mkdir`, `cp`, `mv`, `ls`,
    `find`, `cat`, `head`, `tail`, `jq`. Destructive patterns (`rm`,
    `curl | bash`) are deliberately still excluded — bump to `yolo`
    when you trust the turn.
  - **Better timeout message.** The idle-timeout error now reads
    "no output for 2 minutes. Claude likely tried a tool that's not
    in the auto-edits allow list — the CLI silently denies it in
    `--print` mode. Switch the rail's permission mode to `yolo` if
    you trust the turn, or describe the blocked command and we'll
    add it to the allow list." Points at the real escape hatch
    instead of inventing a fictional permission prompt.
- **Tool execution drawer.** Every tool chip in the live assistant
  bubble is now clickable: it expands a JSON-formatted drawer
  showing the `input` Claude sent and the `output` (or `tool_result`
  content) it got back. Useful for debugging "why did this turn go
  sideways" without re-running. Strings over 10KB truncate with a
  count so a giant file dump doesn't blow up the rail.
- **Per-project Claude model picker** in the rail header. New
  `<select>` next to the permission-mode picker, with options:
  `default` (CLI config), `sonnet`, `opus`, `haiku`. The choice
  persists to `<project>/.clipwright/claude-model.json` and passes
  through as `--model <name>` to every chat turn. Useful to bump up
  to Opus when a recap needs more visual-storytelling quality.

### Added (Manhwa recap — visual quality rewrite)

- **`manhwa-recap-single` template rewritten** for an aggressive
  panel-level workflow. The previous version gave high-level
  structure ("5 beats, ~60s") but no concrete steps — Claude
  invented its own approach and produced static slideshow output.
  The new prompt mandates a 6-step workflow with explicit panel
  enumeration and Ken Burns animation per segment:
  1. **Enumerate every panel** — WebFetch the chapter page,
     extract image URLs, `curl` each to
     `sources/panels/<chapter>/p<NN>.webp`, run `ffprobe` for
     dimensions.
  2. **Read the panels** — actually inspect the artwork before
     writing script, group panels by beat in
     `notes/panels.md`.
  3. **Write the script from the panels** — not the other way
     around. Each clip references its panels.
  4. **Plan 12–18 segments** (not 5) — each panel-on-screen 4–8s
     with `kind: "scene"`, `source: sources/panels/.../pNN.webp`,
     proper v2 schema.
  5. **Camera moves per segment** — write `camera/<seg_id>.json`
     with Ken Burns keyframes. Slow zoom-in, pan-down on tall
     panels, quick punch-in on fight panels. Every segment should
     have motion; static is the exception.
  6. **Drive the per-video pipeline** — `clipwright tts-segment`
     → `caption-segment` → `render-segment` → `render-final`, all
     with `--video <id>`.
  - Explicit anti-patterns list: don't write 5 long static
    segments, don't use the Playwright recording as source, don't
    invent schema fields, don't run `render-final` without `--video`,
    don't ask the user to "approve the prompt."

### Added (`clipwright video doctor`)

- **Audit a video's pipeline completeness without burning render
  cycles.** New `clipwright video doctor <video_id>` walks the
  per-video artifact tree and reports, in ~1 second, every gap that
  would otherwise show up as a silent failure (or worse, a 10-minute
  Claude timeout):
  - **Source coherence** — does the source file exist? Is its
    duration enough to cover every segment's `source_start..source_end`
    range? (Catches "you wanted 58s of footage from a 7.8s recording.")
  - **Invented-schema detection** — flags any segment object whose
    JSON has keys outside the legal v2 set (`source`, `source_start`,
    `source_end`, `target_duration`, `kind`, `scene_type`, `label`,
    `chapter`, `voiceover`, `captions`, `camera`, `annotations`).
    Catches Claude writing manifests with custom shapes like
    `panels: [{url, camera}]` or `beat` instead of `chapter` — the
    dataclass loader silently drops them, so the timeline looks empty
    without explanation.
  - **Per-segment coverage** — voiceover mp3, timestamps, caption
    PNG frames, per-segment mp4 render.
  - **Final render staleness** — flags when `out/final/<id>.mp4` is
    older than the newest per-segment render.
- **`--json` flag** for desktop consumption (a future "Doctor" tab
  in the rail header can render the same structured report).
- **System-prompt hardening.** Two new constraints in the agent
  prompt:
  - "Use the v2 segment schema exactly. Do not invent fields." Lists
    every legal key and explicitly forbids `panels`, `beat`, `theme`,
    `url`, etc.
  - "Drive the pipeline through the per-video CLI commands." Lists
    the exact invocations (`clipwright tts-segment --video …`,
    `clipwright render-segment --video …`, `clipwright render-final
    --video …`) and forbids the legacy `clipwright render-final`
    without `--video`.
  - Also adds: "if you're stuck, STOP and run `clipwright video
    doctor`" — so Claude diagnoses instead of retrying for 10 minutes.
- **6 new tests** cover the doctor: missing-vo/render, empty
  source-range, invented-schema detection, happy-path no-issues,
  unknown video_id, and CLI `--json` output. Suite: **261 Python
  tests passing** (was 255 + 6).

### Added (Adopt v1 artifacts into v2 videos)

- **`clipwright video adopt <id>` — recover hybrid projects.** A
  project can land in a confused state when Claude (or the user)
  drives the legacy `clipwright render-final` flow inside a project
  that's already been migrated to v2: the final mp4 renders to
  `out/final.mp4` (flat), the script lives at `script.json` (root),
  and the v2 video manifest at `videos/<id>.json` stays with an
  empty `segments[]`. The desktop has nothing to show, even though
  a perfectly good rendered video exists on disk.
- **`adopt_v1_artifacts(project_dir, video_id)`** now:
  1. **Relocates** the flat artifacts into per-video v2 paths —
     `script.json` → `voiceover/scripts/<id>.json`,
     `out/final.mp4` → `out/final/<id>.mp4`,
     `out/segments/*.mp4` → `out/segments/<id>/`,
     `voiceover/audio/*.mp3` → `voiceover/audio/<id>/`,
     `captions/<seg>/` → `captions/<id>/<seg>/`. The `_work/` subdir
     and any already-correct v2 paths are left alone.
  2. **Rebuilds the manifest's `segments[]`** from `script.json`
     clips paired with `out/edl.json` source ranges (1-to-1 when
     counts match; falls back to `0..target_seconds` per clip
     otherwise, with a warning). Each segment gets a fresh `seg_NNN`
     id, the right `voiceover.script_clip_id`, a synthesized
     captions ref, and the recorder's `source` path.
- **Idempotent.** A second `adopt` call after success is a no-op:
  existing v2 paths short-circuit the file moves, and a populated
  `segments[]` short-circuits the rebuild.
- **CLI.** `clipwright video adopt <video_id> [--project DIR]`
  prints each moved path and any warnings. The user's report ("the
  rendered video isn't showing up") fixes in one command.
- **7 new tests** cover the relocation, segment rebuild, idempotence,
  EDL-missing fallback, no-op-on-clean-v2 case, two-script collision
  warning, and the CLI surface. Suite: **255 Python tests passing**
  (was 248 + 7).

### Fixed (WebFetch / WebSearch permission gap)

- **`auto-edits` mode now pre-approves WebFetch and WebSearch.**
  Previously the auto-edits allow-list only covered `Bash(clipwright
  …)`, so when Claude tried to fetch a manhwa chapter URL it asked
  the user to run `/permissions add WebFetch` — which is an
  interactive Claude Code command unreachable from our headless
  `--print` invocation. Manhwa-recap and product-demo templates
  routinely need WebFetch to pull source pages, so this was breaking
  the happy path on day one. Both `WebFetch` and `WebSearch` are now
  in the `--allowedTools` list when the mode is `acceptEdits`.
- **System prompt updated** to reflect the broader pre-approved tool
  set and to explicitly forbid telling the user to run
  `/permissions add ...` (it doesn't work in `--print` mode). The
  prompt now lists File tools (Read/Glob/Grep/Edit/Write/MultiEdit),
  Network tools (WebFetch/WebSearch), and Shell prefixes
  separately so Claude knows exactly what's safe to invoke without
  prompting.

### Added (Streaming Claude rail + smarter timeouts)

- **Claude replies now stream live into the rail.** The Rust runner
  now invokes `claude --print --verbose --output-format stream-json`
  and forwards each parsed line to the frontend as a Tauri event
  (`claude:turn`). A new `LiveAssistantBubble` grows in real time as
  text blocks land, and `tool_use` events render as labeled chips
  (`🔧 Bash · running`) that flip to `ok` or `error` when their
  matching `tool_result` arrives. The user sees Claude working
  rather than staring at a static `thinking…` placeholder.
- **Idle-aware timeouts.** The old single 180s wall cap was killing
  legitimate long video-generation turns. The new policy:
  - **Wall cap**: 600s (10 min) — enough for a full
    record → segment → caption pass even on a cold machine.
  - **Idle cap**: 120s — if the CLI emits NO output for two
    minutes, kill it. Stream-json mode produces lines every few
    seconds during a healthy turn; complete silence is the
    "stuck on a permission prompt" signal.
  - The idle clock resets to zero on every received line, so a
    long-but-active turn never trips it.
  - Timeout errors now include a reason (`wall-clock cap` /
    `no output (likely stuck on a permission prompt)`) so the
    failure mode is legible.
- **Per-video scoped events.** Each `claude:turn` event carries the
  `video_id` of the chat it belongs to. The rail filters by the
  currently-loaded video so a long-running chat in chapter-2 doesn't
  pollute chapter-1's rail when the user switches between videos
  mid-turn.

### Removed

- The old non-streaming `run_claude` + `parse_claude_json_output`
  pair, replaced by `run_claude_streaming`. The 5 parse-output unit
  tests went with them since the new pipe parses incrementally.

### Added (Lucide icon pack + ConfirmDialog)

- **Proper icon pack.** Installed `lucide-react` and swapped every
  emoji/text glyph in the chrome for crisp Lucide icons: `Trash2`,
  `ChevronLeft/Right`, `Plus`, `Video`, `Film`, `MessageSquare`,
  `Sparkles`, `Settings`, `Play`, `Square`, `RotateCcw`, `X`,
  `Check`, `CheckCircle2`, `AlertTriangle`, `XCircle`, `Loader2`,
  `Upload`, `FolderOpen`. Covers the TopBar, VideoSidebar (both
  expanded and collapsed strips), ClaudeRail (header buttons + Fresh
  + Cancel + scoped-chip clear), StatusBar doctor indicator, Hub
  action cards, and every modal's close button. Emoji-glyph usage
  is now reserved for the few places it carries meaning (keyboard
  shortcuts like `⌘K`, `⌘+/-`).
- **`ConfirmDialog` — reusable modal for destructive actions.**
  One canonical shape: title with `AlertTriangle` icon, description,
  optional bulleted "consequences" panel, danger-tone Confirm
  button, focus-on-Cancel for keyboard safety. Supports async
  confirm handlers with `Loader2` spinner while in-flight; ESC
  closes; X button in the header. Used to replace the previous
  two-click arming pattern for video deletion.

### Fixed (Video deletion UX)

- **Video delete now uses a proper confirmation dialog.** The
  previous two-click arm-then-confirm pattern auto-disarmed after
  4s — if the user didn't click again fast enough, the delete
  silently never ran, which was the "I deleted a video and the
  sidebar didn't update" report (the click never landed). The new
  `ConfirmDialog` blocks the entire app until the user explicitly
  picks Confirm or Cancel, lists exactly what will be wiped
  (manifest + 8 artifact locations), and shows the video's title
  in the description so you can't misidentify the target.
- **Sidebar refresh on delete is now guaranteed.** The Rust
  `delete_video_cmd` already returned a fresh `ProjectState` and
  the store replaced `project` wholesale on success — but with the
  arming pattern, the delete often didn't run in the first place.
  With the modal flow, every confirmed delete reaches the Tauri
  command, the store gets the fresh state, and the sidebar
  re-renders with the deleted row gone and a surviving video
  selected.

### Fixed (Stale Videos sidebar after create)

- **Newly-created videos now appear in the sidebar immediately.**
  Previously, `createVideo` + `switchVideo` only refreshed
  `project.current_video_id` and `project.video` (the loaded
  manifest), leaving `project.videos` (the catalog the sidebar maps
  over) stale until the next project re-open. The new video would
  only show after restarting the app or re-opening the project.
  `switchVideo` now re-enumerates the catalog in parallel with the
  per-video load so a one-trip-to-disk refresh keeps everything in
  sync. Same fix benefits any future flow that creates a video
  outside the desktop's eye (e.g. the user editing files on disk).

### Added (Delete video entries)

- **Delete a video from a project.** Hover any row in the Videos
  sidebar → a 🗑 trash icon appears on the right; click once to arm
  (turns warn-color), click again within 4s to confirm. Wipes the
  manifest plus every per-video artifact tree:
  - `videos/<id>.json`
  - `voiceover/audio/<id>/`, `voiceover/scripts/<id>.json`
  - `captions/<id>/`
  - `out/segments/<id>/`, `out/final/<id>.mp4`
  - `chat/sessions/<id>/`, `.clipwright/claude-sessions/<id>.txt`
  Shared project state (`project.json`, `sources/`, other videos)
  is untouched. After delete the workspace lands on the first
  surviving video automatically.
- **Last-video guard.** The project's only remaining video can't be
  deleted — the trash button renders disabled with an explanatory
  tooltip ("Can't delete the project's only video. Create another
  first."), and the Python/CLI/Tauri layers all enforce the same
  rule with a clear error message.
- **CLI surface.** `clipwright video delete <id> [--yes]` mirrors
  the desktop posture: prints a confirmation warning without
  `--yes`, performs the delete with it.
- **Idempotent.** Re-running `delete_video` on an already-deleted id
  is a clean no-op (returns empty list), so a retry after a
  half-failed delete doesn't error.
- **7 new tests** cover happy path, last-video refusal, idempotence,
  project-metadata survival, and the CLI's `--yes` gating. Suite:
  **248 Python tests passing** (was 241 + 7).

### Added (User-defined templates)

- **Templates can now live in the user's home dir.** The loader merges
  `~/.clipwright/templates/data/*.json` with the shipped catalog, and
  user templates win on `template_id` collision — so a writer can
  locally override `manhwa-recap-single` by dropping a same-id file in
  their user dir without forking the package. Honors
  `$CLIPWRIGHT_HOME` and `$XDG_CONFIG_HOME` for non-standard layouts.
- **CLI scaffolder.** `clipwright templates new <id>` writes a starter
  JSON file with TODO markers for `name`, `summary`, and
  `system_prompt`. `--from <existing-id>` clones an existing template
  to fork off — handy when iterating on a tweak to a shipped
  template. `--force` overwrites; refuses by default to avoid
  clobbering a half-edited file. The created file's path is printed
  so you can pipe it to `$EDITOR`.
- **Locator commands.** `clipwright templates path` prints the user
  templates dir (so you can `cd $(clipwright templates path)`).
  `clipwright templates path <id>` prints the on-disk path of one
  template — works for both shipped and user templates, so you can
  edit either:

      $ "$EDITOR" "$(clipwright templates path manhwa-recap-single)"

- **`source` provenance.** Every template now carries `source:
  "shipped" | "user"`. The desktop picker renders a small "USER"
  badge on user templates so they're visually distinguishable from
  the built-in catalog. Catalog ordering: sorted by category, then
  name — stable regardless of which dir contributed each entry.
- **8 new tests** cover the merged loader, the user-wins lookup, the
  CLI scaffolder's blank + clone paths, the `--force` refusal, and
  the `path` commands. Suite: **241 Python tests passing** (was
  233 + 8).

### Added (Template defaults propagation)

- **Template defaults now flow into `project.json` on bind.**
  `clipwright templates apply` writes the template's recommended
  `aspect`, `fps`, `tts_provider`, and `voice_id` into the project.
  Default posture is non-destructive — only blank/missing fields get
  filled, so a user's explicit choice survives a template rebind.
  Pass `--overwrite-defaults` to force replacement (used internally
  when the user explicitly picks a template at project creation).
- **New Project form syncs aspect to template recommendation.**
  When the user picks a template in the New Project dialog, the
  AspectPicker auto-jumps to the template's recommended aspect
  (9:16 for manhwa recaps, 16:9 for product demos). A manual click
  on the picker flips an `aspectTouched` flag and stops the sync —
  the user's choice survives. The hint under the picker reads
  "from template default" or "overriding template recommendation
  (X)" so the relationship is never silent.
- **TopBar template badge renders the friendly name.** Previously
  showed the raw `template_id` (`manhwa-recap-single`); now resolves
  through the catalog to display "Manhwa Recap — Single Chapter".
  Falls back to the id when the catalog hasn't loaded.
- **`TemplateMeta.defaults` ships with every catalog entry.** The
  desktop picker no longer needs a second `templates show` round-trip
  to know what aspect a card recommends — defaults travel on the
  meta payload (Python `to_dict`, Rust `TemplateMeta`, TS
  `TemplateDefaults`).

### Added (Project templates)

- **Project templates — pre-baked genres that teach Claude how a
  given format works.** Three shipped to start:
  - `manhwa-recap-single` — single-chapter recap, ~45–90s, 9:16,
    5-beat structure with panel-level zooms and a hook for the next
    chapter.
  - `manhwa-recap-multi` — multi-chapter arc recap, ~60–120s, 9:16,
    7–9 beats with chapter-chip overlays and a cold-open structure.
  - `product-demo` — Playwright-driven web walkthrough, ~30–60s,
    16:9, with cursor highlights and 4–5 segment value-prop → demo
    → CTA structure.
- **Template = behavioral context for Claude.** Each template ships
  a multi-section system prompt covering structure, pacing rules,
  visual identity, editorial constraints, and the questions Claude
  should ask when the user says "build it." The prompt is appended
  to the agent's Mode A / Mode B system prompts under a
  `## Template guidance` section. Rebuilt on every turn so swapping
  templates takes effect immediately — no restart.
- **Picker at project creation.** The New Project dialog mounts a
  `TemplatePicker` card grid above the mode chooser. Selection
  carries through Upload + Record steps via a `TemplateChip` reminder
  at the top of each form. After the project lands on disk, the
  chosen template is applied via `applyTemplate` and the project
  state is re-fetched so the workspace shows the binding.
- **Attach / change / clear on existing projects.** The TopBar now
  carries a `template: <id|none>` badge that opens a `TemplateDialog`
  with the same picker, plus a "Clear template" path. Useful for
  retro-fitting an old project with a template once one is shipped
  that fits its genre.
- **Inspectable behavior.** Every card in the picker has a "see
  prompt" toggle that fetches the template's full `system_prompt`
  and renders it inline, so power users can preview exactly what
  guidance Claude will receive before committing.
- **Pure-data layout.** Templates live as JSON files in
  `src/clipwright/templates/data/*.json` — adding a new template
  is a single file drop, no code changes. The loader picks them up
  next launch.
- **CLI surface.** `clipwright templates list/show/apply` exposes
  the registry for shell-level scripts and is what the desktop
  shells out to (mirrors the `agent prompt` pattern).
- **Schema.** `Project.template_id` is now part of the v2 schema —
  optional string, omitted from JSON when empty for forward-compat
  with older readers. Stale ids gracefully resolve to "no template"
  rather than blocking project load.

### Added (Claude rail polish)

- **`acceptEdits` now auto-approves clipwright CLI commands.** The
  previous mode whitelisted file Edit/Write but Bash still required
  approval — and in `--print` mode there's no dialog to render, so
  Claude would tell the user "approve the prompt when it appears"
  and the prompt never came. We now pass `--allowedTools` with
  patterns covering `Bash(clipwright:*)`, `Bash(uv run clipwright:*)`,
  `Bash(uvx clipwright:*)`, and `Bash(python(3)? -m clipwright:*)`
  whenever the mode is `acceptEdits`, so Claude can actually drive
  `clipwright record`, `clipwright tts-segment`, etc. The system
  prompt was extended with a "Shell commands" section telling Claude
  exactly which patterns are pre-approved and explicitly forbidding
  the "approve the prompt when it appears" phrasing (there is no
  prompt). Picker tooltips updated to reflect the new posture.
- **Resizable Claude rail.** The right sidebar now has a drag handle
  on its left edge — pull left to widen (up to 720px), right to
  narrow (down to 280px). Width persists across sessions in
  `localStorage` under `clipwright.claudeRailWidth`. Default stays
  at 340px. Width transitions are suppressed during the drag so the
  rail tracks the pointer 1:1 instead of easing behind it.
- **Stale question cards render as "superseded."** Once a newer
  message lands, every question card in older assistant bubbles is
  marked SUPERSEDED, its buttons go fully inert, and the whole card
  dims to 60% opacity. Clicking is blocked outright (the tooltip
  explains why). Fixes the rough UX where Claude batched three
  questions in one reply, the user answered Q1, Claude re-asked
  Q2/Q3, and the original Q2/Q3 sat there looking still-clickable.
  Paired with a system-prompt rule telling Claude to ask **one
  question per reply** so the re-ask happens at most once.
- **Inline question/answer cards.** Claude can now emit a fenced
  `clipwright-ask` JSON block whenever it wants the user to pick from a
  small set of choices — the desktop renders it as clickable buttons
  and clicking one sends the label back as the next user turn. The
  Mode A system prompt was extended with an "Interactive questions"
  section that teaches Claude the format and tells it to prefer cards
  over numbered "1. Theme: A or B?" lists. Supports single-pick (one
  click sends), multi-pick (`multi: true` + Send button), per-option
  hints (tooltip), and falls back to plain markdown if the JSON
  doesn't parse. Implemented in `desktop/src/components/QuestionCard.tsx`
  with a `parseAskBlocks(text)` helper that splits assistant replies
  into alternating markdown/question spans.
- **Assistant replies render as markdown.** Claude's GFM output —
  bold, lists, tables, fenced code, links — now renders properly
  instead of showing raw `**asterisks**` and pipe-tables. User
  messages stay literal (whatever you typed) so stray asterisks
  don't get reformatted. Powered by `react-markdown` + `remark-gfm`;
  every element is styled with our design tokens so the rendered
  output blends with the rail.
- **Per-project permission mode for `claude --print`.** The CLI's
  interactive Allow/Deny dialog can't render in headless `--print`
  mode (no TTY), which is why earlier turns silently failed when
  Claude tried to write a file. We now pass `--permission-mode <mode>`
  up-front and let the user pick the policy from a badge in the rail
  header:
  - `auto-edits` (default, `acceptEdits`) — auto-approves writes
    inside the project dir; dangerous shell stays gated.
  - `read-only` (`plan`) — Claude can browse but not modify files.
  - `ask` (`default`) — honors the normal CLI rules. May block in
    `--print` mode since the dialog can't render.
  - `yolo` (`bypassPermissions`) — bypasses all checks.
  The choice is persisted to `<project>/.clipwright/claude-permissions.json`
  and exposed via two new Tauri commands `get_permission_mode` /
  `set_permission_mode`.

### Fixed (Claude rail hangs)

- **Claude chat can no longer hang forever on `…`.** Three fixes layered:
  - **180s hard timeout** on the `claude` subprocess. The Rust runner
    now polls `try_wait()` on a tick instead of blocking on
    `wait_with_output()`, kills the process when the ceiling is hit,
    and surfaces a `claude timed out after 180s — killed` error in the
    chat. Previously a stalled upstream API or permission prompt left
    the UI stuck with no feedback.
  - **Elapsed seconds in the assistant placeholder** — the `…` bubble
    now reads `thinking… (12s)` and ticks every second so the UI
    visibly proves it isn't frozen.
  - **Cancel button** appears below the placeholder while a chat is in
    flight. Calls a new `cancel_claude_chat` Tauri command that signals
    the runner via a shared cancel set keyed by `video_id`; the next
    poll tick (≤150ms) kills the child and the call returns
    `cancelled`. Per-video keying means cancelling one video's chat
    doesn't disturb another's.

### Fixed (video_id validation)

- **Invalid video ids (like `Chapter-1-recap` with a capital C) no longer
  brick a project.** Two-part fix:
  - **Stop the regression at the source.** `Video.__post_init__` validates
    `video_id` against `^[a-z][a-z0-9_-]*$` at construction time, not
    only on reload. The desktop's "+ New video" form sanitizes user
    input live and shows a preview (`will be created as <sanitized>`)
    so the user sees the actual id before clicking Create.
  - **Recover existing damaged projects.** `load_project` now runs a
    `normalize_v2_video_ids` pass after the v1 migration. It walks
    `videos/*.json`, renames any non-conforming files in place,
    rewrites the `video_id` field inside the manifest, and relocates
    per-video artifact dirs (`voiceover/audio/<old>/`,
    `captions/<old>/`, `out/segments/<old>/`, `chat/sessions/<old>/`,
    `voiceover/scripts/<old>.json`, `out/final/<old>.mp4`). Two-step
    rename through a `.normalize-tmp-*` path forces the rename to
    actually take effect on case-insensitive APFS/NTFS.
  - Collisions (two bad ids that sanitize to the same target) get
    numeric suffixes (`-2`, `-3`, …) without overwriting any existing
    conforming file.
  - Idempotent: re-running on an already-normalized project is a no-op.

### Fixed (Claude rail UX)

- **Enter now sends; Shift+Enter inserts a newline.** Previously the
  textarea required `⌘+Enter`, which doesn't match the convention every
  chat UI uses (Slack, ChatGPT, Linear). IME composition (Japanese /
  Chinese) is preserved — Enter to commit a candidate still works.
- **"↺ Fresh" button in the Claude rail header** starts a brand-new
  conversation for the current video. Two-click confirm (first click
  arms, second within 4s commits) when the chat has history; instant
  when it's already empty. Today's chat log is archived to
  `chat/sessions/<video>/<date>.jsonl.archived-<ts>` so nothing is
  destroyed — only the session id pointer is cleared, so the next turn
  starts a fresh `claude` session instead of resuming the prior one.

### Added

- **Record additional videos into an existing project from the desktop.**
  The Videos sidebar gains a "+ Record video" button alongside the
  existing "+ New video (empty)". Opens a `RecordVideoDialog` that
  collects a `video_id`, an optional title, an optional base-URL
  override (defaults to the project's `base_url`), an aspect override,
  and a viewport choice. Drives Playwright via `clipwright
  record-project --video <id>` and the new `append` mode on the Rust
  side. Editor auto-switches to the new video on completion.
  - For the manhwa-recap workflow: open the Eternal Regressing Knight
    project, click "+ Record video", set `video_id = chapter-2`,
    record → chapter-2 lands in the sidebar with its own timeline,
    audio, captions, render output, and Claude chat session.

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
