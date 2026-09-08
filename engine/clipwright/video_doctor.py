"""Audit a video's pipeline completeness without spending a render budget.

The frustration that motivated this module: Claude hits a 600s wall-
clock timeout trying to drive `render-segment` against a source video
that's far too short for the script's target duration. Nothing about
the failure surfaces clearly — the user sees "claude timed out — killed"
with no breadcrumb back to "source is 7.8s, you wanted 58s of footage."

`video_doctor` walks the per-segment artifact tree for one video and
reports, for each segment:

  - source range coherence (start < end, both inside the source file)
  - voiceover audio rendered (mp3 + timestamps + cache sidecar)
  - captions PNGs rendered (at least one frame)
  - per-segment mp4 cached in `out/segments/<id>/<seg>.mp4`

…plus project-level checks:

  - the source file referenced by the segments actually exists, and
    its duration is enough to honor all source ranges
  - the script.json has a clip for every segment that says
    `voiceover.enabled`
  - the final mp4 in `out/final/<id>.mp4` is fresher than the newest
    per-segment mp4 (otherwise it's stale and re-render is warranted)

The output is structured (a `DoctorReport` dataclass) so the CLI can
pretty-print it AND a future "Adopt + finish" desktop button can read
the same JSON.

This is purely diagnostic — no files are touched.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .schema import list_videos, load_video, paths


@dataclass
class SegmentCheck:
    seg_id: str
    target_duration: float
    source_range: tuple[float, float]
    issues: list[str] = field(default_factory=list)
    has_voiceover_mp3: bool = False
    has_voiceover_timestamps: bool = False
    has_captions: bool = False
    captions_frame_count: int = 0
    has_segment_render: bool = False

    @property
    def ok(self) -> bool:
        return not self.issues


@dataclass
class DoctorReport:
    video_id: str
    project_dir: Path
    source_path: str
    source_exists: bool
    source_duration: float | None  # None if ffprobe failed or source missing
    segments: list[SegmentCheck] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    """Project-level issues (not segment-scoped)."""
    has_final_render: bool = False
    final_is_stale: bool = False

    @property
    def ok(self) -> bool:
        return (
            not self.issues
            and all(s.ok for s in self.segments)
            and self.has_final_render
            and not self.final_is_stale
        )

    def to_dict(self) -> dict:
        return {
            "video_id": self.video_id,
            "project_dir": str(self.project_dir),
            "ok": self.ok,
            "source_path": self.source_path,
            "source_exists": self.source_exists,
            "source_duration": self.source_duration,
            "has_final_render": self.has_final_render,
            "final_is_stale": self.final_is_stale,
            "project_issues": list(self.issues),
            "segments": [
                {
                    "seg_id": s.seg_id,
                    "ok": s.ok,
                    "target_duration": s.target_duration,
                    "source_range": list(s.source_range),
                    "has_voiceover_mp3": s.has_voiceover_mp3,
                    "has_voiceover_timestamps": s.has_voiceover_timestamps,
                    "has_captions": s.has_captions,
                    "captions_frame_count": s.captions_frame_count,
                    "has_segment_render": s.has_segment_render,
                    "issues": list(s.issues),
                }
                for s in self.segments
            ],
        }


def diagnose_video(project_dir: Path, video_id: str) -> DoctorReport:
    project_dir = Path(project_dir).resolve()
    if video_id not in list_videos(project_dir):
        raise ValueError(
            f"no video {video_id!r} in project {project_dir} — try "
            f"`clipwright video list`"
        )

    video = load_video(project_dir, video_id)

    # Detect "invented schema" manifests — Claude has been observed
    # writing custom shapes like `panels: [{url, camera}]` instead of
    # the v2 `source` / `source_start` / `source_end`. The dataclass
    # loader silently drops unknown fields, so a syntactically-valid
    # but semantically-garbage manifest looks like a manifest with
    # all-blank segments. Catch this by comparing raw JSON keys to
    # the legal v2 segment keys.
    raw_manifest = json.loads(
        paths.video_manifest_path(project_dir, video_id).read_text()
    )
    legal_seg_keys = {
        "id", "source", "source_start", "source_end", "target_duration",
        "kind", "scene_type", "label", "chapter", "voiceover",
        "captions", "camera", "annotations",
        # Optional multi-image fields added in later schema work:
        #   `sources` — stacked comic-strip layout (N visible at once).
        #   `panels`  — sequential crossfade cycle (N played in order).
        # Both are legal v2 fields; the doctor must not flag them as
        # "unknown / invented" just because they're optional.
        "sources", "panels",
    }
    foreign_keys: set[str] = set()
    for raw_seg in raw_manifest.get("segments") or []:
        for key in raw_seg:
            if key not in legal_seg_keys:
                foreign_keys.add(key)

    # All segments should reference the same source file in a typical
    # single-recording video. If they don't, we still audit each one
    # against its declared source.
    source_path = video.segments[0].source if video.segments else ""
    source_duration = _probe_duration(project_dir / source_path) if source_path else None
    source_exists = bool(source_path) and (project_dir / source_path).exists()

    report = DoctorReport(
        video_id=video_id,
        project_dir=project_dir,
        source_path=source_path,
        source_exists=source_exists,
        source_duration=source_duration,
    )

    if not video.segments:
        report.issues.append(
            "video has zero segments — nothing to render. Re-author the "
            "manifest (split source into segments) or re-run "
            "`clipwright import` / `clipwright record-project`."
        )

    if foreign_keys:
        report.issues.append(
            f"manifest has unknown segment fields {sorted(foreign_keys)} that "
            "the v2 schema doesn't define — they were silently ignored, which "
            "is almost certainly why the timeline looks empty. Someone (often "
            "Claude) wrote a non-conforming manifest; restore it with "
            "`clipwright video adopt <id>` or re-author by hand."
        )

    if source_path and not source_exists:
        report.issues.append(
            f"source file `{source_path}` doesn't exist on disk — "
            "the recording or import never finished."
        )

    # Script clip presence — needed for TTS regeneration.
    script_path = paths.video_script_path(project_dir, video_id)
    script_clips: dict[str, dict] = {}
    if script_path.exists():
        try:
            payload = json.loads(script_path.read_text())
            for c in payload.get("clips") or []:
                cid = str(c.get("id") or "")
                if cid:
                    script_clips[cid] = c
        except (json.JSONDecodeError, OSError):
            report.issues.append(
                f"can't parse script at {script_path} — malformed JSON"
            )

    audio_dir = paths.video_audio_dir(project_dir, video_id)
    render_dir = paths.video_render_dir(project_dir, video_id)
    captions_root = project_dir / "captions" / video_id

    for seg in video.segments:
        check = SegmentCheck(
            seg_id=seg.id,
            target_duration=seg.target_duration,
            source_range=(seg.source_start, seg.source_end),
        )

        # Source range coherence.
        if seg.source_end <= seg.source_start:
            check.issues.append(
                f"source range is empty ({seg.source_start:.2f}–{seg.source_end:.2f}); "
                "render-segment will produce nothing"
            )
        if (
            source_duration is not None
            and seg.source_end > source_duration + 0.05  # small tolerance
        ):
            check.issues.append(
                f"source range ends at {seg.source_end:.2f}s but the source "
                f"is only {source_duration:.2f}s long — recording is too "
                "short for this segment"
            )

        # Voiceover audio.
        mp3 = audio_dir / f"{seg.id}.mp3"
        ts = audio_dir / f"{seg.id}.timestamps.json"
        check.has_voiceover_mp3 = mp3.exists()
        check.has_voiceover_timestamps = ts.exists()
        if seg.voiceover.enabled:
            if not check.has_voiceover_mp3:
                check.issues.append(
                    f"voiceover enabled but {mp3.relative_to(project_dir)} missing — "
                    "run `clipwright tts-segment`"
                )
            elif seg.voiceover.script_clip_id and seg.voiceover.script_clip_id not in script_clips:
                check.issues.append(
                    f"voiceover.script_clip_id={seg.voiceover.script_clip_id!r} "
                    "doesn't match any clip in the script — TTS may be stale"
                )

        # Captions.
        seg_caption_dir = captions_root / seg.id
        if seg_caption_dir.exists() and seg_caption_dir.is_dir():
            frames = [
                p for p in seg_caption_dir.iterdir()
                if p.suffix == ".png"
            ]
            check.captions_frame_count = len(frames)
            check.has_captions = len(frames) > 0
        if seg.captions.enabled and not check.has_captions:
            check.issues.append(
                "captions enabled but no PNG frames in "
                f"captions/{video_id}/{seg.id}/ — run `clipwright caption-segment`"
            )

        # Per-segment render.
        mp4 = render_dir / f"{seg.id}.mp4"
        check.has_segment_render = mp4.exists()
        if not check.has_segment_render:
            check.issues.append(
                f"missing per-segment render {mp4.relative_to(project_dir)} — "
                "run `clipwright render-segment`"
            )

        report.segments.append(check)

    # Final render + staleness.
    final = paths.video_final_path(project_dir, video_id)
    report.has_final_render = final.exists()
    if report.has_final_render:
        final_mtime = final.stat().st_mtime
        newest_seg = max(
            (
                (render_dir / f"{s.id}.mp4").stat().st_mtime
                for s in video.segments
                if (render_dir / f"{s.id}.mp4").exists()
            ),
            default=0.0,
        )
        if newest_seg > final_mtime + 1.0:  # 1s grace for fs granularity
            report.final_is_stale = True

    return report


def _probe_duration(media_path: Path) -> float | None:
    """Return the media's duration in seconds via `ffprobe`, or None."""
    if not media_path.exists():
        return None
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1",
                str(media_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode != 0:
            return None
        return float(out.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
        return None
