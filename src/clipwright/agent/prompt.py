"""Build the system prompt for a Claude Code invocation against a clipwright project.

Two entry points matching SRS §9.1's two modes:

- `build_project_prompt(project_dir)` — Mode A. The persistent chat session
  for an open project. Provides the timeline summary and the constraints,
  but no segment-specific focus.
- `build_segment_prompt(project_dir, seg_id)` — Mode B. One-shot scoped edit.
  Adds the focus segment, its script clip, neighboring segments (±2), and a
  transcript window for the segment's source range.

The output is deterministic markdown — pure string construction from the
on-disk project state. This is fully unit-testable without ever spawning a
Claude subprocess.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..schema import (
    Project,
    Segment,
    Video,
    load_project,
    load_video,
)

# How many words from the transcript to surround the segment with.
TRANSCRIPT_PAD_SECONDS = 1.0
TRANSCRIPT_MAX_WORDS = 200

# Neighbor radius (segments on each side of the focus segment).
NEIGHBOR_RADIUS = 2


class PromptError(Exception):
    """Failure building a prompt, with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def build_project_prompt(project_dir: Path, *, video_id: str = "main") -> str:
    """Build the Mode A (persistent chat) system prompt for one video.

    A v2 project holds multiple videos; "project-scoped" Mode A is
    therefore really "video-scoped" — the chat is anchored to the
    currently-selected video, not the entire collection.
    """
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    video = load_video(project_dir, video_id)
    return _assemble(
        project_dir=project_dir,
        project=project,
        video=video,
        focus=None,
        script_payload=_load_script(project_dir, video_id),
        transcript_payload=None,
    )


def build_segment_prompt(
    project_dir: Path,
    seg_id: str,
    *,
    video_id: str = "main",
) -> str:
    """Build the Mode B (one-shot) system prompt focused on one segment."""
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    video = load_video(project_dir, video_id)
    seg = video.by_id(seg_id)
    if seg is None:
        raise PromptError(
            f"segment {seg_id!r} not found in video {video_id!r}",
            fix="Run `clipwright video list` / `clipwright status` for valid ids.",
        )

    transcript = _load_transcript_window(
        project_dir,
        seg,
        pad=TRANSCRIPT_PAD_SECONDS,
        max_words=TRANSCRIPT_MAX_WORDS,
    )
    return _assemble(
        project_dir=project_dir,
        project=project,
        video=video,
        focus=seg,
        script_payload=_load_script(project_dir, video_id),
        transcript_payload=transcript,
    )


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def _assemble(
    *,
    project_dir: Path,
    project: Project,
    video: Video,
    focus: Segment | None,
    script_payload: dict | None,
    transcript_payload: list[dict] | None,
) -> str:
    parts: list[str] = []
    parts.append(_section_header(project_dir, project, video))
    # The scope rule lives at the top, right after the header, BEFORE the
    # timeline / focus / template guidance. Putting it in the trailing
    # constraints list buried this in a 9-bullet sea where Claude could
    # miss it; users reported the rail editing files outside the project
    # tree (e.g. tweaking the clipwright source itself) in real sessions.
    # Promoting it here makes it impossible to miss.
    parts.append(_section_scope(project_dir))
    parts.append(_section_timeline(video, focus=focus))
    if focus is not None:
        parts.append(_section_focus(focus, script_payload))
        parts.append(_section_neighbors(video, focus))
        parts.append(_section_transcript(focus, transcript_payload))
    parts.append(_section_skill(project))
    parts.append(_section_interactive_questions())
    # Template guidance sits just before the hard constraints. A template
    # is *editorial* (how to write a manhwa recap, how to pace a product
    # demo); the constraints section below is *technical* (don't escape
    # the project dir, preserve segment ids). Editorial first so the
    # constraints have the last word.
    template_block = _section_template(project_dir)
    if template_block:
        parts.append(template_block)
    # User-set preferences (target duration, narration style, outro
    # spec). These OVERRIDE the template's defaults — when the user
    # says "make it 3 minutes" via the project settings, the template's
    # "aim for ~60s" guidance no longer applies. Sits after the template
    # block so the user's voice has the last editorial word before the
    # hard constraints.
    prefs_block = _section_user_preferences(project_dir, project=project, video=video)
    if prefs_block:
        parts.append(prefs_block)
    parts.append(_section_constraints(focus=focus))
    # Single trailing newline; sections are blank-line separated.
    return "\n\n".join(parts).rstrip() + "\n"


