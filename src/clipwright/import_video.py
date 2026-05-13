"""Import an arbitrary video file as a clipwright project (Upload mode).

This module implements SRS F-UPL-1, F-UPL-2, F-UPL-3 (single source) and
F-IMP-SH-2: copy the user's video into `<project>/sources/main.mp4`, run
silence + scene detection, and emit a valid v1 `project.json` + `timeline.json`
seeded with auto-detected segments.

The module is split into three layers:

1. Pure functions (no ffmpeg, no filesystem) — `compute_cuts`, `_filter_cuts`,
   `_fallback_time_cuts`. These have the bulk of the logic and the bulk of
   the tests.
2. ffmpeg probes — `detect_silences`, `detect_scenes`. Subprocess-only,
   thin wrappers that parse stderr/stdout.
3. Orchestration — `import_video` ties it together: probe duration, run
   detectors, compute cuts, write files.

The CLI surface (`clipwright import <video>`) lives in `cli.py` and delegates
here.
"""
from __future__ import annotations

import datetime
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg import FFmpegError, probe_duration, require
from .schema import (
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Video,
    save_project,
    save_video,
)
from .schema.v1.timeline import next_segment_id

# Tunable thresholds. These are the auto-segmentation defaults; the goal is
# 4-12 segments for a typical 1-10 minute source. Tuned conservatively: better
# to under-segment (user splits manually) than to over-segment (jittery feel).

MIN_SILENCE_DURATION_S = 0.6   # ignore quieter-than-noise blips below this
SILENCE_NOISE_DB = -30          # ffmpeg silencedetect noise threshold
MIN_SEGMENT_DURATION_S = 3.0    # never produce sub-3s auto-segments
TARGET_SEGMENTS_PER_MIN = 2.0   # ~30s avg; falls within 4-12 for 2-6 min clips
MIN_SEGMENTS = 1
MAX_SEGMENTS = 12
SCENE_THRESHOLD = 0.40          # ffmpeg `select='gt(scene,X)'` sensitivity


# ---------------------------------------------------------------------------
# Pure logic (no ffmpeg, no IO) — heavily tested
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Silence:
    """A detected silent range, half-open: [start, end)."""

    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def midpoint(self) -> float:
        return (self.start + self.end) / 2.0


def compute_cuts(
    duration: float,
    silences: list[Silence],
    scenes: list[float],
    *,
    min_segment_duration: float = MIN_SEGMENT_DURATION_S,
    target_segments_per_min: float = TARGET_SEGMENTS_PER_MIN,
    min_segments: int = MIN_SEGMENTS,
    max_segments: int = MAX_SEGMENTS,
) -> list[tuple[float, float]]:
    """Pick segment cut points from detected silences + scene changes.

    Returns a list of `(start, end)` ranges in seconds that tile [0, duration]
    with no gaps and no overlaps.

    Algorithm:
        1. Score candidate cut points: silence midpoints scored by silence
           duration; scene timestamps scored by a constant lower than the
           weakest typical silence.
        2. Sort by score descending.
        3. Greedily accept cuts that are at least `min_segment_duration`
           away from any already-accepted cut and from the edges.
        4. Cap at `target_segments` (computed from duration); cap at
           `max_segments`.
        5. If we end up below `min_segments` and the source is long
           enough, fall back to evenly-spaced time cuts.
    """
    if duration <= 0:
        return []
    if duration < min_segment_duration:
        return [(0.0, duration)]

    target_segments = max(
        min_segments,
        min(max_segments, int(round((duration / 60.0) * target_segments_per_min))),
    )
    target_cuts = target_segments - 1

    # Score cuts. Silences score = duration (longer = stronger). Scene
    # changes score = a small constant so they only contribute when silences
    # are sparse.
    scored: list[tuple[float, float]] = []  # (cut_time, score)
    for s in silences:
        if s.duration < MIN_SILENCE_DURATION_S:
            continue
        if 0 < s.midpoint < duration:
            scored.append((s.midpoint, s.duration))
    for sc in scenes:
        if 0 < sc < duration:
            scored.append((sc, MIN_SILENCE_DURATION_S * 0.5))

    accepted: list[float] = _filter_cuts(
        scored, duration, target_cuts, min_segment_duration
    )

    # If detection produced nothing usable, fall back to evenly-spaced cuts so
    # long sources still get auto-segmented (5-minute silent screen recording
    # shouldn't be one giant block).
    if not accepted and target_cuts > 0:
        accepted = _fallback_time_cuts(duration, target_cuts, min_segment_duration)

    accepted = sorted(set(accepted))
    cuts = [0.0, *accepted, duration]
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]


