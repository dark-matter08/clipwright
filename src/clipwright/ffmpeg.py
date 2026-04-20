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