def _section_header(project_dir: Path, project: Project, video: Video) -> str:
    lines = [
        "# Clipwright project context",
        "",
        f"You are editing the clipwright project at: `{project_dir}`",
        "",
        "## Project",
        f"- Title: {project.title or '(untitled)'}",
        f"- Aspect: {project.aspect}",
        f"- FPS: {project.fps}",
        f"- Render backend: {project.render_backend}",
        f"- TTS provider: {project.tts_provider}",
    ]
    if project.voice_id:
        lines.append(f"- Voice id: {project.voice_id}")
    if project.base_url:
        lines.append(f"- Base URL: {project.base_url}")
    lines.append("")
    lines.append("## Video")
    lines.append(f"- ID: {video.video_id}")
    lines.append(f"- Title: {video.title or '(untitled)'}")
    return "\n".join(lines)


def _section_timeline(video: Video, *, focus: Segment | None) -> str:
    if not video.segments:
        return "## Timeline\n(empty — no segments yet)"
    lines = [f"## Timeline ({len(video.segments)} segments)"]
    for s in video.segments:
        marker = " ← focus" if focus and s.id == focus.id else ""
        chap = f" [{s.chapter}]" if s.chapter else ""
        label = s.label or "(no label)"
        lines.append(
            f"- {s.id} · \"{label}\" · {s.target_duration:.1f}s{chap}{marker}"
        )
    return "\n".join(lines)


def _section_focus(seg: Segment, script_payload: dict | None) -> str:
    lines = [
        f"## Focus: {seg.id}",
        f"- Label: {seg.label or '(no label)'}",
        f"- Chapter: {seg.chapter or '(none)'}",
        f"- Kind: {seg.kind}",
        f"- Source: {seg.source} [{seg.source_start:.2f}–{seg.source_end:.2f}s]",
        f"- Target duration: {seg.target_duration:.2f}s",
        f"- Voiceover: {'enabled' if seg.voiceover.enabled else 'disabled'}"
        + (f" → {seg.voiceover.script_clip_id}" if seg.voiceover.script_clip_id else ""),
        f"- Captions: {'enabled' if seg.captions.enabled else 'disabled'}"
        + (f" → {seg.captions.ref}" if seg.captions.enabled and seg.captions.ref else ""),
        f"- Camera: {'enabled' if seg.camera.enabled else 'disabled'}"
        + (f" → {seg.camera.ref}" if seg.camera.enabled and seg.camera.ref else ""),
        f"- Annotations: {'enabled' if seg.annotations.enabled else 'disabled'}"
        + (f" → {seg.annotations.ref}" if seg.annotations.enabled and seg.annotations.ref else ""),
    ]
    clip = _find_script_clip(script_payload, seg)
    if clip is not None:
        text = (clip.get("text") or "").strip() or "(empty)"
        hint = (clip.get("hint") or "").strip()
        lines.append("")
        lines.append("### Voiceover script")
        lines.append(f"> {text}")
        if hint:
            lines.append(f"_hint: {hint}_")
    return "\n".join(lines)


def _section_neighbors(video: Video, focus: Segment) -> str:
    ids = video.ids()
    try:
        idx = ids.index(focus.id)
    except ValueError:
        return ""
    lo = max(0, idx - NEIGHBOR_RADIUS)
    hi = min(len(ids), idx + NEIGHBOR_RADIUS + 1)
    surrounding = [video.segments[i] for i in range(lo, hi) if i != idx]
    if not surrounding:
        return "## Neighbors\n(none)"
    lines = ["## Neighbors"]
    for s in surrounding:
        rel = "prev" if video.segments.index(s) < idx else "next"
        chap = f" [{s.chapter}]" if s.chapter else ""
        lines.append(
            f"- {rel} {s.id}: \"{s.label or '(no label)'}\" · {s.target_duration:.1f}s{chap}"
        )
    return "\n".join(lines)


