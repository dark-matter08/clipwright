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
    parts.append(_section_timeline(video, focus=focus))
    if focus is not None:
        parts.append(_section_focus(focus, script_payload))
        parts.append(_section_neighbors(video, focus))
        parts.append(_section_transcript(focus, transcript_payload))
    parts.append(_section_skill())
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


def _section_skill() -> str:
    return (
        "## Skill reference\n"
        "The clipwright skill at `~/.claude/skills/clipwright/SKILL.md` "
        "documents the v1 project file formats, the hard production-correctness "
        "rules (subtitles LAST, per-segment extract, 30ms fades, word-boundary "
        "cuts), and the editing primitives. Read it before editing project files."
    )


def _section_constraints(*, focus: Segment | None) -> str:
    lines = [
        "## Constraints",
        "1. Edit only files inside the project directory above. Never read or write outside it.",
        "2. Do not make network requests.",
        "3. Do not modify `schema_version` fields in any project JSON file.",
        "4. Preserve segment IDs across edits. Splitting `seg_001` yields a new id; never renumber.",
        "5. Downstream artifacts are content-hash-cached. After editing `voiceover/scripts/<video>.json`, "
        "`captions/style.json`, or `videos/<video>.json`, the cache invalidates automatically — do not "
        "manually delete `.cache.json` sidecars or `out/segments/<video>/` files.",
        "6. When done, report which files you changed and why. Do not describe what you would have done.",
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
