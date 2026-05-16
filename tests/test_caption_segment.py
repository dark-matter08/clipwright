"""Tests for `caption_segment` — per-segment caption generation in v1 layout."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.caption_segment import (
    CaptionSegmentError,
    _compute_input_hash,
    _resolve_style,
    caption_segment,
)
from clipwright.schema import (
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Video,
    save_project,
    save_video,
)

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------


def _elevenlabs_alignment(text: str = "Hello world. Quick demo.") -> dict:
    """Build a synthetic ElevenLabs-shaped alignment object.

    Each character gets a deterministic 80ms window. Punctuation and spaces
    advance the clock so word boundaries land where the chunker expects.
    """
    chars = list(text)
    step = 0.08
    starts = [round(i * step, 3) for i in range(len(chars))]
    ends = [round((i + 1) * step, 3) for i in range(len(chars))]
    return {
        "characters": chars,
        "character_start_times_seconds": starts,
        "character_end_times_seconds": ends,
    }


def _make_project(tmp_path: Path, *, aspect: str = "9:16") -> Path:
    """Build a minimal v1 project with one segment ready for captioning."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()

    save_project(
        project_dir,
        Project(title="t", aspect=aspect, fps=30,
                render_backend="remotion", tts_provider="kokoro"),
    )
    save_video(
        project_dir,
        Video(video_id="main", segments=[
            Segment(
                id="seg_001",
                source="sources/main.mp4",
                source_start=0.0, source_end=5.0, target_duration=5.0,
                kind="recording",
                voiceover=SegmentVoiceover(enabled=True, script_clip_id="vo_001"),
                captions=SegmentRef(enabled=True, ref="captions/index.json#seg_001"),
                camera=SegmentRef(enabled=False, ref=""),
                annotations=SegmentRef(enabled=False, ref=""),
            ),
        ]),
    )

    # Write a synthetic VO timestamps file (per-video path)
    audio_dir = project_dir / "voiceover" / "audio" / "main"
    audio_dir.mkdir(parents=True)
    (audio_dir / "seg_001.timestamps.json").write_text(
        json.dumps(_elevenlabs_alignment())
    )
    return project_dir


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_caption_segment_produces_pngs_and_index(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)

    result = caption_segment(project_dir, "seg_001")

    assert result.cached is False
    assert result.n_chunks > 0

    # PNG files written
    pngs = sorted((project_dir / "captions" / "main" / "seg_001").glob("*.png"))
    assert len(pngs) == result.n_chunks
    assert pngs[0].name == "000.png"

    # Index.json shape matches what render_segment expects
    index = json.loads(result.index_path.read_text())
    assert index["schema_version"] == 1
    assert len(index["chunks"]) == result.n_chunks
    first = index["chunks"][0]
    assert {"start", "end", "png", "text"} <= set(first.keys())
    assert first["png"] == "000.png"

    # cache sidecar written
    assert (project_dir / "captions" / "main" / "seg_001" / ".cache.json").exists()