def _section_transcript(
    seg: Segment, transcript_payload: list[dict] | None
) -> str:
    if transcript_payload is None:
        return (
            "## Transcript window\n"
            "(no transcript available — run a Whisper pass on the source if "
            "voiceover script context is needed)"
        )
    lo = max(0.0, seg.source_start - TRANSCRIPT_PAD_SECONDS)
    hi = seg.source_end + TRANSCRIPT_PAD_SECONDS
    lines = [
        f"## Transcript window ({lo:.2f}–{hi:.2f}s, ±{TRANSCRIPT_PAD_SECONDS:.1f}s pad)"
    ]
    if not transcript_payload:
        lines.append("(transcript present but empty)")
        return "\n".join(lines)
    body = " ".join(w.get("text") or w.get("word") or "" for w in transcript_payload)
    body = body.strip() or "(no words in window)"
    lines.append(f"> {body}")
    return "\n".join(lines)


def _section_skill(project: Project) -> str:
    # Two skills are pre-installed and ALWAYS in scope for a
    # Clipwright project:
    #
    #   1. `clipwright` (user-level, ~/.claude/skills/clipwright/) —
    #      domain skill for the Clipwright pipeline itself.
    #   2. `remotion-best-practices` (project-level, vendored under
    #      `.claude/skills/remotion-best-practices/`) — Remotion-team-
    #      maintained best practices, conditional on `render_backend
    #      == "remotion"`. Vendored so every contributor's rail picks
    #      it up; see `ATTRIBUTION.md` in that dir for the snapshot
    #      commit and refresh instructions.
    #
    # The second skill ships with a CLIPWRIGHT_NOTES.md that overrides
    # a couple of upstream defaults (e.g., the skill's ElevenLabs-by-
    # default voiceover recommendation does NOT apply to Clipwright —
    # the project's configured TTS provider wins). We force Claude
    # to consult that notes file LAST so the overrides have the final
    # word.
    head = (
        "## Skill reference\n"
        "The clipwright skill at `~/.claude/skills/clipwright/SKILL.md` "
        "documents the v1 project file formats, the hard production-correctness "
        "rules (subtitles LAST, per-segment extract, 30ms fades, word-boundary "
        "cuts), and the editing primitives. Read it before editing project files.\n"
        "\n"
    )
    if project.render_backend == "remotion":
        head += (
            "**Remotion best practices (always invoke at turn start when "
            "touching Remotion code).** This project ships a vendored "
            "snapshot of the Remotion team's `remotion-best-practices` "
            "skill under `.claude/skills/remotion-best-practices/SKILL.md`. "
            "For ANY turn that involves the Remotion composition (under "
            "`remotion/`), render code (`src/clipwright/render_*.py`), "
            "captions, audio, or composition timing, you MUST invoke that "
            "skill via the Skill tool BEFORE writing or editing code. The "
            "skill teaches the use of `useCurrentFrame()` + `interpolate()` "
            "(CSS transitions DO NOT render correctly), `<Sequence>` "
            "timing, `trimBefore`/`trimAfter` on `<Video>` (which maps "
            "directly to Clipwright's `source_start`/`source_end`), and "
            "30+ topic rules.\n"
            "\n"
            "After loading the upstream skill, ALWAYS read "
            "`.claude/skills/remotion-best-practices/CLIPWRIGHT_NOTES.md` — "
            "it overrides a few upstream defaults for this codebase, most "
            "importantly: **do NOT default to ElevenLabs** for voiceover "
            "(use the project's configured TTS provider) and **use the "
            "system `ffmpeg` binary**, not `npx remotion ffmpeg`, for "
            "backend code.\n"
            "\n"
        )
    return head + (
        "## Tools you can use without asking\n"
        "You are running headlessly (`claude --print`), so there is no "
        "interactive Allow/Deny dialog. The `/permissions add ...` slash "
        "command also does NOT work — it's an interactive command we can't "
        "invoke. When the user has selected the `auto-edits` permission "
        "mode (the default), the following are pre-approved and you can "
        "use them directly without asking:\n"
        "\n"
        "**File tools** (always allowed via `acceptEdits`):\n"
        "- `Read`, `Glob`, `Grep` — read-only inspection.\n"
        "- `Edit`, `Write`, `MultiEdit` — modify files inside the project.\n"
        "\n"
        "**Network tools** (pre-whitelisted):\n"
        "- `WebFetch` — pull chapter pages, manhwa panels, product URLs, etc.\n"
        "- `WebSearch` — look up reference material.\n"
        "\n"
        "**Shell** (pre-whitelisted for clipwright invocations only):\n"
        "- `Bash(clipwright …)` (e.g. `clipwright record`, `clipwright tts-segment`)\n"
        "- `Bash(uv run clipwright …)` / `Bash(uvx clipwright …)`\n"
        "- `Bash(python -m clipwright …)` / `Bash(python3 -m clipwright …)`\n"
        "\n"
        "Do NOT ask the user to \"approve the prompt when it appears\" — no "
        "prompt will appear. Do NOT instruct them to run "
        "`/permissions add <Tool>` — that's an interactive command which "
        "is unreachable from here. For pre-approved tools just run them. "
        "For non-pre-approved shell commands (anything outside the "
        "`clipwright` prefix), describe what you would run and ask the "
        "user to run it manually in a terminal."
    )


