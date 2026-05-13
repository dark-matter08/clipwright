"""Tests for `render_segment` — the per-segment render entry point.

Two tiers:
1. Pure unit tests for cache-hash determinism + error paths. No ffmpeg.
2. ffmpeg-gated integration tests that actually render a synthesized clip
   and verify cache invalidation, force, and produced-file shape.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from clipwright.import_video import import_video
from clipwright.render_segment import (
    RenderSegmentError,
    _compute_input_hash,
    _stat_fingerprint,
    render_segment,
)
from clipwright.schema import load_project, load_timeline, save_timeline


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


# ---------------------------------------------------------------------------
# Cache-hash logic — pure, no ffmpeg
# ---------------------------------------------------------------------------


def test_stat_fingerprint_none_for_missing() -> None:
    assert _stat_fingerprint(None) is None
    assert _stat_fingerprint(Path("/nonexistent/xyz.mp4")) is None


def test_stat_fingerprint_changes_with_size(tmp_path: Path) -> None:
    p = tmp_path / "f.bin"
    p.write_bytes(b"x" * 100)
    fp1 = _stat_fingerprint(p)
    p.write_bytes(b"x" * 200)
    fp2 = _stat_fingerprint(p)
    assert fp1 != fp2


def test_compute_input_hash_deterministic(tmp_path: Path) -> None:
    """Same inputs → same hash, byte-for-byte."""
    from clipwright.schema.v1.project import Project
    from clipwright.schema.v1.timeline import Segment, SegmentRef, SegmentVoiceover

    project = Project(title="t", aspect="9:16", fps=30)
    seg = Segment(
        id="seg_001",
        source="sources/main.mp4",
        source_start=0.0,
        source_end=5.0,
        target_duration=5.0,
        kind="recording",
        voiceover=SegmentVoiceover(),
        captions=SegmentRef(ref="captions/index.json#seg_001"),
        camera=SegmentRef(ref=""),
        annotations=SegmentRef(ref=""),
    )
    src = tmp_path / "main.mp4"
    src.write_bytes(b"fake video bytes")

    h1 = _compute_input_hash(project=project, segment=seg, source=src,
                              vo_audio=None, captions_index=None)
    h2 = _compute_input_hash(project=project, segment=seg, source=src,
                              vo_audio=None, captions_index=None)
    assert h1 == h2
    assert h1.startswith("sha256:")


def test_compute_input_hash_changes_with_segment(tmp_path: Path) -> None:
    from clipwright.schema.v1.project import Project
    from clipwright.schema.v1.timeline import Segment, SegmentRef, SegmentVoiceover

    project = Project()
    src = tmp_path / "main.mp4"
    src.write_bytes(b"v")
    base_kwargs = dict(
        id="seg_001", source="sources/main.mp4",
        source_start=0.0, source_end=5.0, target_duration=5.0, kind="recording",
        voiceover=SegmentVoiceover(),
        captions=SegmentRef(ref=""), camera=SegmentRef(ref=""),
        annotations=SegmentRef(ref=""),
    )
    seg1 = Segment(**base_kwargs)
    seg2 = Segment(**{**base_kwargs, "target_duration": 6.0})

    h1 = _compute_input_hash(project=project, segment=seg1, source=src,
                              vo_audio=None, captions_index=None)
    h2 = _compute_input_hash(project=project, segment=seg2, source=src,
                              vo_audio=None, captions_index=None)
    assert h1 != h2


def test_compute_input_hash_changes_with_aspect(tmp_path: Path) -> None:
    from clipwright.schema.v1.project import Project
    from clipwright.schema.v1.timeline import Segment, SegmentRef, SegmentVoiceover

    src = tmp_path / "main.mp4"
    src.write_bytes(b"v")
    seg = Segment(
        id="seg_001", source="sources/main.mp4",
        source_start=0.0, source_end=5.0, target_duration=5.0, kind="recording",
        voiceover=SegmentVoiceover(),
        captions=SegmentRef(ref=""), camera=SegmentRef(ref=""),
        annotations=SegmentRef(ref=""),
    )
    h_9_16 = _compute_input_hash(project=Project(aspect="9:16"), segment=seg,
                                   source=src, vo_audio=None, captions_index=None)
    h_16_9 = _compute_input_hash(project=Project(aspect="16:9"), segment=seg,
                                   source=src, vo_audio=None, captions_index=None)
    assert h_9_16 != h_16_9


# ---------------------------------------------------------------------------
# Error paths — no ffmpeg required for these (failures happen pre-render)
# ---------------------------------------------------------------------------


@pytest.fixture
def imported_project(tmp_path: Path) -> Path:
    """A 6-second imported project ready to render."""
    if not _ffmpeg_available():
        pytest.skip("ffmpeg not on PATH")
    src = tmp_path / "raw.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=purple:s=540x960:d=6:r=30",
            "-f", "lavfi", "-i", "sine=f=330:d=6",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            str(src),
        ],
        check=True,
        capture_output=True,
    )
    proj = tmp_path / "proj"
    import_video(src, proj, title="Render Test", auto_segment=False)
    return proj


def test_render_segment_missing_id_raises(imported_project: Path) -> None:
    with pytest.raises(RenderSegmentError, match="not found"):
        render_segment(imported_project, "seg_999")


def test_render_segment_rejects_non_recording_kind(imported_project: Path) -> None:
    timeline = load_timeline(imported_project)
    timeline.segments[0].kind = "scene"
    timeline.segments[0].scene_type = "title"
    save_timeline(imported_project, timeline)

    with pytest.raises(RenderSegmentError, match="only 'recording' is"):
        render_segment(imported_project, timeline.segments[0].id)


def test_render_segment_missing_source_raises(imported_project: Path) -> None:
    (imported_project / "sources" / "main.mp4").unlink()
    with pytest.raises(RenderSegmentError, match="source not found"):
        render_segment(imported_project, "seg_001")


# ---------------------------------------------------------------------------
# Integration: actually render with ffmpeg
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_render_segment_produces_mp4_first_time(imported_project: Path) -> None:
    result = render_segment(imported_project, "seg_001")

    assert result.cached is False
    assert result.out_path.exists()
    assert result.out_path.name == "seg_001.mp4"
    assert result.out_path.parent == imported_project / "out" / "segments"

    # cache sidecar written
    cache = result.out_path.with_suffix(".mp4.cache.json")
    assert cache.exists()


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_render_segment_second_call_is_cached(imported_project: Path) -> None:
    first = render_segment(imported_project, "seg_001")
    second = render_segment(imported_project, "seg_001")

    assert first.cached is False
    assert second.cached is True
    assert first.input_hash == second.input_hash


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_render_segment_force_bypasses_cache(imported_project: Path) -> None:
    render_segment(imported_project, "seg_001")
    forced = render_segment(imported_project, "seg_001", force=True)
    assert forced.cached is False


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_render_segment_invalidated_by_segment_edit(imported_project: Path) -> None:
    """Editing the segment in timeline.json invalidates the cache."""
    render_segment(imported_project, "seg_001")

    timeline = load_timeline(imported_project)
    # shorten the segment
    timeline.segments[0].source_end = 4.0
    timeline.segments[0].target_duration = 4.0
    save_timeline(imported_project, timeline)

    result = render_segment(imported_project, "seg_001")
    assert result.cached is False, "edit to source_end should bust the cache"


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_render_segment_output_has_correct_resolution(imported_project: Path) -> None:
    """9:16 project should produce 1080x1920 output."""
    project = load_project(imported_project)
    assert project.aspect == "9:16"

    result = render_segment(imported_project, "seg_001")
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0",
            str(result.out_path),
        ],
        capture_output=True, text=True, check=True,
    )
    w, h = probe.stdout.strip().split(",")
    assert (int(w), int(h)) == (1080, 1920)


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_render_segment_silent_when_no_voiceover(imported_project: Path) -> None:
    """Segment with voiceover.enabled=False produces a silent output."""
    timeline = load_timeline(imported_project)
    timeline.segments[0].voiceover.enabled = False
    save_timeline(imported_project, timeline)

    result = render_segment(imported_project, "seg_001")
    # ffprobe: count audio streams
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=index", "-of", "csv=p=0",
            str(result.out_path),
        ],
        capture_output=True, text=True, check=True,
    )
    assert probe.stdout.strip() == "", "expected no audio streams"
