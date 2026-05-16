"""Tests for `delete_video()` — manifest + per-video artifact cleanup.

Covers:
  - happy path: manifest gone, every per-video subtree gone, project
    and OTHER videos survive
  - the "last video" safety check (refuses; project unchanged)
  - idempotence (re-running on a missing id is a no-op)
  - the CLI surface: `clipwright video delete` honors the same rules
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.schema import (
    SchemaError,
    delete_video,
    list_videos,
)


def _seed_project(d: Path, video_ids: list[str]) -> None:
    """Lay down a v2 project with `video_ids` empty manifests plus a
    full set of per-video artifact directories for each, so the delete
    function has something to clean up."""
    (d / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    (d / "videos").mkdir()
    for vid in video_ids:
        (d / "videos" / f"{vid}.json").write_text(json.dumps({
            "schema_version": 2, "video_id": vid, "title": vid,
            "chat_session_id": "", "segments": [],
        }))
        # Artifact trees — each per-video subdir gets one file so we can
        # later verify both the dir and its contents are gone.
        for area in [
            f"voiceover/audio/{vid}",
            f"captions/{vid}",
            f"out/segments/{vid}",
            f"chat/sessions/{vid}",
        ]:
            (d / area).mkdir(parents=True)
            (d / area / "seg_001.bin").write_bytes(b"x")
        # Standalone per-video files.
        (d / "voiceover" / "scripts").mkdir(parents=True, exist_ok=True)
        (d / "voiceover" / "scripts" / f"{vid}.json").write_text("{}")
        (d / "out" / "final").mkdir(parents=True, exist_ok=True)
        (d / "out" / "final" / f"{vid}.mp4").write_bytes(b"fake")
        (d / ".clipwright" / "claude-sessions").mkdir(parents=True, exist_ok=True)
        (d / ".clipwright" / "claude-sessions" / f"{vid}.txt").write_text("sess-id")


def test_delete_video_removes_manifest_and_all_artifacts(tmp_path: Path) -> None:
    _seed_project(tmp_path, ["chapter-1", "chapter-2"])
    removed = delete_video(tmp_path, "chapter-1")
    # Manifest first in the returned list.
    assert removed[0].name == "chapter-1.json"
    # Every chapter-1 path is gone.
    assert not (tmp_path / "videos" / "chapter-1.json").exists()
    assert not (tmp_path / "voiceover" / "audio" / "chapter-1").exists()
    assert not (tmp_path / "captions" / "chapter-1").exists()
    assert not (tmp_path / "out" / "segments" / "chapter-1").exists()
    assert not (tmp_path / "chat" / "sessions" / "chapter-1").exists()
    assert not (tmp_path / "voiceover" / "scripts" / "chapter-1.json").exists()
    assert not (tmp_path / "out" / "final" / "chapter-1.mp4").exists()
    assert not (tmp_path / ".clipwright" / "claude-sessions" / "chapter-1.txt").exists()
    # chapter-2 untouched.
    assert (tmp_path / "videos" / "chapter-2.json").exists()
    assert (tmp_path / "voiceover" / "audio" / "chapter-2").exists()
    assert list_videos(tmp_path) == ["chapter-2"]


def test_delete_video_refuses_to_drop_last_video(tmp_path: Path) -> None:
    _seed_project(tmp_path, ["main"])
    with pytest.raises(SchemaError, match="last video"):
        delete_video(tmp_path, "main")
    # Nothing was touched.
    assert (tmp_path / "videos" / "main.json").exists()
    assert (tmp_path / "voiceover" / "audio" / "main").exists()


def test_delete_video_idempotent_on_missing_id(tmp_path: Path) -> None:
    _seed_project(tmp_path, ["main", "extra"])
    delete_video(tmp_path, "extra")
    # Second call against the same (now-missing) id should no-op.
    assert delete_video(tmp_path, "extra") == []


def test_delete_video_leaves_project_metadata(tmp_path: Path) -> None:
    _seed_project(tmp_path, ["chapter-1", "chapter-2"])
    delete_video(tmp_path, "chapter-1")
    payload = json.loads((tmp_path / "project.json").read_text())
    assert payload["title"] == "t"
    assert payload["aspect"] == "9:16"


def test_cli_video_delete_requires_yes(tmp_path: Path) -> None:
    """Without --yes the CLI prints a warning and bails (exit 0, no-op)."""
    from typer.testing import CliRunner

    from clipwright.cli import app

    _seed_project(tmp_path, ["chapter-1", "chapter-2"])
    result = CliRunner().invoke(
        app, ["video", "delete", "chapter-1", "--project", str(tmp_path)],
    )
    assert result.exit_code == 0
    assert "Pass --yes" in result.output
    # File survived.
    assert (tmp_path / "videos" / "chapter-1.json").exists()


def test_cli_video_delete_with_yes_deletes(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from clipwright.cli import app

    _seed_project(tmp_path, ["chapter-1", "chapter-2"])
    result = CliRunner().invoke(
        app, ["video", "delete", "chapter-1", "--project", str(tmp_path), "--yes"],
    )
    assert result.exit_code == 0, result.output
    assert not (tmp_path / "videos" / "chapter-1.json").exists()
    assert (tmp_path / "videos" / "chapter-2.json").exists()


def test_cli_video_delete_unknown_id_errors(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from clipwright.cli import app

    _seed_project(tmp_path, ["main"])
    result = CliRunner().invoke(
        app, ["video", "delete", "nonexistent", "--project", str(tmp_path), "--yes"],
    )
    assert result.exit_code != 0