def _section_interactive_questions() -> str:
    """Teach Claude to emit machine-parseable question blocks.

    The desktop chat renders ```clipwright-ask fenced blocks as clickable
    button cards. Without this section Claude would write the same
    question as a numbered list ("1. Theme: cyberpunk or dark fantasy?"),
    which collapses to a paragraph the user has to type a reply to —
    exactly the rough UX in the field reports.
    """
    return (
        "## Interactive questions\n"
        "Whenever you need the user to pick from a small set of options "
        "(2-6 choices), emit a fenced `clipwright-ask` block instead of a "
        "numbered question list. The desktop renders the block as clickable "
        "buttons; clicking one sends the label back as the next user turn.\n"
        "\n"
        "Format (JSON inside the fence):\n"
        "\n"
        "```clipwright-ask\n"
        "{\n"
        "  \"id\": \"theme\",\n"
        "  \"question\": \"Which visual theme should I use?\",\n"
        "  \"options\": [\n"
        "    {\"label\": \"Cyberpunk\", \"value\": \"cyberpunk\", \"hint\": \"Neon + glitch\"},\n"
        "    {\"label\": \"Dark fantasy\", \"value\": \"dark-fantasy\", \"hint\": \"Blood-red on near-black\"}\n"
        "  ],\n"
        "  \"multi\": false\n"
        "}\n"
        "```\n"
        "\n"
        "Rules:\n"
        "- `question` is plain markdown; keep it one sentence.\n"
        "- `options[].label` is what the user clicks AND what gets sent back to you.\n"
        "- Set `multi: true` only when more than one selection makes sense (e.g. tags).\n"
        "- **Ask ONE question per reply.** The user only answers one button per turn — "
        "if you batch three questions, the first click answers only the first, the other "
        "two get marked SUPERSEDED in the UI, and you'll have to re-ask them. Ask Q1, "
        "wait for the answer, then ask Q2.\n"
        "- The only exception is `multi: true` (one card, several picks at once).\n"
        "- Free-prose questions ('what should the title be?') stay as plain markdown — no fence."
    )


