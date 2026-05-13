"""v1 → v2 schema migration tests.

Builds synthetic v1 project layouts, runs the migration, asserts that the
v2 layout is correct and that the originals are backed up under
`.clipwright/v1-backup/` for rollback. Idempotency is also verified.
"""
from __future__ import annotations

import json
from pathlib import Path

from clipwright.schema import list_videos, load_project, load_video
from clipwright.schema.v2.migrate import (
    is_v1_project,
    upgrade_v1_project_to_v2,
)


def _v1_segment(seg_id: str = "seg_001") -> dict:
    return {
        "id": seg_id,
        "source": "sources/main.mp4",
        "source_start": 0.0,
        "source_end": 5.0,
        "target_duration": 5.0,
        "kind": "recording",
        "scene_type": None,
        "label": "",
        "chapter": "",
        "voiceover": {"enabled": False, "script_clip_id": ""},
        "captions": {"enabled": True, "ref": f"captions/index.json#{seg_id}"},
        "camera": {"enabled": False, "ref": ""},
        "annotations": {"enabled": False, "ref": ""},
    }


def _build_v1_project(d: Path) -> None:
    """Lay down a minimal v1 project at `d` with one segment and one of
    each per-segment artifact kind. Used as fixture by every test."""
    (d / "project.json").write_text(json.dumps({
        "schema_version": 1,
        "title": "Legacy",
        "aspect": "9:16",
        "fps": 30,
        "render_backend": "remotion",
        "tts_provider": "kokoro",
    }))
    (d / "timeline.json").write_text(json.dumps({
        "schema_version": 1,
        "segments": [_v1_segment("seg_001")],
    }))
    audio_dir = d / "voiceover" / "audio"
    audio_dir.mkdir(parents=True)
    (audio_dir / "seg_001.mp3").write_bytes(b"fake mp3")
    (audio_dir / "seg_001.timestamps.json").write_text('{"characters":[]}')
    (audio_dir / "seg_001.cache.json").write_text('{"input_hash":"x"}')
    (d / "voiceover" / "script.json").write_text(json.dumps({
        "schema_version": 1,
        "clips": [{"id": "vo_001", "segment_id": "seg_001", "text": "hi"}],
    }))
    captions_seg = d / "captions" / "seg_001"
    captions_seg.mkdir(parents=True)
    (captions_seg / "000.png").write_bytes(b"fake png")
    (captions_seg / "index.json").write_text('{"schema_version":1,"chunks":[]}')
    (d / "captions" / "style.json").write_text('{"default":{}}')
    (d / "out" / "segments").mkdir(parents=True)
    (d / "out" / "segments" / "seg_001.mp4").write_bytes(b"fake mp4")
    (d / "out" / "final.mp4").write_bytes(b"fake final")


# ---------------------------------------------------------------------------

def test_is_v1_project_detection(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    assert is_v1_project(tmp_path) is True


def test_is_v1_project_returns_false_for_v2(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(json.dumps({"schema_version": 2}))
    (tmp_path / "videos").mkdir()
    assert is_v1_project(tmp_path) is False


def test_is_v1_project_returns_false_for_missing(tmp_path: Path) -> None:
    assert is_v1_project(tmp_path) is False


def test_migration_writes_v2_project_manifest(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    p = load_project(tmp_path)
    assert p.loaded_schema_version == 2
    assert p.title == "Legacy"


def test_migration_creates_videos_main_json(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    assert list_videos(tmp_path) == ["main"]
    v = load_video(tmp_path, "main")
    assert v.video_id == "main"
    assert [s.id for s in v.segments] == ["seg_001"]


def test_migration_relocates_voiceover_audio(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    new_dir = tmp_path / "voiceover" / "audio" / "main"
    assert (new_dir / "seg_001.mp3").exists()
    assert (new_dir / "seg_001.timestamps.json").exists()
    assert (new_dir / "seg_001.cache.json").exists()
    # Old flat layout is gone.
    assert not (tmp_path / "voiceover" / "audio" / "seg_001.mp3").exists()


def test_migration_relocates_voiceover_script(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    assert (tmp_path / "voiceover" / "scripts" / "main.json").exists()
    assert not (tmp_path / "voiceover" / "script.json").exists()


def test_migration_relocates_captions_but_keeps_style(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    assert (tmp_path / "captions" / "main" / "seg_001" / "000.png").exists()
    # style.json is project-level, not per-segment; it stays put.
    assert (tmp_path / "captions" / "style.json").exists()


def test_migration_relocates_render_outputs(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    assert (tmp_path / "out" / "segments" / "main" / "seg_001.mp4").exists()
    assert (tmp_path / "out" / "final" / "main.mp4").exists()
    assert not (tmp_path / "out" / "final.mp4").exists()


def test_migration_backs_up_originals(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    backup = tmp_path / ".clipwright" / "v1-backup"
    assert (backup / "project.json").exists()
    assert (backup / "timeline.json").exists()


def test_migration_is_idempotent(tmp_path: Path) -> None:
    _build_v1_project(tmp_path)
    upgrade_v1_project_to_v2(tmp_path)
    # Second run is a no-op — no exceptions, no further file relocations.
    report = upgrade_v1_project_to_v2(tmp_path)
    assert report.moved_paths == []


def test_load_project_auto_migrates(tmp_path: Path) -> None:
    """The public API should hide migration entirely — calling load_project
    on a v1 layout returns a v2 Project after migrating in place."""
    _build_v1_project(tmp_path)
    p = load_project(tmp_path)
    assert p.loaded_schema_version == 2
    # The v1 timeline.json is gone after auto-migration.
    assert not (tmp_path / "timeline.json").exists()
    assert list_videos(tmp_path) == ["main"]
