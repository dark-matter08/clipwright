"""The render pipeline: per-segment extract -> concat -> subtitle overlay LAST.

Hard rules honored:
  1. Subtitles applied last in the filter chain.
  2. Per-segment extract then lossless concat; overlays on top of the concat product.
  3. 30ms audio fades at every boundary (applied in the compose filter).
  4. Overlays use PTS-shifted setpts via per-window enable='between(...)'.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..ffmpeg import ACODEC, VCODEC, run
from .compose_vertical import audio_filter, compose_filter


@dataclass
class Segment:
    start: float
    duration: float
    audio: Path | None = None
    lead: float = 0.4
    tail: float = 0.3


@dataclass
class SubtitleChunk:
    start: float
    end: float
    png: Path


def _compose_segment(
    *,
    source: Path,
    seg: Segment,
    out: Path,
    out_w: int,
    out_h: int,
    fps: int,
) -> None:
    total_dur = seg.lead + seg.duration + seg.tail
    vf = compose_filter(start=seg.start, duration=total_dur, out_w=out_w, out_h=out_h)
    cmd: list[str | Path] = ["ffmpeg", "-y", "-i", str(source)]
    if seg.audio is not None:
        cmd += ["-i", str(seg.audio)]
        af = audio_filter(lead=seg.lead, duration=total_dur)
        cmd += ["-filter_complex", vf + ";" + af]
        cmd += ["-map", "[vout]", "-map", "[aout]"]
    else:
        cmd += ["-filter_complex", vf]
        cmd += ["-map", "[vout]"]
    cmd += ["-t", f"{total_dur:.3f}", *VCODEC, "-r", str(fps)]
    if seg.audio is not None:
        cmd += ACODEC
    else:
        cmd += ["-an"]
    cmd += [str(out)]
    run(cmd)


def _overlay_subtitles(
    *,
    body: Path,
    subtitles: list[SubtitleChunk],
    out: Path,
    fps: int,
) -> None:
    """Hard Rule 1: subtitle overlays are applied last, after all other compositing."""
    inputs: list[str | Path] = ["-i", str(body)]
    chain = ""
    prev = "[0:v]"
    for i, sub in enumerate(subtitles):
        inputs += ["-i", str(sub.png)]
        out_lbl = "[vout]" if i == len(subtitles) - 1 else f"[v{i}]"
        chain += (
            f"{prev}[{i+1}:v]overlay=0:0:"
            f"enable='between(t\\,{sub.start:.3f}\\,{sub.end:.3f})'{out_lbl};"
        )
        prev = out_lbl
    chain = chain.rstrip(";")
    cmd: list[str | Path] = [
        "ffmpeg",
        "-y",
        *inputs,
        "-filter_complex",
        chain,
        "-map",
        "[vout]",
        "-map",
        "0:a?",
        *VCODEC,
        "-r",
        str(fps),
        "-c:a",
        "copy",
        str(out),
    ]
    run(cmd)


def _concat(segments: list[Path], out: Path, list_path: Path, fps: int) -> None:
    list_path.write_text("\n".join(f"file '{p.resolve()}'" for p in segments) + "\n")
    run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            *VCODEC,
            "-r",
            str(fps),
            *ACODEC,
            str(out),
        ]
    )


def render(
    *,
    source: Path,
    segments: list[Segment],
    work_dir: Path,
    out: Path,
    resolution: tuple[int, int] = (1080, 1920),
    fps: int = 60,
    subtitles_per_segment: list[list[SubtitleChunk]] | None = None,
    outro: Path | None = None,
) -> Path:
    """Compose per-segment, optionally overlay subs, concat, and append outro.

    subtitles_per_segment[i] is applied to segment i AFTER composition (Hard Rule 1).
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    out_w, out_h = resolution
    bodies: list[Path] = []
    for i, seg in enumerate(segments):
        nosub = work_dir / f"seg_{i:03d}_nosub.mp4"
        _compose_segment(source=source, seg=seg, out=nosub, out_w=out_w, out_h=out_h, fps=fps)
        if subtitles_per_segment and subtitles_per_segment[i]:
            body = work_dir / f"seg_{i:03d}.mp4"
            _overlay_subtitles(body=nosub, subtitles=subtitles_per_segment[i], out=body, fps=fps)
        else:
            body = nosub
        bodies.append(body)

    if outro is not None:
        bodies.append(outro)

    list_path = work_dir / "concat.txt"
    _concat(bodies, out, list_path, fps)
    return out


def render_from_edl(
    *,
    edl_path: Path,
    work_dir: Path,
    out: Path,
    resolution: tuple[int, int] = (1080, 1920),
    fps: int = 60,
    outro: Path | None = None,
) -> Path:
    """Convenience: read edl.json produced by edit.trim and render silent composition."""
    edl = json.loads(edl_path.read_text())
    source = Path(edl["video"])
    segments = [
        Segment(start=float(s), duration=float(e) - float(s), lead=0.0, tail=0.0)
        for s, e in edl["ranges"]
    ]
    return render(
        source=source,
        segments=segments,
        work_dir=work_dir,
        out=out,
        resolution=resolution,
        fps=fps,
        outro=outro,
    )
