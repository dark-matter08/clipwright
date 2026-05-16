"""Concat per-segment MP4s into out/final/<video_id>.mp4 — SRS P1.10 / F-RND-3.

Consumes the per-segment outputs `render_segment` produces and stitches
them into a final video using ffmpeg's concat demuxer (lossless when the
inputs share codec + container, which they do by construction).

Renders any stale segments along the way so a single `clipwright render`
call is enough to go from edited timeline → final MP4.
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg import FFmpegError, require
from .render_segment import RenderSegmentError, render_segment
from .schema import load_project, load_video
from .schema import paths as schema_paths


class RenderFinalError(Exception):
    """Final-render failure with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


@dataclass
class RenderFinalResult:
    out_path: Path
    n_segments: int
    rendered: int  # segments that needed a re-render this pass
    cached: int    # segments that hit the per-segment cache


def render_final(
    project_dir: Path,
    *,
    video_id: str = "main",
    force: bool = False,
) -> RenderFinalResult:
    """Render every segment of one video and concat into out/final/<id>.mp4.

    Two render paths, dispatched on `project.template_id`:

      - **Templates with `render_preset`** (manhwa-recap-* today) route
        through the Remotion `ManhwaRecap` composition, which renders
        the whole video in a single pass with per-segment Ken Burns
        motion, chapter chips, and themed captions. No per-segment
        mp4 concat — Remotion produces the final mp4 directly.
      - **Everything else** falls through to the legacy
        per-segment ffmpeg concat path (the existing behavior).

    Args:
        project_dir: project root.
        video_id: which video to render. Default "main".
        force: bypass per-segment caches (recording-mode only).
    """
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    video = load_video(project_dir, video_id)
    if not video.segments:
        raise RenderFinalError(
            f"video {video_id!r} has no segments",
            fix="Import a video or record a session before rendering.",
        )

    # Template-aware dispatch. We look at the template's `render_preset`
    # field (loaded from the template registry, not project.json) so
    # adding a new visually-distinct template is just dropping a JSON
    # file under `clipwright/templates/data/`.
    # Multi-template bindings: primary template (first entry) wins
    # for render dispatch. Secondary templates only contribute
    # behavioral guidance to the agent prompt.
    primary_template = (
        project.template_ids[0]
        if project.template_ids
        else project.template_id
    )
    if _should_use_manhwa_preset(primary_template):
        return _render_via_manhwa_preset(project_dir, video_id, project.fps)

    require()
    final = schema_paths.video_final_path(project_dir, video_id)
    final.parent.mkdir(parents=True, exist_ok=True)

    rendered = 0
    cached = 0
    per_segment_paths: list[Path] = []
    for seg in video.segments:
        try:
            r = render_segment(project_dir, seg.id, video_id=video_id, force=force)
        except RenderSegmentError as e:
            raise RenderFinalError(
                f"video {video_id} segment {seg.id}: {e}",
                fix=getattr(e, "fix", ""),
            ) from e
        per_segment_paths.append(r.out_path)
        if r.cached:
            cached += 1
        else:
            rendered += 1

    _concat(per_segment_paths, final)
    return RenderFinalResult(
        out_path=final,
        n_segments=len(video.segments),
        rendered=rendered,
        cached=cached,
    )


def _should_use_manhwa_preset(template_id: str) -> bool:
    """True when this project's template should render via the Remotion
    `ManhwaRecap` composition. Today that's anything whose template's
    `render_preset` field starts with `manhwa-recap`."""
    if not template_id:
        return False
    try:
        from .templates import get_template
        t = get_template(template_id)
    except Exception:
        return False
    return t.render_preset.startswith("manhwa-recap")


def _render_via_manhwa_preset(
    project_dir: Path,
    video_id: str,
    fps: int,
) -> RenderFinalResult:
    """Delegate to the Remotion manhwa backend and shape the result the
    same way the per-segment concat path does, so callers don't need
    to special-case the response."""
    from .render import manhwa_backend

    out = schema_paths.video_final_path(project_dir, video_id)
    try:
        manhwa_backend.render(
            project_dir=project_dir,
            video_id=video_id,
            out=out,
            fps=fps,
        )
    except manhwa_backend.ManhwaRenderError as e:
        raise RenderFinalError(
            f"manhwa render failed: {e}",
            fix="Run `clipwright video doctor <video_id>` for a per-segment audit.",
        ) from e
    # The Remotion path is monolithic — no per-segment caching today,
    # so report all segments as "rendered" rather than "cached".
    video = load_video(project_dir, video_id)
    return RenderFinalResult(
        out_path=out,
        n_segments=len(video.segments),
        rendered=len(video.segments),
        cached=0,
    )


def _concat(parts: list[Path], out: Path) -> None:
    """ffmpeg concat-demuxer stitch. Re-encodes only if the inputs would
    refuse stream-copy (which they shouldn't, by construction)."""
    list_path = out.parent / "_concat.txt"
    list_path.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in parts) + "\n",
        encoding="utf-8",
    )
    # First try stream-copy. If it fails (codec edge case), retry with re-encode.
    cmd_copy = [
        "ffmpeg", "-y", "-hide_banner", "-nostats",
        "-f", "concat", "-safe", "0", "-i", str(list_path),
        "-c", "copy", str(out),
    ]
    proc = subprocess.run(cmd_copy, capture_output=True, text=True)
    if proc.returncode == 0:
        try:
            list_path.unlink()
        except OSError:
            pass
        return

    if shutil.which("ffmpeg") is None:
        raise FFmpegError("ffmpeg not on PATH")
    cmd_re = [
        "ffmpeg", "-y", "-hide_banner", "-nostats",
        "-f", "concat", "-safe", "0", "-i", str(list_path),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        str(out),
    ]
    proc2 = subprocess.run(cmd_re, capture_output=True, text=True)
    try:
        list_path.unlink()
    except OSError:
        pass
    if proc2.returncode != 0:
        raise FFmpegError(
            f"concat failed: {proc2.stderr[-400:]}"
        )
