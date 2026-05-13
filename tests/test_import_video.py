"""Tests for `clipwright import` (Upload mode).

The pure-logic layer (compute_cuts + helpers) is exhaustively tested without
ffmpeg. The end-to-end orchestration is exercised by a single test that
generates a tiny synthetic MP4 via ffmpeg lavfi — skipped automatically if
ffmpeg is not available.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from clipwright.import_video import (
    MIN_SEGMENT_DURATION_S,
    Silence,
    _fallback_time_cuts,
    _filter_cuts,
    compute_cuts,
)
from clipwright.schema import load_project, load_timeline

# ---------------------------------------------------------------------------
# compute_cuts — the core algorithm
# ---------------------------------------------------------------------------


def test_compute_cuts_zero_duration() -> None:
    assert compute_cuts(0.0, [], []) == []


def test_compute_cuts_short_clip_returns_single_segment() -> None:
    # below min_segment_duration -> can't be cut
    result = compute_cuts(2.0, [], [])
    assert result == [(0.0, 2.0)]


def test_compute_cuts_no_signals_uses_time_fallback_for_long_clips() -> None:
    # 5-minute clip with no silences/scenes should still get auto-cuts
    result = compute_cuts(300.0, [], [])
    assert len(result) >= 4, "5 min source should produce at least 4 segments"
    assert len(result) <= 12
    # tiles [0, 300] with no gaps
    assert result[0][0] == 0.0
    assert result[-1][1] == pytest.approx(300.0)
    for i in range(len(result) - 1):
        assert result[i][1] == result[i + 1][0]


def test_compute_cuts_uses_silence_midpoints() -> None:
    duration = 60.0
    silences = [
        Silence(10.0, 11.0),  # midpoint 10.5
        Silence(30.0, 31.5),  # midpoint 30.75 (stronger)
        Silence(50.0, 50.8),  # 0.8s — above min duration
    ]
    cuts = compute_cuts(duration, silences, [])
    # all silence midpoints should appear as cut edges (modulo greedy filter)
    edges = {c[0] for c in cuts} | {c[1] for c in cuts}
    assert 10.5 in edges or 30.75 in edges or 50.4 in edges


def test_compute_cuts_drops_silences_below_min_duration() -> None:
    duration = 60.0
    # all silences are too short to be cut points
    silences = [Silence(10.0, 10.3), Silence(30.0, 30.2), Silence(50.0, 50.1)]
    cuts = compute_cuts(duration, silences, [])
    # falls back to time-based cuts
    assert len(cuts) >= 1
    for s, e in cuts:
        # no segment shorter than the minimum
        assert e - s >= MIN_SEGMENT_DURATION_S * 0.99


def test_compute_cuts_respects_min_segment_duration() -> None:
    # silences very close together; greedy filter should reject the closer one
    duration = 30.0
    silences = [
        Silence(5.0, 5.8),   # midpoint 5.4
        Silence(5.5, 6.5),   # midpoint 6.0 — within 3s of 5.4
        Silence(20.0, 21.0), # midpoint 20.5 — well-spaced
    ]
    cuts = compute_cuts(duration, silences, [])
    for s, e in cuts:
        assert e - s >= MIN_SEGMENT_DURATION_S - 0.01, f"segment {s}-{e} too short"


def test_compute_cuts_caps_at_max_segments() -> None:
    duration = 600.0  # 10 min
    # many strong silences
    silences = [Silence(t, t + 1.0) for t in range(20, int(duration) - 20, 20)]
    cuts = compute_cuts(duration, silences, [], max_segments=12)
    assert len(cuts) <= 12


def test_compute_cuts_tiles_without_gaps_or_overlaps() -> None:
    duration = 120.0
    silences = [Silence(20.0, 21.0), Silence(50.0, 51.5), Silence(80.0, 80.7)]
    scenes = [40.0, 70.0]
    cuts = compute_cuts(duration, silences, scenes)
    assert cuts[0][0] == 0.0
    assert cuts[-1][1] == pytest.approx(duration)
    for i in range(len(cuts) - 1):
        assert cuts[i][1] == cuts[i + 1][0], f"gap/overlap between {cuts[i]} and {cuts[i+1]}"


def test_compute_cuts_scenes_only_used_when_silences_sparse() -> None:
    duration = 90.0
    strong_silences = [Silence(30.0, 32.0), Silence(60.0, 62.0)]
    # scene cuts at competing times; silences should win on score
    scenes = [25.0, 55.0, 85.0]
    cuts = compute_cuts(duration, strong_silences, scenes)
    # the two strong silence midpoints should drive the result
    edges = {round(c[0], 1) for c in cuts} | {round(c[1], 1) for c in cuts}
    assert 31.0 in edges or 61.0 in edges


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_filter_cuts_target_zero() -> None:
    assert _filter_cuts([(5.0, 1.0), (10.0, 2.0)], 30.0, 0, 3.0) == []


def test_filter_cuts_picks_highest_scored_first() -> None:
    scored = [(5.0, 0.5), (15.0, 2.0), (25.0, 1.0)]
    out = _filter_cuts(scored, 30.0, 3, 3.0)
    # Highest-score first means 15.0 picked first, then 25.0 (next-highest),
    # then 5.0 (lowest). All respect 3s spacing.
    assert out[0] == 15.0
    assert sorted(out) == [5.0, 15.0, 25.0]


def test_filter_cuts_rejects_close_to_edge() -> None:
    # cut at 1.0 is within 3s of start
    out = _filter_cuts([(1.0, 10.0), (15.0, 1.0)], 30.0, 5, 3.0)
    assert 1.0 not in out


def test_fallback_time_cuts_even_spacing() -> None:
    cuts = _fallback_time_cuts(60.0, 3, 3.0)
    assert cuts == [15.0, 30.0, 45.0]


def test_fallback_time_cuts_zero_target() -> None:
    assert _fallback_time_cuts(60.0, 0, 3.0) == []


def test_fallback_time_cuts_respects_min_gap() -> None:
    # 6s clip, 5 cuts requested with 3s min gap — should produce fewer
    cuts = _fallback_time_cuts(6.0, 5, 3.0)
    # 6 / 3 - 1 = 1 cut max
    assert len(cuts) <= 1


# ---------------------------------------------------------------------------
# End-to-end: synthesize a tiny MP4 with ffmpeg, then import it
# ---------------------------------------------------------------------------


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_import_video_end_to_end(tmp_path: Path) -> None:
    import subprocess

    from clipwright.import_video import import_video

    # generate a 6-second test clip: solid color + silent audio
    src = tmp_path / "test.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=6:r=30",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=6",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            str(src),
        ],
        check=True,
        capture_output=True,
    )

    project_dir = tmp_path / "out-project"
    result = import_video(
        src, project_dir,
        title="Test Project",
        # synthesizing scenes from a single-color clip is unreliable across
        # ffmpeg versions — skip scene detection in CI
        use_scene_detection=False,
    )

    # source file was copied into place
    assert (project_dir / "sources" / "main.mp4").exists()

    # project + timeline written and re-loadable
    project = load_project(project_dir)
    timeline = load_timeline(project_dir)
    assert project.title == "Test Project"
    assert project.aspect == "9:16"
    assert len(timeline.segments) >= 1
    assert timeline.segments[0].source == "sources/main.mp4"
    # tiles 0..duration with no gaps
    total = sum(s.source_duration for s in timeline.segments)
    assert total == pytest.approx(6.0, abs=0.1)
    # all-silent clip → segments may merge into one; that's correct behavior
    assert result.n_segments == len(timeline.segments)


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_import_video_no_auto_segment(tmp_path: Path) -> None:
    import subprocess

    from clipwright.import_video import import_video

    src = tmp_path / "test.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=red:s=320x180:d=4:r=30",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo:d=4",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            str(src),
        ],
        check=True,
        capture_output=True,
    )

    result = import_video(
        src, tmp_path / "proj", auto_segment=False,
    )
    assert result.n_segments == 1
    assert result.timeline.segments[0].source_start == 0.0
    assert result.timeline.segments[0].source_end == pytest.approx(4.0, abs=0.1)


def test_import_video_missing_source_raises(tmp_path: Path) -> None:
    from clipwright.import_video import import_video

    with pytest.raises(FileNotFoundError, match="source video not found"):
        import_video(tmp_path / "nope.mp4", tmp_path / "proj")