def _section_user_preferences(
    project_dir: Path,
    *,
    project: Project | None = None,
    video: Video | None = None,
) -> str:
    """Inject per-project + per-video user-set preferences.

    Read from `<project>/.clipwright/recap-config.json`. Each project
    has a default target duration (1:30 by default), and individual
    videos can override that via `Video.target_duration_seconds_override`
    when the user deems a specific deliverable needs more (or less)
    runtime.

    Critical UX behavior: the user's target duration HARD OVERRIDES
    the template's recommended duration. The template says "aim for
    60-90s" by default, but a user setting `target_duration_seconds:
    180` should produce a 3-minute video, not a compressed 60s one.
    Phrased emphatically below so Claude doesn't second-guess.

    Outro description: when the user hasn't typed one, we fall back to
    a cyberpunk-themed default that references the project title.
    """
    from ..recap_config import load_recap_config

    cfg = load_recap_config(project_dir)
    if not cfg.has_overrides():
        return ""

    # Per-video override beats project-level when set. Surface both in
    # the prompt so Claude knows which one applies and why.
    effective_duration = cfg.target_duration_seconds
    override_active = False
    overrides: dict = {}
    if video is not None:
        per_video = getattr(video, "target_duration_seconds_override", 0) or 0
        if per_video > 0:
            effective_duration = per_video
            override_active = True
        overrides = getattr(video, "recap_overrides", {}) or {}

    def _override(field_name: str, default: object) -> object:
        """Per-video value wins when set + non-empty; project default
        otherwise."""
        v = overrides.get(field_name)
        if v is None:
            return default
        if isinstance(v, str) and not v.strip():
            return default
        return v

    effective_narration = str(_override("narration_style", cfg.narration_style)).strip()
    effective_notes = str(_override("additional_notes", cfg.additional_notes)).strip()
    project_outro_desc = cfg.outro.description.strip()
    effective_outro_desc = str(_override("outro_description", project_outro_desc)).strip()
    effective_outro_duration = float(
        _override("outro_duration_seconds", cfg.outro.duration_seconds)
    )
    # Voice provider + voice override — informational, surfaced so
    # Claude knows what TTS will run on this video specifically.
    effective_voice_provider = str(_override("voice_provider", "")).strip()
    effective_voice_id = str(_override("voice_id", "")).strip()

    project_title = (project.title if project else "").strip()

    lines = ["## Project preferences (user-specified — OVERRIDES template defaults)"]
    if effective_duration > 0:
        scope = (
            f"this specific video (per-video override; project default is "
            f"{cfg.target_duration_seconds}s)"
            if override_active
            else "every video in this project"
        )
        lines.append(
            f"- **Target duration: {effective_duration} seconds** "
            f"for {scope}. "
            "Do not compress the script to fit a shorter ceiling — write enough "
            "segments and pace the voiceover so the final video lands near this "
            "duration. If the template suggests ~60s and the user wants "
            f"{effective_duration}s, USE {effective_duration}s "
            "(write more segments at 5–8s each instead of fewer at 10–15s)."
        )
    if effective_narration:
        lines.append(f"- **Narration style:** {effective_narration}")
    if effective_notes:
        lines.append(f"- **Additional notes from the user:**\n  > {effective_notes}")
    if effective_voice_provider or effective_voice_id:
        provider_part = effective_voice_provider or "(use project default)"
        voice_part = effective_voice_id or "(use project default)"
        lines.append(
            f"- **Voice (per-video):** provider `{provider_part}` · voice "
            f"`{voice_part}`. Pass to `clipwright tts-segment` via the segment's "
            "voice config."
        )
    # Per-video pre-selected skills. The desktop app's "+ New video"
    # flow lets the user check a set of Claude Code skills that they
    # want invoked by default whenever they chat in the context of
    # this video. We surface them here so Claude knows to reach for
    # them proactively (via the Skill tool) instead of waiting for an
    # explicit `/skill-name` slash command.
    raw_skills = overrides.get("default_skills") if isinstance(overrides, dict) else None
    if isinstance(raw_skills, list):
        skill_names = [str(s).strip() for s in raw_skills if str(s).strip()]
        if skill_names:
            joined = ", ".join(f"`{s}`" for s in skill_names)
            lines.append(
                f"- **Pre-selected skills for this video:** {joined}. The user "
                "explicitly picked these as defaults; invoke them via the Skill "
                "tool early in the turn whenever a request falls within their "
                "scope, instead of waiting for an explicit `/skill` command."
            )
    # Outro is always emitted (we have a sensible default). Description
    # falls back to a cyberpunk-themed default featuring the project
    # title when the user hasn't customized it OR overridden it.
    outro_description = (
        effective_outro_desc
        if effective_outro_desc
        else cfg.effective_outro_description(project_title)
    )
    lines.append(
        "- **Outro spec (reused across every video in this project):**\n"
        f"  - Description: {outro_description}\n"
        f"  - Target duration: ~{effective_outro_duration:.1f}s\n"
        "  - Add ONE final segment matching this spec at the end of every "
        "video you produce in this project. The chapter chip should read "
        "`outro` and the segment's `scene_type` should be `\"outro\"`."
    )
    return "\n".join(lines)


