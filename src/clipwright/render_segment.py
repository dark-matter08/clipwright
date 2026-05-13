"""Render a single segment from a v1 project (SRS P0.3, F-RND-1, F-RND-2).

The desktop editor needs per-segment rendering so that editing one segment
re-renders just that one segment (not the whole video). This module is the
unit of work.

Contract:

    out_path = render_segment(project_dir, "seg_003")

Reads `<project>/timeline.json` to find the segment, then drives the
existing composer (`render.composer._compose_segment` + `_overlay_subtitles`)
which already honors the SKILL.md hard rules (subs LAST, per-segment extract,
30ms boundary fades).

Caching:

    `<project>/out/segments/<seg_id>.mp4`
    `<project>/out/segments/<seg_id>.mp4.cache.json`  ← SRS §5.8

The cache key is a SHA-256 over the inputs that *actually* determined the
output: timeline segment dict, project aspect/fps, source file
(mtime + size), VO audio (mtime + size) if used, captions index
(mtime + size) if used, and the clipwright tool version. If the existing
sidecar hash matches AND the mp4 exists, the call is a no-op.

Scope:

- `kind="recording"` segments only in P0. `kind="scene"` / `kind="generated"`
  raise `RenderSegmentError` — they land in P1/P2 when Remotion scenes and
  generative providers come back online.
- Voiceover audio is consumed from `voiceover/audio/<seg_id>.mp3` if it
  exists; otherwise the segment renders silent. We do NOT synthesize TTS
  here — that's a separate stage (existing `clipwright tts`).
- Captions are consumed from `captions/<seg_id>/index.json` if it exists.
  We do NOT chunk timestamps here.
"""
from __future__ import annotations

import datetime
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .ffmpeg import require
from .render.composer import Segment as _ComposerSegment
from .render.composer import SubtitleChunk, _compose_segment, _overlay_subtitles
from .schema import (
    Segment,
    load_project,
    load_timeline,
)
from .schema.v1.project import Project


