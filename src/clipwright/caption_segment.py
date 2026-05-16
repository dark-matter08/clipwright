"""Per-segment caption generation in the v1 project layout (SRS P0.4).

Reads the voiceover timestamps for a segment, chunks them into 2-word UPPERCASE
frames (SKILL.md hard rule 6: word-level verbatim timestamps), renders one
transparent PNG per chunk, and writes:

    <project>/captions/<seg_id>/000.png
    <project>/captions/<seg_id>/001.png
    ...
    <project>/captions/<seg_id>/index.json     ← shape consumed by render_segment.py
    <project>/captions/<seg_id>/.cache.json    ← SRS §5.8 sidecar

`index.json` shape (matches what `render_segment._load_subtitle_chunks` expects):

    {
      "schema_version": 1,
      "chunks": [
        {"start": 0.000, "end": 0.620, "png": "000.png", "text": "YOUR LIBRARY"},
        ...
      ]
    }

Cache key includes: tool version, timestamps file fingerprint, the style dict,
and the project aspect (resolution drives layout). Idempotent on unchanged
inputs.

Style resolution (SRS §5.7):
  1. If `<project>/captions/style.json` exists, the `default` style is used.
  2. Otherwise built-in defaults from `CaptionStyle()` apply.
  3. Per-segment style overrides (`style_ref`) are deferred to P1.
"""
from __future__ import annotations

import datetime
import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from . import __version__
from .captions.chunker import chars_to_words, chunk_words
from .captions.png_renderer import CaptionStyle, render_chunk_png
from .schema import load_project, load_video
from .schema import paths as schema_paths


class CaptionSegmentError(Exception):
    """Caption generation failure with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


@dataclass
class CaptionResult:
    seg_id: str
    out_dir: Path
    index_path: Path
    n_chunks: int
    cached: bool
    input_hash: str


# Aspect → (width, height) for the caption canvas. Matches render_segment.py.
_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
}


def caption_segment(
    project_dir: Path,
    seg_id: str,
    *,
    video_id: str = "main",
    force: bool = False,
) -> CaptionResult:
    """Generate caption PNGs + index for one segment.

    Args:
        project_dir: project root.
        seg_id: stable segment id, e.g. "seg_001".
        video_id: which video the segment belongs to. Default "main".
        force: bypass cache.
    """
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    video = load_video(project_dir, video_id)

    seg = video.by_id(seg_id)
    if seg is None:
        raise CaptionSegmentError(
            f"segment {seg_id!r} not found in video {video_id!r}",
            fix="Run `clipwright video list` to see valid video + segment ids.",
        )

    if not seg.captions.enabled:
        raise CaptionSegmentError(
            f"segment {seg_id}: captions are disabled",
            fix=f"Set `captions.enabled = true` on the segment in videos/{video_id}.json.",
        )

    timestamps_path = schema_paths.video_audio_timestamps(project_dir, video_id, seg_id)
    if not timestamps_path.exists():
        raise CaptionSegmentError(
            f"voiceover timestamps not found at {timestamps_path}",
            fix=(
                "Run the TTS stage to produce voiceover/audio/<video>/<seg>.mp3 + "
                ".timestamps.json before captioning."
            ),
        )

    style, style_blob = _resolve_style(project_dir, project.aspect)

    out_dir = schema_paths.video_captions_dir(project_dir, video_id, seg_id)
    index_path = out_dir / "index.json"
    cache_path = out_dir / ".cache.json"

    input_hash = _compute_input_hash(
        timestamps_path=timestamps_path,
        style_blob=style_blob,
        aspect=project.aspect,
    )

    if not force and index_path.exists():
        cached = _read_cache_hash(cache_path)
        if cached == input_hash:
            payload = json.loads(index_path.read_text())
            return CaptionResult(
                seg_id=seg_id,
                out_dir=out_dir,
                index_path=index_path,
                n_chunks=len(payload.get("chunks") or []),
                cached=True,
                input_hash=input_hash,
            )

    align = json.loads(timestamps_path.read_text())
    words = chars_to_words(align)
    chunks = chunk_words(words)

    # Wipe any stale PNGs from a prior render — chunk count may have shrunk.
    if out_dir.exists():
        for old in out_dir.glob("*.png"):
            old.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)

    chunk_entries: list[dict] = []
    for i, ch in enumerate(chunks):
        png = out_dir / f"{i:03d}.png"
        render_chunk_png(ch, style, png)
        chunk_entries.append(
            {
                "start": round(ch.start, 3),
                "end": round(ch.end, 3),
                "png": png.name,
                "text": ch.text,
            }
        )

    index_payload = {
        "schema_version": 1,
        "chunks": chunk_entries,
    }
    index_path.write_text(json.dumps(index_payload, indent=2) + "\n")
    _write_cache(cache_path, input_hash)

    return CaptionResult(
        seg_id=seg_id,
        out_dir=out_dir,
        index_path=index_path,
        n_chunks=len(chunks),
        cached=False,
        input_hash=input_hash,
    )


# ---------------------------------------------------------------------------
# Style resolution
# ---------------------------------------------------------------------------


def _resolve_style(project_dir: Path, aspect: str) -> tuple[CaptionStyle, str]:
    """Pick the style for this segment + the canonical JSON blob (for hashing).

    SRS §5.7: `captions/style.json` is optional. Built-in defaults apply
    otherwise. Per-segment style overrides land in P1.
    """
    width, height = _RESOLUTIONS[aspect]
    style = CaptionStyle(width=width, height=height)

    style_json = project_dir / "captions" / "style.json"
    if style_json.exists():
        payload = json.loads(style_json.read_text())
        default = payload.get("default") or {}
        # Map SRS §5.7 field names → CaptionStyle dataclass fields where they
        # differ; ignore unknown keys so the schema can evolve forward-only.
        if "font_size" in default:
            style.font_size = int(default["font_size"])
        elif "size" in default:
            style.font_size = int(default["size"])
        if "font_path" in default:
            style.font_path = str(default["font_path"])
        # Style overrides for color/stroke/etc can be added here as the
        # SRS-style fields stabilize; deliberately conservative for v1.

    # Canonical blob: post-resolution dict, deterministic ordering.
    style_blob = json.dumps(asdict(style), sort_keys=True)
    return style, style_blob


# ---------------------------------------------------------------------------
# Cache (sidecar pattern, SRS §5.8)
# ---------------------------------------------------------------------------


def _file_fingerprint(path: Path) -> tuple[int, int] | None:
    if not path.exists():
        return None
    st = path.stat()
    return (int(st.st_mtime * 1000), st.st_size)


def _compute_input_hash(
    *,
    timestamps_path: Path,
    style_blob: str,
    aspect: str,
) -> str:
    payload = {
        "tool_version": __version__,
        "aspect": aspect,
        "timestamps_fp": _file_fingerprint(timestamps_path),
        "style": style_blob,
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
