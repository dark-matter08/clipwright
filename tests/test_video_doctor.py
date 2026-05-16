"""Tests for `clipwright video doctor` — pipeline-completeness audit.

Motivation: Claude was hitting 10-min wall-clock timeouts trying to
render segments against a source video that was way too short for the
script, or against a manifest written in an invented schema (segments
with `panels: [...]` instead of `source` / `source_start` / `source_end`).
Both failure modes are silent without an audit — the v2 dataclass
loader drops unknown fields and defaults missing ones, so a broken
manifest loads cleanly. `video doctor` catches them in 1 second.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.video_doctor import diagnose_video


def _seed_project(d: Path, *, source_duration_marker: int = 60) -> None:
    """Lay down a v2 project shell with a real (silent) source video.

    `source_duration_marker` is approximate — `_probe_duration` shells
    out to ffprobe which we don't have in test env, so it returns None.
    The doctor still functions; we just can't exercise the
    "source-too-short" path in unit tests reliably. That path is
    integration-tested by the manual run on the user's project.
    """
    (d / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    (d / "videos").mkdir()
    (d / "sources").mkdir()
    # A 1-byte stub source. Doctor checks existence, ffprobe-duration
    # gracefully falls back to None when probe fails.
    (d / "sources" / "main.mp4").write_bytes(b"x")


def _conforming_segment(seg_id: str, start: float, end: float, target: float) -> dict:
    return {
        "id": seg_id,
        "source": "sources/main.mp4",
        "source_start": start,
        "source_end": end,
        "target_duration": target,
        "kind": "recording",
        "scene_type": None,
        "label": seg_id,
        "chapter": "",
        "voiceover": {"enabled": True, "script_clip_id": f"clip_{seg_id}"},
        "captions": {"enabled": True, "ref": f"captions/index.json#{seg_id}"},
        "camera": {"enabled": False, "ref": ""},
        "annotations": {"enabled": False, "ref": ""},
    }


def test_doctor_flags_missing_voiceover_and_render(tmp_path: Path) -> None:
    _seed_project(tmp_path)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "",
        "segments": [_conforming_segment("seg_001", 0.0, 5.0, 5.0)],
    }))
    report = diagnose_video(tmp_path, "main")
    assert not report.ok
    seg = report.segments[0]
    assert any("voiceover enabled" in i for i in seg.issues)
    assert any("missing per-segment render" in i for i in seg.issues)


def test_doctor_flags_empty_source_range(tmp_path: Path) -> None:
    _seed_project(tmp_path)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "",
        "segments": [_conforming_segment("seg_001", 0.0, 0.0, 5.0)],
    }))
    report = diagnose_video(tmp_path, "main")
    seg = report.segments[0]
    assert any("source range is empty" in i for i in seg.issues)


def test_doctor_detects_invented_schema(tmp_path: Path) -> None:
    """The killer diagnostic — Claude wrote a non-v2 manifest shape.

    `panels` is now a legal v2 field (sequential crossfade cycle), so
    a foreign-shape probe uses other made-up keys: `beat`, `theme`,
    `transitions`.
    """
    _seed_project(tmp_path)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "",
        "segments": [{
            "id": "seg_001",
            "kind": "recording",
            "label": "Opening Hook",
            "beat": "opening",                  # foreign
            "target_duration": 10.0,
            "transitions": [{"type": "wipe"}],  # foreign
            "voiceover": {"enabled": True},
            "captions": {"enabled": True},
            "theme": "dark-fantasy",            # foreign
        }],
    }))
    report = diagnose_video(tmp_path, "main")
    assert any(
        "unknown segment fields" in i
        and "beat" in i
        and "theme" in i
        and "transitions" in i
        for i in report.issues
    )


def test_doctor_accepts_legal_panels_field(tmp_path: Path) -> None:
    """`panels` is a legal v2 field — must not get flagged as invented."""
    _seed_project(tmp_path)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "",
        "segments": [{
            "id": "seg_001",
            "kind": "scene", "scene_type": "panel",
            "source": "sources/panels/p1.webp",
            "source_start": 0.0, "source_end": 6.0, "target_duration": 6.0,
            "label": "Setup", "chapter": "setup",
            "panels": [
                {"source": "sources/panels/p1.webp", "duration_seconds": 2.0},
                {"source": "sources/panels/p2.webp"},
                {"source": "sources/panels/p3.webp"},
            ],
            "voiceover": {"enabled": True, "script_clip_id": "vo_001"},
            "captions": {"enabled": True, "ref": "captions/index.json#seg_001"},
            "camera": {"enabled": False, "ref": ""},
            "annotations": {"enabled": False, "ref": ""},
        }],
    }))
    report = diagnose_video(tmp_path, "main")
    assert not any("unknown segment fields" in i for i in report.issues), (
        f"panels field flagged as foreign: {report.issues}"
    )


def test_doctor_happy_path_no_issues(tmp_path: Path) -> None:
    _seed_project(tmp_path)
    seg = _conforming_segment("seg_001", 0.0, 5.0, 5.0)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "",
        "segments": [seg],
    }))
    # Lay down every artifact the doctor expects.
    audio = tmp_path / "voiceover" / "audio" / "main"
    audio.mkdir(parents=True)
    (audio / "seg_001.mp3").write_bytes(b"x")
    (audio / "seg_001.timestamps.json").write_text("{}")
    captions = tmp_path / "captions" / "main" / "seg_001"
    captions.mkdir(parents=True)
    (captions / "000.png").write_bytes(b"x")
    seg_renders = tmp_path / "out" / "segments" / "main"
    seg_renders.mkdir(parents=True)
    (seg_renders / "seg_001.mp4").write_bytes(b"x")
    (tmp_path / "out" / "final").mkdir(parents=True)
    (tmp_path / "out" / "final" / "main.mp4").write_bytes(b"x")
    # Script with the matching clip.
    scripts = tmp_path / "voiceover" / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "main.json").write_text(json.dumps({
        "clips": [{"id": "clip_seg_001", "text": "hi"}],
    }))
    # Final must be newer than seg renders to not be "stale".
    import os
    import time
    final_path = tmp_path / "out" / "final" / "main.mp4"
    now = time.time()
    os.utime(final_path, (now, now))
    os.utime(seg_renders / "seg_001.mp4", (now - 5, now - 5))

    report = diagnose_video(tmp_path, "main")
    assert report.ok, f"issues: {report.issues}; segments: {[s.issues for s in report.segments]}"


def test_doctor_flags_unknown_video_id(tmp_path: Path) -> None:
    _seed_project(tmp_path)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "", "segments": [],
    }))
    with pytest.raises(ValueError, match="no video 'nope'"):
        diagnose_video(tmp_path, "nope")


def test_doctor_emits_json_via_cli(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from clipwright.cli import app

    _seed_project(tmp_path)
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "",
        "segments": [_conforming_segment("seg_001", 0.0, 5.0, 5.0)],
    }))
    result = CliRunner().invoke(
        app, ["video", "doctor", "main", "--project", str(tmp_path), "--json"],
    )
    assert result.exit_code == 0
    payload = json.loads(result.output)
    assert payload["video_id"] == "main"
    assert "segments" in payload and len(payload["segments"]) == 1
    assert payload["segments"][0]["seg_id"] == "seg_001"