def _section_template(project_dir: Path) -> str:
    """Return the bound templates' `system_prompt` blocks, concatenated.

    A project can carry multiple template bindings via
    `Project.template_ids` (e.g. `["manhwa-recap-single",
    "product-demo"]`). The FIRST entry is the primary — it drives
    the render preset and default settings. Subsequent entries
    contribute additional editorial guidance: their system prompts
    are appended so the LLM sees the full lens for the product.

    Concrete example: a manhwa-reader platform producing chapter
    recaps. The primary `manhwa-recap-single` template teaches
    Claude how to structure a panel-by-panel recap; the secondary
    `product-demo` template adds the "you are also pitching a
    product" guidance (CTA, demo value-prop, etc.). Both make it
    into the prompt with their own headers so Claude can reason
    about each lens independently.

    Read fresh on every turn — swapping bindings takes effect
    immediately without a restart.
    """
    # Local imports avoid pulling templates into clipwright.schema's
    # import path. Schema depends on nothing; templates depend on
    # schema.
    from ..schema import load_project
    from ..templates import TemplateError, get_template

    try:
        project = load_project(project_dir)
    except Exception:
        return ""

    ids = list(project.template_ids)
    if not ids and project.template_id:
        # Back-compat: legacy single-binding projects.
        ids = [project.template_id]
    if not ids:
        return ""

    blocks: list[str] = []
    for idx, tid in enumerate(ids):
        try:
            template = get_template(tid)
        except TemplateError:
            # A stale id (template was deleted from the user's
            # templates dir between binding and load) shouldn't
            # break prompt assembly. Skip with a note so Claude
            # knows the binding is degraded.
            blocks.append(
                f"## Template guidance — [missing: {tid}]\n"
                "_This template was bound to the project but isn't "
                "available on disk. Run `clipwright templates list` "
                "to see what's installed; the binding is being "
                "ignored for this turn._"
            )
            continue
        body = template.system_prompt.strip()
        if not body:
            continue
        role = "primary" if idx == 0 else "secondary"
        blocks.append(
            f"## Template guidance — {template.name} ({role})\n"
            f"_Category: {template.category or '(uncategorized)'}_\n"
            "\n"
            f"{body}"
        )

    if len(blocks) > 1:
        # When multiple templates are bound, add a brief framing line
        # so Claude knows it should combine the lenses, not pick one.
        prelude = (
            "## Combined template lens\n"
            f"This project is bound to **{len(blocks)} templates**. Apply ALL of "
            "them simultaneously — the primary template (first) sets the visual "
            "format and render flow; the secondary template(s) add editorial "
            "intent the output must also honor. Treat them as overlapping "
            "constraints, not alternatives. When a per-template rule conflicts "
            "with another, prefer the primary template's direction."
        )
        blocks.insert(0, prelude)
    return "\n\n".join(blocks)