def _filter_cuts(
    scored: list[tuple[float, float]],
    duration: float,
    target_cuts: int,
    min_gap: float,
) -> list[float]:
    """Greedy: pick highest-scored cuts that respect the min-gap constraint."""
    if target_cuts <= 0:
        return []
    scored = sorted(scored, key=lambda x: x[1], reverse=True)
    accepted: list[float] = []
    for t, _score in scored:
        if len(accepted) >= target_cuts:
            break
        if t < min_gap or (duration - t) < min_gap:
            continue
        if any(abs(t - a) < min_gap for a in accepted):
            continue
        accepted.append(t)
    return accepted


def _fallback_time_cuts(
    duration: float, target_cuts: int, min_gap: float
) -> list[float]:
    """When silence/scene signals are weak, cut at evenly-spaced times."""
    if target_cuts <= 0 or duration < 2 * min_gap:
        return []
    step = duration / (target_cuts + 1)
    if step < min_gap:
        # not enough room — produce as many cuts as fit
        n = max(0, int(duration // min_gap) - 1)
        if n == 0:
            return []
        step = duration / (n + 1)
        target_cuts = n
    return [step * (i + 1) for i in range(target_cuts)]


# ---------------------------------------------------------------------------
# ffmpeg probes (subprocess, thin) — minimal tests; logic-light
# ---------------------------------------------------------------------------

_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+\.?\d*)")
_SILENCE_END_RE = re.compile(
    r"silence_end:\s*(-?\d+\.?\d*)\s*\|\s*silence_duration:\s*(\d+\.?\d*)"
)
_SHOWINFO_PTS_RE = re.compile(r"pts_time:(\d+\.?\d*)")


def detect_silences(
    path: Path,
    *,
    noise_db: int = SILENCE_NOISE_DB,
    min_duration: float = MIN_SILENCE_DURATION_S,
) -> list[Silence]:
    """Run ffmpeg `silencedetect` and parse the stderr output.

    Returns silences in chronological order. Tolerates an unterminated final
    silence (the file ends mid-silence) by clamping to file duration.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", f"silencedetect=noise={noise_db}dB:d={min_duration}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(f"silencedetect failed: {proc.stderr[-400:]}")
    stderr = proc.stderr or ""

    starts: list[float] = []
    pairs: list[tuple[float, float]] = []  # (end_time, duration)
    for line in stderr.splitlines():
        m = _SILENCE_START_RE.search(line)
        if m:
            starts.append(float(m.group(1)))
            continue
        m = _SILENCE_END_RE.search(line)
        if m:
            pairs.append((float(m.group(1)), float(m.group(2))))

    silences: list[Silence] = []
    for idx, (end_t, dur) in enumerate(pairs):
        start_t = end_t - dur if idx >= len(starts) else starts[idx]
        if end_t > start_t >= 0:
            silences.append(Silence(start=start_t, end=end_t))
    # unterminated trailing silence
    if len(starts) > len(pairs):
        try:
            total = probe_duration(path)
            silences.append(Silence(start=starts[len(pairs)], end=total))
        except FFmpegError:
            pass
    return silences


def detect_scenes(
    path: Path, *, threshold: float = SCENE_THRESHOLD
) -> list[float]:
    """Run ffmpeg scene-change detection and parse pts_time from showinfo.

    Returns scene-cut timestamps in seconds, chronological.
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-filter:v", f"select='gt(scene,{threshold:.2f})',showinfo",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        # scene detection failing should not block import; degrade gracefully
        return []
    stderr = proc.stderr or ""
    times: list[float] = []
    for line in stderr.splitlines():
        if "[Parsed_showinfo" not in line:
            continue
        m = _SHOWINFO_PTS_RE.search(line)
        if m:
            times.append(float(m.group(1)))
    return sorted(times)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


@dataclass
class ImportResult:
    """Outcome of `import_video`."""

    project_dir: Path
    project: Project
    video: Video
    source_path: Path  # destination path inside the project
    n_segments: int     # total segments in the video after this import


_SOURCE_NAME_SAFE = re.compile(r"[^a-zA-Z0-9_-]+")


def _unique_source_path(sources_dir: Path, stem: str, ext: str) -> Path:
    """Pick `sources/<stem>.<ext>` that doesn't collide with existing files.

    `stem` is lowercased and stripped of non-`[a-zA-Z0-9_-]` characters to
    keep filenames portable and shell-safe (the destination becomes a CLI
    arg downstream). Conflicts get a numeric suffix: `broll.mp4`,
    `broll-2.mp4`, `broll-3.mp4`, ...
    """
    safe = _SOURCE_NAME_SAFE.sub("-", stem).strip("-").lower() or "source"
    # Never overwrite "main" — it's the canonical first-import slot.
    if safe == "main":
        safe = "main-extra"
    candidate = sources_dir / f"{safe}.{ext}"
    if not candidate.exists():
        return candidate
    i = 2
    while True:
        candidate = sources_dir / f"{safe}-{i}.{ext}"
        if not candidate.exists():
            return candidate
        i += 1


def import_video(
    src: Path,
    project_dir: Path,
    *,
    title: str = "",
    aspect: str = "9:16",
    auto_segment: bool = True,
    use_scene_detection: bool = True,
    copy_source: bool = True,
    append: bool = False,
    video_id: str = "main",
    video_title: str = "",
) -> ImportResult:
    """Copy `src` into `project_dir/sources/<name>.mp4` and seed schema files.

    Args:
        src: path to the input MP4/MOV/WebM.
        project_dir: directory to create. Will be created if missing.
        title: project-level title. Defaults to the project dir name. Ignored
            on append against an existing project.
        aspect: "9:16", "16:9", or "1:1". Same caveat as ``title``.
        auto_segment: when False, produces a single segment spanning the full
            source (per F-UPL-2 opt-out).
        use_scene_detection: when False, only silence detection is used.
        copy_source: when False, write a relative symlink instead of copying.
        append: when True (SRS F-UPL-3 multi-source), add a new source video
            to an existing video's timeline. The destination filename is
            derived from the source stem with a uniqueness suffix; new
            segments append to ``videos/<video_id>.json`` with stable
            seg IDs (no renumbering).
        video_id: which video the new segments land in. Default "main" —
            the canonical first-video slot. Use a distinct id (e.g.
            "chapter-1-recap") to start a new video deliverable inside
            the project.
        video_title: human title for the video on first creation. Ignored
            if the video already exists.

    Returns the loaded models so callers can mutate further if needed.
    """
    src = Path(src).resolve()
    if not src.exists():
        raise FileNotFoundError(f"source video not found: {src}")
    require()  # ffmpeg + ffprobe must be on PATH

    project_dir = Path(project_dir).resolve()
    sources_dir = project_dir / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)

    # Pick the destination filename.
    #   - First import: always `sources/main.mp4`. Stable convention.
    #   - Append: derive from the source stem, with a numeric uniqueness
    #     suffix if needed. Never overwrites an existing file.
    if append:
        dst = _unique_source_path(sources_dir, src.stem, src.suffix.lstrip(".") or "mp4")
    else:
        dst = sources_dir / "main.mp4"
        if dst.exists():
            dst.unlink()

    if copy_source:
        shutil.copy2(src, dst)
    else:
        dst.symlink_to(src)

    duration = probe_duration(dst)
    if duration <= 0:
        raise FFmpegError(f"could not determine duration of {dst}")

    silences: list[Silence] = []
    scenes: list[float] = []
    if auto_segment:
        silences = detect_silences(dst)
        if use_scene_detection:
            scenes = detect_scenes(dst)
        cuts = compute_cuts(duration, silences, scenes)
    else:
        cuts = [(0.0, duration)]

    # Project manifest: load existing on append; create fresh otherwise.
    if append and (project_dir / "project.json").exists():
        from .schema import load_project
        project = load_project(project_dir)
    else:
        project = Project(
            title=title or project_dir.name,
            aspect=aspect,
            fps=30,
            render_backend="remotion",
            tts_provider="kokoro",
            voice_id="",
            base_url="",
            created_at=datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        )

    # Video manifest: load existing or create a new one. Two paths into
    # the existing-video branch: (a) append=True with the video already
    # on disk, or (b) the v2 layout has `videos/<id>.json` from a prior
    # import to this same video_id.
    from .schema import load_video
    from .schema import paths as schema_paths
    video_path = schema_paths.video_manifest_path(project_dir, video_id)
    if video_path.exists():
        video = load_video(project_dir, video_id)
    else:
        video = Video(
            video_id=video_id,
            title=video_title or video_id,
            segments=[],
        )

    rel_source = dst.relative_to(project_dir).as_posix()
    new_count = 0
    for start, end in cuts:
        sid = next_segment_id([s.id for s in video.segments])
        seg = Segment(
            id=sid,
            source=rel_source,
            source_start=start,
            source_end=end,
            target_duration=end - start,
            kind="recording",
            label="",
            chapter="",
            voiceover=SegmentVoiceover(enabled=False, script_clip_id=""),
            captions=SegmentRef(enabled=True, ref=f"captions/index.json#{sid}"),
            camera=SegmentRef(enabled=False, ref=""),
            annotations=SegmentRef(enabled=False, ref=""),
        )
        video.segments.append(seg)
        new_count += 1

    save_project(project_dir, project)
    save_video(project_dir, video)

    return ImportResult(
        project_dir=project_dir,
        project=project,
        video=video,
        source_path=dst,
        n_segments=len(video.segments),
    )
