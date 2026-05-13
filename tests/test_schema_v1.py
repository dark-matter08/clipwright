"""Smoke tests for the v1 project / timeline schema and atomic I/O."""
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
    Timeline,
    load_project,
    load_timeline,
    save_project,
    save_timeline,
)
from clipwright.schema.v1.timeline import next_segment_id

# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------

def test_project_roundtrip(tmp_path: Path) -> None:
    p = Project(
        title="Demo",
        aspect="9:16",
        fps=30,
        render_backend="remotion",
        tts_provider="kokoro",
        voice_id="af_sky",
        base_url="https://example.com",
        created_at="2026-05-12T00:00:00Z",
    )
    save_project(tmp_path, p)
    loaded = load_project(tmp_path)
    assert loaded.title == "Demo"
    assert loaded.aspect == "9:16"
    assert loaded.tts_provider == "kokoro"
    assert loaded.voice_id == "af_sky"
    assert loaded.loaded_schema_version == SCHEMA_VERSION


def test_project_rejects_unknown_aspect(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(
        json.dumps({"schema_version": 1, "aspect": "21:9"})
    )
    with pytest.raises(SchemaError, match="aspect"):
        load_project(tmp_path)


def test_project_rejects_unknown_tts_provider(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(
        json.dumps({"schema_version": 1, "tts_provider": "openai"})
    )
    with pytest.raises(SchemaError, match="tts_provider"):
        load_project(tmp_path)


def test_project_rejects_future_schema_version(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(
        json.dumps({"schema_version": 999, "aspect": "9:16"})
    )
    with pytest.raises(SchemaVersionError, match="newer"):
        load_project(tmp_path)


# ---------------------------------------------------------------------------
# Timeline / Segment
# ---------------------------------------------------------------------------

def _sample_segment(seg_id: str = "seg_001") -> Segment:
    return Segment(
        id=seg_id,
        source="sources/main.mp4",
        source_start=0.0,
        source_end=12.0,
        target_duration=12.0,
        kind="recording",
        label="Intro",
        chapter="intro",
        voiceover=SegmentVoiceover(enabled=True, script_clip_id="vo_001"),
        captions=SegmentRef(enabled=True, ref=f"captions/index.json#{seg_id}"),
        camera=SegmentRef(enabled=True, ref=f"camera.json#{seg_id}"),
        annotations=SegmentRef(enabled=False, ref=""),
    )


def test_timeline_roundtrip(tmp_path: Path) -> None:
    tl = Timeline(segments=[_sample_segment("seg_001"), _sample_segment("seg_002")])
    save_timeline(tmp_path, tl)
    loaded = load_timeline(tmp_path)
    assert [s.id for s in loaded.segments] == ["seg_001", "seg_002"]
    assert loaded.segments[0].voiceover.script_clip_id == "vo_001"
    assert loaded.segments[0].captions.ref == "captions/index.json#seg_001"
    assert loaded.segments[0].source_duration == pytest.approx(12.0)


def test_segment_id_format_enforced() -> None:
    with pytest.raises(ValueError, match="segment.id"):
        Segment.from_dict({"id": "001", "kind": "recording"})
    with pytest.raises(ValueError, match="segment.id"):
        Segment.from_dict({"id": "seg-001", "kind": "recording"})


def test_segment_ref_format_enforced() -> None:
    with pytest.raises(ValueError, match="SegmentRef.ref"):
        SegmentRef.from_dict({"enabled": True, "ref": "camera.json"})  # missing fragment
    with pytest.raises(ValueError, match="SegmentRef.ref"):
        SegmentRef.from_dict({"enabled": True, "ref": "camera.json#bad"})


def test_segment_source_range_validated() -> None:
    with pytest.raises(ValueError, match="source_end"):
        Segment.from_dict({
            "id": "seg_001",
            "kind": "recording",
            "source_start": 5.0,
            "source_end": 2.0,
        })


def test_scene_requires_scene_type() -> None:
    with pytest.raises(ValueError, match="scene_type"):
        Segment.from_dict({"id": "seg_001", "kind": "scene", "scene_type": None})


def test_timeline_rejects_duplicate_ids() -> None:
    payload = {
        "schema_version": 1,
        "segments": [
            _sample_segment("seg_001").to_dict(),
            _sample_segment("seg_001").to_dict(),
        ],
    }
    with pytest.raises(ValueError, match="duplicate"):
        Timeline.from_dict(payload)


def test_next_segment_id_increments() -> None:
    assert next_segment_id([]) == "seg_001"
    assert next_segment_id(["seg_001", "seg_002"]) == "seg_003"
    # suffixed ids do not advance the counter
    assert next_segment_id(["seg_001", "seg_001a", "seg_002"]) == "seg_003"


# ---------------------------------------------------------------------------
# Atomic I/O
# ---------------------------------------------------------------------------

def test_atomic_write_leaves_no_tmp(tmp_path: Path) -> None:
    save_timeline(tmp_path, Timeline(segments=[_sample_segment()]))
    stragglers = [p.name for p in tmp_path.iterdir() if ".tmp" in p.name]
    assert stragglers == []


def test_invalid_json_raises_schema_error(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text("{not json")
    with pytest.raises(SchemaError, match="invalid JSON"):
        load_project(tmp_path)


def test_missing_file_raises_schema_error(tmp_path: Path) -> None:
    with pytest.raises(SchemaError, match="not found"):
        load_project(tmp_path)
