"""ffmpeg helpers. Thin wrappers, real errors."""
from __future__ import annotations

import json
import shlex
import shutil
import subprocess
from pathlib import Path

VCODEC = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]
ACODEC = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000"]


class FFmpegError(RuntimeError):
    pass


def require() -> None:
    for b in ("ffmpeg", "ffprobe"):
        if shutil.which(b) is None:
            raise FFmpegError(f"{b} not found on PATH")


def run(cmd: list[str | Path], *, echo: bool = True) -> None:
    s = [str(c) for c in cmd]
    if echo:
        printable = " ".join(shlex.quote(c) for c in s)
        print("$ " + (printable if len(printable) < 240 else printable[:237] + "..."))
    r = subprocess.run(s, capture_output=True, text=True)
    if r.returncode != 0:
        tail = r.stderr[-2000:] if r.stderr else "(no stderr)"
        raise FFmpegError(f"ffmpeg failed (exit {r.returncode}):\n{tail}")


def atempo_chain(ratio: float) -> str:
    """Build an ffmpeg filtergraph string stretching audio by `ratio`.

    ffmpeg's `atempo` accepts 0.5..2.0; chain multiple for wider ratios.
    ratio > 1 speeds up; ratio < 1 slows down. Pitch is preserved.
    """
    if ratio <= 0:
        raise ValueError(f"ratio must be positive, got {ratio}")
    parts: list[str] = []
    r = ratio
    while r > 2.0:
        parts.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        parts.append("atempo=0.5")
        r /= 0.5
    parts.append(f"atempo={r:.6f}")
    return ",".join(parts)


def stretch_audio(src: Path, dst: Path, target_seconds: float) -> float:
    """Re-encode `src` so its duration matches `target_seconds`. Returns ratio used."""
    cur = probe_duration(src)
    if cur <= 0 or target_seconds <= 0:
        raise ValueError(f"invalid durations: cur={cur}, target={target_seconds}")
    ratio = cur / target_seconds  # atempo ratio: >1 speeds up, shortens
    chain = atempo_chain(ratio)
    run([
        "ffmpeg", "-y", "-i", str(src),
        "-filter:a", chain,
        "-c:a", "libmp3lame", "-b:a", "160k",
        str(dst),
    ])
    return ratio


# Beyond about two semitones the resampling artifacts stop reading as
# "a different voice" and start reading as "a processed voice". Users
# reach for pitch expecting a personality knob, so we clamp rather than
# let them turn their narrator into a chipmunk and blame the renderer.
MAX_PITCH_SEMITONES = 6.0
_HONEST_PITCH_SEMITONES = 2.0


def change_speed(path: Path, factor: float) -> float:
    """Re-time `path` in place by `factor` (>1 faster). Returns the
    factor applied.

    For providers whose API has no speed control — ElevenLabs, Piper.
    Kokoro and OpenAI take a speed parameter natively, which sounds
    better than re-timing after the fact, so they don't come through
    here.
    """
    if abs(factor - 1.0) < 1e-3:
        return 1.0
    dst = path.with_suffix(".speed.mp3")
    run([
        "ffmpeg", "-y", "-i", str(path),
        "-filter:a", atempo_chain(factor),
        "-c:a", "libmp3lame", "-b:a", "160k",
        str(dst),
    ])
    dst.replace(path)
    return factor


def shift_pitch(path: Path, semitones: float) -> float:
    """Pitch-shift `path` in place, preserving duration. Returns the
    semitones actually applied (clamped).

    No TTS provider we support exposes pitch, so this is the only way to
    offer it. Method: resample to change pitch (which also changes
    speed), then `atempo` back to the original speed. `rubberband` would
    sound better but isn't in a stock ffmpeg build, and requiring a
    custom ffmpeg to move a slider is a bad trade.

    Duration is preserved deliberately — `tts_segment` time-stretches
    against a target afterwards, and a pitch shift that also changed
    length would fight that.
    """
    if abs(semitones) < 1e-3:
        return 0.0
    st = max(-MAX_PITCH_SEMITONES, min(MAX_PITCH_SEMITONES, float(semitones)))
    # Equal temperament: each semitone is a factor of 2^(1/12).
    factor = 2 ** (st / 12.0)

    rate = probe_sample_rate(path) or 44100
    dst = path.with_suffix(".pitched.mp3")
    # asetrate re-labels the sample rate: pitch scales by `factor` and
    # duration by 1/factor. aresample normalizes the rate back, then
    # atempo undoes the duration change — which needs 1/factor, NOT
    # factor. Passing factor here compounds the stretch instead of
    # cancelling it (a -4 semitone shift came out 1.57x long).
    chain = (
        f"asetrate={int(rate * factor)},"
        f"aresample={rate},"
        f"{atempo_chain(1.0 / factor)}"
    )
    run([
        "ffmpeg", "-y", "-i", str(path),
        "-filter:a", chain,
        "-c:a", "libmp3lame", "-b:a", "160k",
        str(dst),
    ])
    dst.replace(path)
    return st


def probe_sample_rate(path: Path) -> int:
    """Sample rate in Hz, or 0 when ffprobe can't tell us."""
    r = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate",
            "-of", "default=nw=1:nk=1",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    try:
        return int((r.stdout or "").strip())
    except (TypeError, ValueError):
        return 0


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise FFmpegError(f"ffprobe failed: {r.stderr[-400:]}")
    return float(json.loads(r.stdout)["format"]["duration"])
