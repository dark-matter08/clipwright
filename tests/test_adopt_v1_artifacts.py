"""Tests for `adopt_v1_artifacts` — recovering hybrid v1-artifacts/v2-manifest projects.

Real-world bug: Claude drove `clipwright record/render-final` (legacy
v1 CLI flow) inside a project that had already been migrated to v2.
The render landed at `out/final.mp4` (flat) but the v2 manifest at
`videos/<id>.json` stayed empty, so the desktop showed nothing. The
adopt function relocates the flat files into per-video v2 paths and
rebuilds `segments[]` from `script.json` + `edl.json`.
"""
from __future__ import annotations

import json
from pathlib import Path

from clipwright.schema import adopt_v1_artifacts


def _seed_hybrid_project(d: Path) -> None:
    """Lay down a v2 project shell with v1-style flat artifacts."""
    (d / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "Recap", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    (d / "videos").mkdir()
    (d / "videos" / "chapter-1.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "chapter-1", "title": "Chapter 1",
        "chat_session_id": "", "segments": [],   # the smoking gun
    }))
    # Flat v1 artifacts.
    (d / "script.json").write_text(json.dumps({
        "clips": [
            {"id": "01_opening", "target_seconds": 18.6,
             "chapter": "opening", "text": "A dungeon. Dark."},
            {"id": "02_protagonist", "target_seconds": 15.1,
             "chapter": "protagonist", "text": "His name is Encrid."},
            {"id": "03_hook", "target_seconds": 7.7,
             "chapter": "hook", "text": "Watch what happens next."},
        ],
    }))
    (d / "out").mkdir()
    (d / "out" / "final.mp4").write_bytes(b"fake-mp4")
    (d / "out" / "edl.json").write_text(json.dumps({
        "video": str(d / "out" / "video.mp4"),
        "duration": 41.4,
        "ranges": [[3.5, 22.1], [17.5, 32.6], [28.0, 35.7]],
    }))
    (d / "out" / "segments").mkdir()
    (d / "out" / "segments" / "seg_001.mp4").write_bytes(b"fake-seg-1")
    (d / "out" / "segments" / "_work").mkdir()  # should be ignored


def test_adopt_relocates_flat_artifacts(tmp_path: Path) -> None:
    _seed_hybrid_project(tmp_path)
    report = adopt_v1_artifacts(tmp_path, "chapter-1")
    # script.json → voiceover/scripts/chapter-1.json
    assert not (tmp_path / "script.json").exists()
    assert (tmp_path / "voiceover" / "scripts" / "chapter-1.json").exists()
    # out/final.mp4 → out/final/chapter-1.mp4
    assert not (tmp_path / "out" / "final.mp4").exists()
    assert (tmp_path / "out" / "final" / "chapter-1.mp4").exists()
    # out/segments/seg_001.mp4 → out/segments/chapter-1/seg_001.mp4
    assert (tmp_path / "out" / "segments" / "chapter-1" / "seg_001.mp4").exists()
    assert not (tmp_path / "out" / "segments" / "seg_001.mp4").exists()
    # `_work/` left alone.
    assert (tmp_path / "out" / "segments" / "_work").exists()
    assert report.segments_added == 3


def test_adopt_rebuilds_segments_from_script_and_edl(tmp_path: Path) -> None:
    _seed_hybrid_project(tmp_path)
    adopt_v1_artifacts(tmp_path, "chapter-1")
    manifest = json.loads(
        (tmp_path / "videos" / "chapter-1.json").read_text()
    )
    segs = manifest["segments"]
    assert len(segs) == 3
    assert [s["id"] for s in segs] == ["seg_001", "seg_002", "seg_003"]
    # Source ranges pulled from EDL (3 clips, 3 ranges → 1:1 mapping).
    assert segs[0]["source_start"] == 3.5
    assert segs[0]["source_end"] == 22.1
    assert segs[2]["target_duration"] == 7.7
    # Voiceover script_clip_id wired through.
    assert segs[0]["voiceover"]["script_clip_id"] == "01_opening"
    # Caption ref uses the new seg_NNN id.
    assert segs[1]["captions"]["ref"] == "captions/index.json#seg_002"
    # `source` is the recording path, relative to the project.
    assert segs[0]["source"] == "out/video.mp4"


def test_adopt_idempotent(tmp_path: Path) -> None:
    """A second call after a successful adoption is a no-op."""
    _seed_hybrid_project(tmp_path)
    first = adopt_v1_artifacts(tmp_path, "chapter-1")
    assert first.segments_added == 3
    second = adopt_v1_artifacts(tmp_path, "chapter-1")
    # Manifest already has segments, files already relocated → nothing
    # to do. `moved` may be empty; `segments_added` must be 0.
    assert second.segments_added == 0
    assert second.moved == []


def test_adopt_handles_no_edl(tmp_path: Path) -> None:
    """No EDL → segments get target_duration as source_end (fallback)."""
    _seed_hybrid_project(tmp_path)
    (tmp_path / "out" / "edl.json").unlink()
    adopt_v1_artifacts(tmp_path, "chapter-1")
    manifest = json.loads(
        (tmp_path / "videos" / "chapter-1.json").read_text()
    )
    segs = manifest["segments"]
    assert segs[0]["source_start"] == 0.0
    assert segs[0]["source_end"] == 18.6  # falls back to target_seconds


def test_adopt_no_op_when_no_v1_artifacts(tmp_path: Path) -> None:
    """A clean v2 project shouldn't blow up — adopt is just a no-op."""
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "", "segments": [],
    }))
    report = adopt_v1_artifacts(tmp_path, "main")
    assert report.moved == []
    assert report.segments_added == 0


def test_adopt_warns_when_script_and_v2_script_both_exist(tmp_path: Path) -> None:
    """Pre-existing v2 script + flat script → leave both, warn."""
    _seed_hybrid_project(tmp_path)
    v2_script = tmp_path / "voiceover" / "scripts" / "chapter-1.json"
    v2_script.parent.mkdir(parents=True)
    v2_script.write_text("{}")
    report = adopt_v1_artifacts(tmp_path, "chapter-1")
    assert any("both flat" in w for w in report.warnings)
    # Flat script untouched.
    assert (tmp_path / "script.json").exists()


def test_cli_video_adopt(tmp_path: Path) -> None:
    """The CLI surface mirrors the Python function and exits cleanly."""
    from typer.testing import CliRunner

    from clipwright.cli import app

    _seed_hybrid_project(tmp_path)
    result = CliRunner().invoke(
        app, ["video", "adopt", "chapter-1", "--project", str(tmp_path)],
    )
    assert result.exit_code == 0, result.output
    assert "3 segments rebuilt" in result.output or "Adopted" in result.output