def _section_scope(project_dir: Path) -> str:
    """Top-of-prompt working directory scope rule.

    This is the single most important constraint in the prompt: Claude
    must only read/write inside the project directory. Without this,
    the rail can edit the bundled clipwright source tree itself, the
    user's home directory, or anywhere else the OS will let it. That's
    a hard "no" for both shipping the app and for the user's trust in
    the rail.

    We list the project root, name the kinds of files Claude legitimately
    creates / edits, and name the kinds of paths that are forbidden —
    repeating the rule from a couple of angles because LLM compliance
    correlates with how concretely the boundary is described.
    """
    return (
        "## Working directory scope — HARD RULE\n"
        "\n"
        f"All file operations MUST stay inside: `{project_dir}`\n"
        "\n"
        "The only files you create, edit, or delete are project artifacts "
        "for THIS video:\n"
        "\n"
        f"- `{project_dir}/project.json`\n"
        f"- `{project_dir}/videos/<id>.json`\n"
        f"- `{project_dir}/voiceover/scripts/<id>.json` and `voiceover/audio/<id>/…`\n"
        f"- `{project_dir}/captions/<id>/…` and `captions/style.json`\n"
        f"- `{project_dir}/camera/<seg_id>.json`\n"
        f"- `{project_dir}/annotations.json`\n"
        f"- `{project_dir}/sources/…` (downloaded panels / staged media)\n"
        f"- `{project_dir}/notes/…` (planning markdown — `panels.md`, etc.)\n"
        f"- `{project_dir}/brand/…` (from `clipwright inspire`)\n"
        f"- `{project_dir}/out/…` (rendered output — usually pipeline-managed)\n"
        f"- `{project_dir}/.clipwright/…` (session state, claude config)\n"
        "\n"
        "**FORBIDDEN paths — do not read, write, or delete any of these:**\n"
        "\n"
        "- The Clipwright installation itself — `src/clipwright/…`, "
        "  `~/.venv/`, `node_modules/`, `~/.local/…`, anywhere under the "
        "  clipwright package install. Even if you spot a bug in the tool, "
        "  do NOT patch it from the rail — report it and let the user "
        "  switch projects to fix it.\n"
        "- The user's home directory outside the project — `~/.bashrc`, "
        "  `~/.ssh/`, `~/Documents/<other-projects>/`, etc.\n"
        "- System directories — `/etc/`, `/usr/`, `/Applications/`, "
        "  `/Library/`, `C:\\Program Files\\`, etc.\n"
        "- Any absolute path that doesn't start with the project directory "
        "  shown above. When in doubt, use paths relative to the project "
        "  root.\n"
        "\n"
        "If a task seems to require editing outside the project (e.g. "
        "\"fix the clipwright CLI to do X\"), STOP and tell the user that "
        "the rail is project-scoped; they need to make tooling changes "
        "from a code editor against the clipwright repo, not from this "
        "chat.\n"
        "\n"
        "Network reads via `WebFetch` / `WebSearch` are fine — they don't "
        "touch the local filesystem outside the project's `sources/` "
        "downloads."
    )


