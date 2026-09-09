"""ffmpeg-side voice controls: pitch shift and speed change.

Pitch and speed are ours rather than any provider's, so these are the
only place their correctness is checked. Both run real ffmpeg against a
generated tone — fast, and it's the actual filter chain that matters.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from clipwright.ffmpeg import change_speed, shift_pitch


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


pytestmark = pytest.mark.skipif(not _ffmpeg_available(), reason="needs ffmpeg")


def _tone(path: Path, seconds: float = 3.0) -> Path:
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}",
         "-c:a", "libmp3lame", "-b:a", "160k", str(path)],
        check=True, capture_output=True,
    )
    return path


def _dur(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


@pytest.mark.parametrize("semitones", [-4, -2, 2, 4])
def test_pitch_shift_preserves_duration(tmp_path: Path, semitones: int) -> None:
    """The whole point of the asetrate→aresample→atempo chain.

    The first implementation passed `factor` to atempo instead of
    `1/factor`, which compounds the stretch rather than cancelling it —
    a -4 semitone shift came out 1.57x long. Nothing caught it, because
    the only check compared two separate syntheses of a
    non-deterministic model, whose durations differ anyway.
    """
    src = _tone(tmp_path / "t.mp3")
    before = _dur(src)
    shift_pitch(src, semitones)
    after = _dur(src)
    assert abs(after - before) < 0.06, (
        f"{semitones:+d}st changed duration {before:.3f}s -> {after:.3f}s"
    )


def test_pitch_shift_actually_changes_pitch(tmp_path: Path) -> None:
    """Duration-preserving is necessary but not sufficient — a no-op
    would also pass the test above."""
    src = _tone(tmp_path / "t.mp3")
    original = src.read_bytes()
    shift_pitch(src, 4)
    assert src.read_bytes() != original


def test_pitch_is_clamped(tmp_path: Path) -> None:
    """Past a point this stops sounding like a voice at all."""
    src = _tone(tmp_path / "t.mp3")
    assert shift_pitch(src, 99) == 6.0
    assert shift_pitch(src, -99) == -6.0


def test_zero_pitch_is_a_no_op(tmp_path: Path) -> None:
    src = _tone(tmp_path / "t.mp3")
    original = src.read_bytes()
    assert shift_pitch(src, 0.0) == 0.0
    assert src.read_bytes() == original, "no re-encode when there's nothing to do"


@pytest.mark.parametrize("factor,expected", [(1.5, 2.0), (0.75, 4.0)])
def test_change_speed_retimes(tmp_path: Path, factor: float, expected: float) -> None:
    """3s at 1.5x is 2s; at 0.75x it's 4s."""
    src = _tone(tmp_path / "t.mp3", seconds=3.0)
    change_speed(src, factor)
    assert abs(_dur(src) - expected) < 0.12


def test_change_speed_is_a_no_op_at_one(tmp_path: Path) -> None:
    src = _tone(tmp_path / "t.mp3")
    original = src.read_bytes()
    assert change_speed(src, 1.0) == 1.0
    assert src.read_bytes() == original