class RenderSegmentError(Exception):
    """Render failure with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


@dataclass
class RenderResult:
    out_path: Path
    cached: bool   # True if we skipped recompute
    input_hash: str


# 1080-side major axis × per-aspect dimensions. Matches existing CLI defaults.
_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
}


def render_segment(
    project_dir: Path,
    seg_id: str,
    *,
    force: bool = False,
) -> RenderResult:
    """Render one segment. Returns its output path and whether the cache hit.

    Args:
        project_dir: project root.
        seg_id: stable segment id (e.g. "seg_001").
        force: bypass the cache and recompute even if inputs are unchanged.
    """
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    timeline = load_timeline(project_dir)
    seg = timeline.by_id(seg_id)
    if seg is None:
        raise RenderSegmentError(
            f"segment {seg_id!r} not found in {project_dir / 'timeline.json'}",
            fix=(
                "Check `clipwright status` for the list of segment ids, or "
                "regenerate the timeline."
            ),
        )

    if seg.kind != "recording":
        raise RenderSegmentError(
            f"segment {seg_id} has kind={seg.kind!r}; only 'recording' is "
            f"renderable in P0.",
            fix="Generative + scene rendering will land in P1/P2.",
        )

    require()  # ffmpeg/ffprobe on PATH

    source = (project_dir / seg.source).resolve()
    if not source.exists():
        raise RenderSegmentError(
            f"segment {seg_id}: source not found at {source}",
            fix="Re-record or re-import to restore sources/main.mp4.",
        )

    vo_audio = _resolve_voiceover(project_dir, seg)
    captions_index = _resolve_captions_index(project_dir, seg)

    out_dir = project_dir / "out" / "segments"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{seg_id}.mp4"
    cache_path = out_path.with_suffix(".mp4.cache.json")

    input_hash = _compute_input_hash(
        project=project,
        segment=seg,
        source=source,
        vo_audio=vo_audio,
        captions_index=captions_index,
    )

    if not force and out_path.exists():
        cached = _read_cache_hash(cache_path)
        if cached == input_hash:
            return RenderResult(out_path=out_path, cached=True, input_hash=input_hash)

    # Compose the segment body.
    out_w, out_h = _RESOLUTIONS[project.aspect]
    composer_seg = _ComposerSegment(
        start=seg.source_start,
        duration=seg.target_duration if seg.target_duration > 0
                 else (seg.source_end - seg.source_start),
        audio=vo_audio if (seg.voiceover.enabled and vo_audio) else None,
        lead=0.0,
        tail=0.0,
    )
    work_dir = out_dir / "_work" / seg_id
    work_dir.mkdir(parents=True, exist_ok=True)
    nosub = work_dir / "nosub.mp4"
    _compose_segment(
        source=source,
        seg=composer_seg,
        out=nosub,
        out_w=out_w,
        out_h=out_h,
        fps=project.fps,
    )

    # Hard Rule 1: subs LAST.
    subs = _load_subtitle_chunks(captions_index) if (
        seg.captions.enabled and captions_index
    ) else []
    if subs:
        _overlay_subtitles(body=nosub, subtitles=subs, out=out_path, fps=project.fps)
    else:
        # No subtitles → atomic rename the composed body into place.
        if out_path.exists():
            out_path.unlink()
        nosub.rename(out_path)

    _write_cache(cache_path, input_hash)
    return RenderResult(out_path=out_path, cached=False, input_hash=input_hash)


# ---------------------------------------------------------------------------
# Input resolution
# ---------------------------------------------------------------------------


def _resolve_voiceover(project_dir: Path, seg: Segment) -> Path | None:
    """Return the per-segment VO audio path if it exists, else None."""
    if not seg.voiceover.enabled:
        return None
    path = project_dir / "voiceover" / "audio" / f"{seg.id}.mp3"
    return path if path.exists() else None


def _resolve_captions_index(project_dir: Path, seg: Segment) -> Path | None:
    """Return the per-segment captions index JSON if it exists, else None."""
    if not seg.captions.enabled:
        return None
    path = project_dir / "captions" / seg.id / "index.json"
    return path if path.exists() else None


def _load_subtitle_chunks(index_path: Path) -> list[SubtitleChunk]:
    """Parse the per-segment captions index into composer SubtitleChunks.

    Index file shape (existing convention from `captions/chunker.py`):

        {
          "chunks": [
            {"start": 0.0, "end": 0.6, "png": "000.png"},
            ...
          ]
        }
    """
    payload = json.loads(index_path.read_text())
    base = index_path.parent
    return [
        SubtitleChunk(
            start=float(c["start"]),
            end=float(c["end"]),
            png=(base / c["png"]).resolve(),
        )
        for c in payload.get("chunks") or []
    ]


# ---------------------------------------------------------------------------
# Cache (SRS §5.8 sidecar pattern)
# ---------------------------------------------------------------------------


def _stat_fingerprint(path: Path | None) -> tuple[int, int] | None:
    """File mtime (rounded to ms) + size; sufficient input-change signal."""
    if path is None or not path.exists():
        return None
    st = path.stat()
    return (int(st.st_mtime * 1000), st.st_size)


def _compute_input_hash(
    *,
    project: Project,
    segment: Segment,
    source: Path,
    vo_audio: Path | None,
    captions_index: Path | None,
) -> str:
    """Deterministic SHA-256 over everything that determines the output."""
    payload = {
        "tool_version": __version__,
        "aspect": project.aspect,
        "fps": project.fps,
        "segment": segment.to_dict(),
        "source_fp": _stat_fingerprint(source),
        "vo_fp": _stat_fingerprint(vo_audio),
        "captions_fp": _stat_fingerprint(captions_index),
    }
    blob = json.dumps(payload, sort_keys=True).encode()
    return "sha256:" + hashlib.sha256(blob).hexdigest()


def _read_cache_hash(cache_path: Path) -> str | None:
    if not cache_path.exists():
        return None
    try:
        return json.loads(cache_path.read_text()).get("input_hash")
    except (json.JSONDecodeError, OSError):
        return None


def _write_cache(cache_path: Path, input_hash: str) -> None:
    payload = {
        "schema_version": 1,
        "input_hash": input_hash,
        "produced_at": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "tool_version": __version__,
    }
    cache_path.write_text(json.dumps(payload, indent=2) + "\n")