def test_caption_segment_uppercase_text(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    result = caption_segment(project_dir, "seg_001")
    index = json.loads(result.index_path.read_text())
    for chunk in index["chunks"]:
        assert chunk["text"] == chunk["text"].upper()


# ---------------------------------------------------------------------------
# Cache behavior
# ---------------------------------------------------------------------------


def test_caption_segment_second_call_is_cached(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    first = caption_segment(project_dir, "seg_001")
    second = caption_segment(project_dir, "seg_001")

    assert first.cached is False
    assert second.cached is True
    assert first.input_hash == second.input_hash
    assert second.n_chunks == first.n_chunks


def test_caption_segment_force_bypasses_cache(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    caption_segment(project_dir, "seg_001")
    forced = caption_segment(project_dir, "seg_001", force=True)
    assert forced.cached is False


def test_caption_segment_invalidated_by_timestamps_change(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    caption_segment(project_dir, "seg_001")

    # New text → new fingerprint
    (project_dir / "voiceover" / "audio" / "main" / "seg_001.timestamps.json").write_text(
        json.dumps(_elevenlabs_alignment("Different words entirely. Fresh take."))
    )
    result = caption_segment(project_dir, "seg_001")
    assert result.cached is False


def test_caption_segment_invalidated_by_aspect_change(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path, aspect="9:16")
    caption_segment(project_dir, "seg_001")

    # Edit project.json → different resolution → different style fingerprint
    project = Project(title="t", aspect="16:9", fps=30,
                       render_backend="remotion", tts_provider="kokoro")
    save_project(project_dir, project)
    result = caption_segment(project_dir, "seg_001")
    assert result.cached is False


def test_caption_segment_stale_pngs_pruned_on_regen(tmp_path: Path) -> None:
    """Re-rendering a now-shorter script should not leave orphan PNGs."""
    project_dir = _make_project(tmp_path)
    first = caption_segment(project_dir, "seg_001")

    # shorten the script — fewer chunks expected
    (project_dir / "voiceover" / "audio" / "main" / "seg_001.timestamps.json").write_text(
        json.dumps(_elevenlabs_alignment("Hi."))
    )
    second = caption_segment(project_dir, "seg_001")
    pngs = sorted((project_dir / "captions" / "main" / "seg_001").glob("*.png"))
    assert len(pngs) == second.n_chunks
    assert second.n_chunks < first.n_chunks


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_caption_segment_missing_id_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    with pytest.raises(CaptionSegmentError, match="not found"):
        caption_segment(project_dir, "seg_999")


def test_caption_segment_captions_disabled_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    timeline = Video(video_id="main", segments=[
        Segment(
            id="seg_001", source="sources/main.mp4",
            source_start=0.0, source_end=5.0, target_duration=5.0,
            kind="recording",
            voiceover=SegmentVoiceover(enabled=True, script_clip_id="vo_001"),
            captions=SegmentRef(enabled=False, ref=""),
            camera=SegmentRef(enabled=False, ref=""),
            annotations=SegmentRef(enabled=False, ref=""),
        ),
    ])
    save_video(project_dir, timeline)

    with pytest.raises(CaptionSegmentError, match="disabled"):
        caption_segment(project_dir, "seg_001")


def test_caption_segment_missing_timestamps_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    (project_dir / "voiceover" / "audio" / "main" / "seg_001.timestamps.json").unlink()

    with pytest.raises(CaptionSegmentError, match="timestamps not found"):
        caption_segment(project_dir, "seg_001")


# ---------------------------------------------------------------------------
# Cache-hash logic — pure
# ---------------------------------------------------------------------------


def test_compute_input_hash_deterministic(tmp_path: Path) -> None:
    ts = tmp_path / "t.json"
    ts.write_text("{}")
    h1 = _compute_input_hash(timestamps_path=ts, style_blob="{}", aspect="9:16")
    h2 = _compute_input_hash(timestamps_path=ts, style_blob="{}", aspect="9:16")
    assert h1 == h2
    assert h1.startswith("sha256:")


def test_compute_input_hash_changes_with_style(tmp_path: Path) -> None:
    ts = tmp_path / "t.json"
    ts.write_text("{}")
    h_a = _compute_input_hash(timestamps_path=ts, style_blob="{\"a\":1}",
                                aspect="9:16")
    h_b = _compute_input_hash(timestamps_path=ts, style_blob="{\"a\":2}",
                                aspect="9:16")
    assert h_a != h_b


# ---------------------------------------------------------------------------
# Style resolution
# ---------------------------------------------------------------------------


def test_resolve_style_default(tmp_path: Path) -> None:
    """No style.json → built-in CaptionStyle defaults with aspect-correct canvas."""
    style, blob = _resolve_style(tmp_path, "9:16")
    assert style.width == 1080
    assert style.height == 1920
    assert blob  # non-empty deterministic JSON


def test_resolve_style_reads_default_section(tmp_path: Path) -> None:
    (tmp_path / "captions").mkdir()
    (tmp_path / "captions" / "style.json").write_text(json.dumps({
        "schema_version": 1,
        "default": {"size": 72, "uppercase": True},
    }))
    style, _ = _resolve_style(tmp_path, "9:16")
    assert style.font_size == 72
