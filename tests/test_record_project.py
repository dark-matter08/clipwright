"""Tests for Record-mode project seeding.

`_seed_from_recording` is the pure-ish core: given a captured video + moments,
lay out the v1 schema files. We synthesize a fixture MP4 via ffmpeg lavfi and
exercise the seed helper directly. The Playwright orchestrator on top of it
is integration-only and not unit-tested here (it's gated on a real browser).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from clipwright.record_project import RecordError, _seed_from_recording, record_project
from clipwright.schema import load_project, load_timeline


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


pytestmark = pytest.mark.skipif(
    not _ffmpeg_available(), reason="ffmpeg not on PATH"
)


@pytest.fixture
def synth_video(tmp_path: Path) -> Path:
    """A 20-second test clip with a steady tone (real audio = real duration)."""
    src = tmp_path / "raw" / "recording.mp4"
    src.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=teal:s=540x960:d=20:r=30",
            "-f", "lavfi", "-i", "sine=f=220:d=20",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            str(src),
        ],
        check=True,
        capture_output=True,
    )
    return src


def _moments_three_chapters() -> list[dict]:
    """Synthetic moments with three chapters and timing spread across ~18s."""
    return [
        # chapter "intro" — 2 actions
        {"t": 1.0, "action": "navigate", "label": "Open the app", "chapter": "intro",
         "fields": {"url": "/"}, "wait": 2.5},
        {"t": 3.5, "action": "scroll", "label": "Glance the hero", "chapter": "intro",
         "fields": {"by_y": 400}, "wait": 2.0},
        # chapter "library" — 3 actions
        {"t": 6.5, "action": "click", "label": "Open library", "chapter": "library",
         "fields": {"selector": "a.library"}, "wait": 2.0},
        {"t": 8.5, "action": "type", "label": "Search a title", "chapter": "library",
         "fields": {"selector": "input", "text": "Blue Lock"}, "wait": 2.0},
        {"t": 11.5, "action": "click", "label": "Add to library", "chapter": "library",
         "fields": {"selector": "button.add"}, "wait": 2.0},
        # chapter "reader" — 1 action
        {"t": 15.0, "action": "click", "label": "Open the reader", "chapter": "reader",
         "fields": {"selector": ".chapter"}, "wait": 2.5},
    ]


# ---------------------------------------------------------------------------
# _seed_from_recording — the testable core
# ---------------------------------------------------------------------------


def test_seed_produces_one_segment_per_chapter(tmp_path: Path, synth_video: Path) -> None:
    project_dir = tmp_path / "proj"
    moments = _moments_three_chapters()

    result = _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=moments,
        title="Three Chapter Demo",
        aspect="9:16",
    )

    assert result.n_segments == 3
    timeline = load_timeline(project_dir)
    chapters = [s.chapter for s in timeline.segments]
    assert chapters == ["intro", "library", "reader"]


def test_seed_writes_v1_files_with_correct_layout(
    tmp_path: Path, synth_video: Path
) -> None:
    project_dir = tmp_path / "proj"
    _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=_moments_three_chapters(),
        title="Layout Test",
    )

    # required files exist exactly where SRS §5.1 says
    assert (project_dir / "project.json").exists()
    assert (project_dir / "timeline.json").exists()
    assert (project_dir / "moments.json").exists()
    assert (project_dir / "sources" / "main.mp4").exists()

    # project.json round-trips and uses defaults
    project = load_project(project_dir)
    assert project.title == "Layout Test"
    assert project.aspect == "9:16"
    assert project.render_backend == "remotion"
    assert project.tts_provider == "kokoro"


def test_seed_segments_reference_correct_paths(
    tmp_path: Path, synth_video: Path
) -> None:
    project_dir = tmp_path / "proj"
    _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=_moments_three_chapters(),
    )
    timeline = load_timeline(project_dir)

    for s in timeline.segments:
        assert s.source == "sources/main.mp4"
        assert s.kind == "recording"
        # all refs point at sid-scoped JSON fragments
        assert s.captions.ref.endswith(f"#{s.id}")
        assert s.camera.ref.endswith(f"#{s.id}")
        assert s.annotations.ref.endswith(f"#{s.id}")


def test_seed_segment_ids_are_sequential_and_unique(
    tmp_path: Path, synth_video: Path
) -> None:
    project_dir = tmp_path / "proj"
    _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=_moments_three_chapters(),
    )
    timeline = load_timeline(project_dir)
    ids = [s.id for s in timeline.segments]
    assert ids == ["seg_001", "seg_002", "seg_003"]


def test_seed_labels_use_first_moment_or_fallback(
    tmp_path: Path, synth_video: Path
) -> None:
    project_dir = tmp_path / "proj"
    _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=_moments_three_chapters(),
    )
    timeline = load_timeline(project_dir)
    # first moment of each chapter
    labels = [s.label for s in timeline.segments]
    assert labels == ["Open the app", "Open library", "Open the reader"]


def test_seed_preserves_existing_project_json(
    tmp_path: Path, synth_video: Path
) -> None:
    """Re-record over an existing project keeps user-chosen settings."""
    project_dir = tmp_path / "proj"
    # first run
    _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=_moments_three_chapters(),
        title="Original",
        aspect="9:16",
    )
    # user manually tweaked the project: pick a different TTS provider + voice
    project = load_project(project_dir)
    project.tts_provider = "elevenlabs"
    project.voice_id = "rachel"
    from clipwright.schema import save_project as save_p
    save_p(project_dir, project)

    # second run (re-record): should preserve user settings, refresh nothing
    # unless explicitly passed
    _seed_from_recording(
        project_dir,
        source_video=synth_video,
        moments=_moments_three_chapters(),
    )
    refreshed = load_project(project_dir)
    assert refreshed.tts_provider == "elevenlabs"
    assert refreshed.voice_id == "rachel"
    assert refreshed.title == "Original"


def test_seed_persists_moments_json(tmp_path: Path, synth_video: Path) -> None:
    project_dir = tmp_path / "proj"
    moments = _moments_three_chapters()
    _seed_from_recording(project_dir, source_video=synth_video, moments=moments)

    on_disk = json.loads((project_dir / "moments.json").read_text())
    assert on_disk == moments


def test_seed_copies_source_into_project(
    tmp_path: Path, synth_video: Path
) -> None:
    project_dir = tmp_path / "proj"
    _seed_from_recording(project_dir, source_video=synth_video, moments=[])

    dst = project_dir / "sources" / "main.mp4"
    assert dst.exists()
    assert not dst.is_symlink()
    assert dst.stat().st_size == synth_video.stat().st_size


def test_seed_with_empty_moments_produces_single_segment(
    tmp_path: Path, synth_video: Path
) -> None:
    """A recording with no marks falls back to a single full-source segment."""
    project_dir = tmp_path / "proj"
    result = _seed_from_recording(
        project_dir, source_video=synth_video, moments=[],
    )
    assert result.n_segments == 1
    timeline = load_timeline(project_dir)
    assert timeline.segments[0].source_start == 0.0
    assert timeline.segments[0].source_end == pytest.approx(20.0, abs=0.2)


# ---------------------------------------------------------------------------
# record_project (orchestrator) — error paths only; happy path requires Playwright
# ---------------------------------------------------------------------------


def test_record_project_missing_plan_raises_with_fix_hint(tmp_path: Path) -> None:
    project_dir = tmp_path / "proj"
    with pytest.raises(RecordError) as exc:
        record_project(project_dir)
    assert "no browse-plan.json" in str(exc.value)
    assert "Create" in exc.value.fix


def test_record_project_bad_plan_path_raises(tmp_path: Path) -> None:
    project_dir = tmp_path / "proj"
    with pytest.raises(RecordError) as exc:
        record_project(project_dir, plan_path=tmp_path / "missing.json")
    assert "not found" in str(exc.value)
