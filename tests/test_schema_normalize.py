"""Tests for the v2 video_id normalizer.

Earlier desktop builds wrote `videos/Chapter-1-recap.json` (capital C)
which the v2 regex rejects on load. The normalizer fixes those projects
in place so the user isn't stuck.
"""
from __future__ import annotations

import json
from pathlib import Path

from clipwright.schema import list_videos, load_project, load_video
from clipwright.schema.v2.normalize import normalize_v2_video_ids


def _v2_segment(seg_id: str = "seg_001") -> dict:
    return {
        "id": seg_id,
        "source": "sources/main.mp4",
        "source_start": 0.0, "source_end": 5.0, "target_duration": 5.0,
        "kind": "recording", "scene_type": None,
        "label": "", "chapter": "",
        "voiceover": {"enabled": True, "script_clip_id": "vo_001"},
        "captions": {"enabled": True, "ref": f"captions/index.json#{seg_id}"},
        "camera": {"enabled": False, "ref": ""},
        "annotations": {"enabled": False, "ref": ""},
    }


def _write_v2_project_with_bad_video(d: Path, bad_id: str = "Chapter-1-recap") -> None:
    (d / "project.json").write_text(json.dumps({
        "schema_version": 2,
        "title": "Recap Channel",
        "aspect": "9:16",
        "fps": 30,
        "render_backend": "remotion",
        "tts_provider": "kokoro",
    }))
    videos_dir = d / "videos"
    videos_dir.mkdir()
    (videos_dir / f"{bad_id}.json").write_text(json.dumps({
        "schema_version": 2,
        "video_id": bad_id,
        "title": "Chapter 1 — The Return",
        "chat_session_id": "",
        "segments": [_v2_segment("seg_001")],
    }))


def test_normalizer_renames_capital_id_file_and_field(tmp_path: Path) -> None:
    _write_v2_project_with_bad_video(tmp_path)
    report = normalize_v2_video_ids(tmp_path)
    assert report.renames == [("Chapter-1-recap", "chapter-1-recap")]
    # macOS APFS is case-insensitive — `Path.exists()` returns True for
    # both capitalizations even after rename. Read the actual directory
    # listing (which preserves case) to verify the rename took.
    on_disk = sorted(p.name for p in (tmp_path / "videos").iterdir())
    assert on_disk == ["chapter-1-recap.json"], f"actual: {on_disk}"
    payload = json.loads((tmp_path / "videos" / "chapter-1-recap.json").read_text())
    assert payload["video_id"] == "chapter-1-recap"
    assert payload["title"] == "Chapter 1 — The Return"
    assert [s["id"] for s in payload["segments"]] == ["seg_001"]


def test_normalizer_relocates_per_video_artifacts(tmp_path: Path) -> None:
    _write_v2_project_with_bad_video(tmp_path)
    # Lay down artifact files under the old id so the normalizer has
    # something to move.
    audio = tmp_path / "voiceover" / "audio" / "Chapter-1-recap"
    audio.mkdir(parents=True)
    (audio / "seg_001.mp3").write_bytes(b"fake")
    captions = tmp_path / "captions" / "Chapter-1-recap" / "seg_001"
    captions.mkdir(parents=True)
    (captions / "000.png").write_bytes(b"fake")
    script = tmp_path / "voiceover" / "scripts" / "Chapter-1-recap.json"
    script.parent.mkdir(parents=True)
    script.write_text("{}")
    out_final = tmp_path / "out" / "final" / "Chapter-1-recap.mp4"
    out_final.parent.mkdir(parents=True)
    out_final.write_bytes(b"fake")

    normalize_v2_video_ids(tmp_path)

    # Verify via directory listing — case-insensitive FS lies about exists().
    assert sorted(p.name for p in (tmp_path / "voiceover" / "audio").iterdir()) == ["chapter-1-recap"]
    assert sorted(p.name for p in (tmp_path / "captions").iterdir()) == ["chapter-1-recap"]
    assert sorted(p.name for p in (tmp_path / "voiceover" / "scripts").iterdir()) == ["chapter-1-recap.json"]
    assert sorted(p.name for p in (tmp_path / "out" / "final").iterdir()) == ["chapter-1-recap.mp4"]
    # Content survives.
    assert (tmp_path / "voiceover" / "audio" / "chapter-1-recap" / "seg_001.mp3").read_bytes() == b"fake"


def test_normalizer_idempotent(tmp_path: Path) -> None:
    _write_v2_project_with_bad_video(tmp_path)
    normalize_v2_video_ids(tmp_path)
    # Second pass: nothing to do.
    second = normalize_v2_video_ids(tmp_path)
    assert second.renames == []


def test_normalizer_handles_collision(tmp_path: Path) -> None:
    """If sanitizing produces an id that already exists, append a numeric
    suffix instead of overwriting. Two bad ids that sanitize to the same
    target exercise the collision logic without depending on FS
    case-sensitivity (which differs across macOS / Linux / Windows)."""
    # Project shell.
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    (tmp_path / "videos").mkdir()
    # A legit, already-conforming video.
    (tmp_path / "videos" / "chapter-1.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "chapter-1", "title": "Original",
        "chat_session_id": "", "segments": [],
    }))
    # Two non-conforming files that both sanitize to "chapter-1".
    (tmp_path / "videos" / "Chapter 1!.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "Chapter 1!", "title": "Alt 1",
        "chat_session_id": "", "segments": [],
    }))
    (tmp_path / "videos" / "Chapter#1.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "Chapter#1", "title": "Alt 2",
        "chat_session_id": "", "segments": [],
    }))
    report = normalize_v2_video_ids(tmp_path)
    new_ids = sorted(new for _old, new in report.renames)
    # The colliders get -2 / -3 suffixes; "chapter-1" itself is preserved.
    assert new_ids == ["chapter-1-2", "chapter-1-3"]
    on_disk = sorted(p.name for p in (tmp_path / "videos").iterdir())
    assert "chapter-1.json" in on_disk
    assert "chapter-1-2.json" in on_disk
    assert "chapter-1-3.json" in on_disk


def test_normalizer_handles_punctuated_ids(tmp_path: Path) -> None:
    _write_v2_project_with_bad_video(tmp_path, bad_id="Chapter 2!! (final)")
    report = normalize_v2_video_ids(tmp_path)
    new_id = report.renames[0][1]
    assert new_id == "chapter-2-final"
    assert (tmp_path / "videos" / "chapter-2-final.json").exists()


def test_load_project_auto_normalizes(tmp_path: Path) -> None:
    """The public API hides normalization entirely."""
    _write_v2_project_with_bad_video(tmp_path)
    p = load_project(tmp_path)
    assert p.title == "Recap Channel"
    assert list_videos(tmp_path) == ["chapter-1-recap"]
    v = load_video(tmp_path, "chapter-1-recap")
    assert v.video_id == "chapter-1-recap"
