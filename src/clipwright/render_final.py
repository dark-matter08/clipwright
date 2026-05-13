"""Concat per-segment MP4s into out/final.mp4 — SRS P1.10 / F-RND-3.

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
from .schema import load_timeline


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


def render_final(project_dir: Path, *, force: bool = False) -> RenderFinalResult:
    """Render every segment (or use cache) and concat into out/final.mp4.

    Args:
        project_dir: project root.
        force: bypass per-segment caches.
    """
    project_dir = Path(project_dir).resolve()
    require()

    timeline = load_timeline(project_dir)
    if not timeline.segments:
        raise RenderFinalError(
            "timeline has no segments",
            fix="Import a video or record a session before rendering.",
        )

    out_dir = project_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / "final.mp4"

    rendered = 0
    cached = 0
    per_segment_paths: list[Path] = []
    for seg in timeline.segments:
        try:
            r = render_segment(project_dir, seg.id, force=force)
        except RenderSegmentError as e:
            raise RenderFinalError(
                f"segment {seg.id}: {e}", fix=getattr(e, "fix", "")
            ) from e
        per_segment_paths.append(r.out_path)
        if r.cached:
            cached += 1
        else:
            rendered += 1

    _concat(per_segment_paths, final)
    return RenderFinalResult(
        out_path=final,
        n_segments=len(timeline.segments),
        rendered=rendered,
        cached=cached,
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