def _section_constraints(*, focus: Segment | None) -> str:
    lines = [
        "## Constraints",
        "1. Stay scoped to the project directory (see *Working directory scope* above). "
        "Repeated here for emphasis: no edits outside the project tree.",
        "2. Do not make arbitrary network requests outside the WebFetch/WebSearch tools.",
        "3. Do not modify `schema_version` fields in any project JSON file.",
        "4. Preserve segment IDs across edits. Splitting `seg_001` yields a new id; never renumber.",
        "5. Downstream artifacts are content-hash-cached. After editing `voiceover/scripts/<video>.json`, "
        "`captions/style.json`, or `videos/<video>.json`, the cache invalidates automatically — do not "
        "manually delete `.cache.json` sidecars or `out/segments/<video>/` files.",
        "6. **Use the v2 segment schema exactly. Do not invent fields.** Every segment object in "
        "`videos/<video>.json` MUST contain: `id`, `source`, `source_start`, `source_end`, "
        "`target_duration`, `kind`, `scene_type`, `label`, `chapter`, `voiceover`, `captions`, "
        "`camera`, `annotations`. Do not introduce `panels`, `beat`, `theme`, `url`, or any other "
        "key the renderer doesn't know — they'll be silently dropped, the timeline will look empty, "
        "and `clipwright render-segment` will produce nothing. Read "
        "`src/clipwright/schema/v2/segment.py` (or `clipwright/schema/v2/segment.py` if installed) "
        "if you need to confirm the exact shape.",
        "7. **Drive the pipeline through the per-video CLI commands.** Never run `clipwright "
        "render-final` without `--video <id>` in a v2 project — that's the legacy v1 path which "
        "writes flat artifacts the desktop can't see. Use: `clipwright tts-segment --video <id> "
        "<seg>`, `clipwright caption-segment --video <id> <seg>`, `clipwright render-segment "
        "--video <id> <seg>`, then `clipwright render-final --video <id>`.",
        "8. When done, report which files you changed and why. Do not describe what you would have done.",
        "9. If you're stuck (e.g. source recording is too short for the target script), STOP and "
        "report the blocker explicitly. Do not keep retrying — run `clipwright video doctor "
        "<video_id>` to get a concrete diagnosis, then surface it to the user.",
    ]
    if focus is not None:
        lines.append(
            f"7. Stay scoped to segment `{focus.id}` unless the user explicitly "
            f"asks to modify other segments."
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Auxiliary loaders
# ---------------------------------------------------------------------------


def _load_script(project_dir: Path, video_id: str) -> dict | None:
    """Read `voiceover/scripts/<video_id>.json` if present. None otherwise."""
    from ..schema import paths as schema_paths
    path = schema_paths.video_script_path(project_dir, video_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _find_script_clip(
    script: dict | None, seg: Segment
) -> dict | None:
    """Find the script clip linked to this segment.

    Lookup order:
        1. The id named on `seg.voiceover.script_clip_id`.
        2. Any clip whose `segment_id` field references this segment.
    """
    if not script:
        return None
    clips = script.get("clips") or []
    needle_id = seg.voiceover.script_clip_id
    for clip in clips:
        if needle_id and clip.get("id") == needle_id:
            return clip
    for clip in clips:
        if clip.get("segment_id") == seg.id:
            return clip
    return None


def _load_transcript_window(
    project_dir: Path,
    seg: Segment,
    *,
    pad: float,
    max_words: int,
) -> list[dict] | None:
    """Return transcript words inside [source_start-pad, source_end+pad] or None.

    Tolerates several Whisper output shapes:
      - faster-whisper: `{"segments": [{"words": [{"word", "start", "end"}]}]}`
      - whisper-cpp:   `{"segments": [{"words": [...]}]}` (same shape, different "word" key)
      - flat:           `{"words": [{"text","start","end"}, ...]}`
    """
    # Per SRS §5.1 the transcript lives next to the source file:
    # `sources/main.transcript.json` for `sources/main.mp4`.
    source_path = Path(seg.source)
    transcript_path = project_dir / source_path.with_suffix(".transcript.json")
    if not transcript_path.exists():
        return None
    try:
        payload = json.loads(transcript_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None

    words = _flatten_transcript_words(payload)
    lo = max(0.0, seg.source_start - pad)
    hi = seg.source_end + pad
    selected: list[dict] = []
    for w in words:
        wt = float(w.get("start", w.get("t", 0.0)))
        if lo <= wt <= hi:
            text = w.get("text") or w.get("word") or ""
            selected.append({"start": wt, "text": text.strip()})
            if len(selected) >= max_words:
                break
    return selected


def _flatten_transcript_words(payload: dict) -> list[dict]:
    """Flatten the various Whisper output shapes into a single word list."""
    # Flat shape
    if "words" in payload and isinstance(payload["words"], list):
        return payload["words"]
    # Nested-by-segment shape
    out: list[dict] = []
    for seg in payload.get("segments") or []:
        for w in seg.get("words") or []:
            out.append(w)
    return out
