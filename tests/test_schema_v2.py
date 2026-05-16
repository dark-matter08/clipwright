"""Schema v2 tests: Project / Video models + per-video paths + IO round-trip."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.schema import (
    SCHEMA_VERSION,
    Project,
    SchemaError,
    SchemaVersionError,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Video,
    create_video,
    list_videos,
    load_project,
    load_video,
    next_video_id,
    save_project,
    save_video,
)
from clipwright.schema import paths as schema_paths

# ---------------------------------------------------------------------------
# Project (v2)
# ---------------------------------------------------------------------------

def test_project_roundtrip(tmp_path: Path) -> None:
    p = Project(
        title="Recap Videos for Eternal Regressing Knight",
        aspect="9:16",
        fps=30,
        render_backend="remotion",
        tts_provider="kokoro",
        voice_id="af_sky",
        base_url="https://kunmanga.com/manga/eternally-regressing-knight",
        created_at="2026-05-13T00:00:00Z",
    )
    save_project(tmp_path, p)
    loaded = load_project(tmp_path)
    assert loaded.title == p.title
    assert loaded.base_url == p.base_url
    assert loaded.loaded_schema_version == SCHEMA_VERSION


def test_project_rejects_future_schema_version(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(json.dumps({"schema_version": 999}))
    with pytest.raises(SchemaVersionError, match="newer"):
        load_project(tmp_path)


# ---------------------------------------------------------------------------
# Video (v2)
# ---------------------------------------------------------------------------

def _segment(seg_id: str = "seg_001") -> Segment:
    return Segment(
        id=seg_id,
        source="sources/main.mp4",
        source_start=0.0,
        source_end=12.0,
        target_duration=12.0,
        kind="recording",
        voiceover=SegmentVoiceover(enabled=True, script_clip_id="vo_001"),
        captions=SegmentRef(enabled=True, ref=f"captions/index.json#{seg_id}"),
        camera=SegmentRef(enabled=True, ref=f"camera.json#{seg_id}"),
        annotations=SegmentRef(enabled=False, ref=""),
    )


def test_video_roundtrip(tmp_path: Path) -> None:
    save_project(tmp_path, Project())
    v = Video(
        video_id="chapter-1-recap",
        title="Chapter 1 — The Return",
        segments=[_segment("seg_001"), _segment("seg_002")],
    )
    save_video(tmp_path, v)
    loaded = load_video(tmp_path, "chapter-1-recap")
    assert loaded.video_id == "chapter-1-recap"
    assert loaded.title == "Chapter 1 — The Return"
    assert [s.id for s in loaded.segments] == ["seg_001", "seg_002"]


def test_video_id_format_enforced() -> None:
    with pytest.raises(ValueError, match="video_id"):
        Video.from_dict({"schema_version": 2, "video_id": "1starting-with-digit", "segments": []})
    with pytest.raises(ValueError, match="video_id"):
        Video.from_dict({"schema_version": 2, "video_id": "Has Capitals", "segments": []})
    with pytest.raises(ValueError, match="video_id"):
        Video.from_dict({"schema_version": 2, "video_id": "../escape", "segments": []})


def test_video_rejects_duplicate_segment_ids() -> None:
    payload = {
        "schema_version": 2,
        "video_id": "main",
        "segments": [_segment("seg_001").to_dict(), _segment("seg_001").to_dict()],
    }
    with pytest.raises(ValueError, match="duplicate"):
        Video.from_dict(payload)


# ---------------------------------------------------------------------------
# Project-level video index
# ---------------------------------------------------------------------------

def test_list_videos_orders_main_first(tmp_path: Path) -> None:
    save_project(tmp_path, Project())
    create_video(tmp_path, "zeta")
    create_video(tmp_path, "alpha")
    create_video(tmp_path, "main")
    assert list_videos(tmp_path) == ["main", "alpha", "zeta"]


def test_list_videos_empty_when_no_videos_dir(tmp_path: Path) -> None:
    save_project(tmp_path, Project())
    assert list_videos(tmp_path) == []


def test_create_video_errors_on_duplicate(tmp_path: Path) -> None:
    save_project(tmp_path, Project())
    create_video(tmp_path, "main")
    with pytest.raises(SchemaError, match="already exists"):
        create_video(tmp_path, "main")


def test_next_video_id_sanitizes_hint() -> None:
    assert next_video_id([], "Chapter 1 Recap!") == "chapter-1-recap"
    assert next_video_id(["main"], "Main") == "main-2"
    # Hint starting with digit falls back to video-N
    assert next_video_id([], "123abc") == "video-1"
    # Empty hint → numeric series
    assert next_video_id([], "") == "video-1"
    assert next_video_id(["video-1"], "") == "video-2"


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def test_paths_scope_artifacts_by_video(tmp_path: Path) -> None:
    p = schema_paths
    assert p.video_manifest_path(tmp_path, "main") == tmp_path / "videos" / "main.json"
    assert p.video_audio_dir(tmp_path, "main") == tmp_path / "voiceover" / "audio" / "main"
    assert p.video_audio_mp3(tmp_path, "main", "seg_001") == tmp_path / "voiceover" / "audio" / "main" / "seg_001.mp3"
    assert p.video_captions_dir(tmp_path, "main", "seg_001") == tmp_path / "captions" / "main" / "seg_001"
    assert p.video_render_dir(tmp_path, "main") == tmp_path / "out" / "segments" / "main"
    assert p.video_final_path(tmp_path, "main") == tmp_path / "out" / "final" / "main.mp4"
    assert p.video_script_path(tmp_path, "main") == tmp_path / "voiceover" / "scripts" / "main.json"


def test_paths_distinguish_two_videos(tmp_path: Path) -> None:
    """Per-video scoping: no path collides between two videos with same seg_id."""
    p = schema_paths
    a = p.video_render_mp4(tmp_path, "main", "seg_001")
    b = p.video_render_mp4(tmp_path, "chapter-2", "seg_001")
    assert a != b
    assert "main" in str(a) and "chapter-2" in str(b)
