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
