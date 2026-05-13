"""Record-mode project creation (SRS §6.1.a, F-REC-1 through F-REC-5).

Drives the existing Playwright recorder, then seeds the v1 project schema
(`project.json` + `timeline.json`) so that Record-mode and Upload-mode produce
the same on-disk shape. The two modes converge here: after this runs, every
downstream stage and the desktop editor see one project format regardless of
how the source got there.

Layout produced (matches `import_video.import_video`):

    <project>/
    ├── project.json            ← v1 schema
    ├── timeline.json           ← v1 schema, one segment per chapter
    ├── browse-plan.json        ← preserved at project root (Record-mode marker)
    ├── moments.json            ← raw action log from the recorder
    └── sources/
        └── main.mp4            ← recorded video

The module splits into:

1. `record_project(...)` — the orchestrator. Calls Playwright and then the
   seed helper. Networked / heavy; integration-tested only.
2. `_seed_from_recording(...)` — pure file ops + schema writes from already-
   captured artifacts. Easy to unit-test with a synthesized MP4.

Re-record preservation (SRS F-REC-6 — preserve segment IDs across re-records)
is not implemented here; it lands in P1 when the desktop editor needs it.
A TODO comment marks the merge point.
"""
from __future__ import annotations

import datetime
import json
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .edit.segments import build_segments
from .ffmpeg import FFmpegError, probe_duration, require
from .import_video import ImportResult
from .record.playwright_recorder import record as record_impl
from .schema import (
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Timeline,
    load_project,
    save_project,
    save_timeline,
)
from .schema.v1.timeline import next_segment_id


@dataclass
class RecordError(Exception):
    """Record-mode-specific failure with a fix hint baked in."""

    message: str
    fix: str = ""

    def __str__(self) -> str:
        return self.message


def record_project(
    project_dir: Path,
    *,
    plan_path: Path | None = None,
    title: str = "",
    aspect: str = "9:16",
    viewport: tuple[int, int] | None = None,
    mobile: bool = False,
    user_agent: str = "",
) -> ImportResult:
    """Run the Playwright recorder against `browse-plan.json` and seed schemas.

    Args:
        project_dir: project directory. Must contain `browse-plan.json` unless
            `plan_path` is provided. Will be created if missing.
        plan_path: path to a `browse-plan.json` outside the project dir. If
            given, the file is copied to `<project>/browse-plan.json` so the
            project is self-contained.
        title: project title; defaults to the project dir name.
        aspect: "9:16", "16:9", or "1:1".
        viewport: optional (w, h) override; defaults to the plan's viewport.
        mobile: emulate a mobile device.
        user_agent: override the browser UA.

    Returns the same `ImportResult` shape as `import_video.import_video`, so
    callers can treat Record-mode and Upload-mode identically.
    """
    require()  # ffmpeg/ffprobe on PATH
    project_dir = Path(project_dir).resolve()
    project_dir.mkdir(parents=True, exist_ok=True)

    plan_dst = project_dir / "browse-plan.json"
    if plan_path is not None:
        plan_path = Path(plan_path).resolve()
        if not plan_path.exists():
            raise RecordError(
                message=f"browse-plan.json not found: {plan_path}",
                fix=(
                    "Pass --plan with a path to an existing browse-plan.json, "
                    "or omit it to use <project>/browse-plan.json."
                ),
            )
        if plan_path != plan_dst:
            shutil.copy2(plan_path, plan_dst)
    elif not plan_dst.exists():
        raise RecordError(
            message=f"no browse-plan.json in {project_dir} and none provided",
            fix="Create <project>/browse-plan.json, or pass --plan <path>.",
        )

    # Read the plan to find URL + viewport defaults for the recorder.
    plan_payload = json.loads(plan_dst.read_text())
    base_url = str(plan_payload.get("base_url", ""))
    vp = plan_payload.get("viewport") or {}
    rec_viewport = viewport or (int(vp.get("width", 540)), int(vp.get("height", 960)))
    rec_mobile = mobile or bool(vp.get("mobile", False))

    # Run the recorder into a temp dir, then move artifacts into the v1 layout.
    with tempfile.TemporaryDirectory(prefix="clipwright-rec-") as tmp:
        tmp_out = Path(tmp)
        video_path, moments_path = record_impl(
            base_url,
            None,
            tmp_out,
            size=rec_viewport,
            mobile=rec_mobile,
            user_agent=user_agent,
            plan_path=plan_dst,
        )
        moments = json.loads(moments_path.read_text())
        return _seed_from_recording(
            project_dir,
            source_video=video_path,
            moments=moments,
            title=title,
            aspect=aspect,
            base_url=base_url,
        )


def _seed_from_recording(
    project_dir: Path,
    *,
    source_video: Path,
    moments: list[dict],
    title: str = "",
    aspect: str = "9:16",
    base_url: str = "",
    copy_source: bool = True,
) -> ImportResult:
    """Pure file ops + schema writes. No Playwright. Easy to test.

    Given a captured video and its `moments.json` content, lay out the v1
    project files. Idempotent — running twice produces the same result.
    """
    project_dir = Path(project_dir).resolve()
    sources_dir = project_dir / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    dst = sources_dir / "main.mp4"
    if dst.exists():
        dst.unlink()
    if copy_source:
        shutil.copy2(source_video, dst)
    else:
        dst.symlink_to(Path(source_video).resolve())

    duration = probe_duration(dst)
    if duration <= 0:
        raise FFmpegError(f"could not determine duration of {dst}")

    # Persist the raw moments at the project root — Record-mode marker, and a
    # re-record input (F-REC-6 will read this to preserve segment IDs).
    (project_dir / "moments.json").write_text(
        json.dumps(moments, indent=2) + "\n"
    )

    # Convert chapter-grouped recorder segments → schema v1 Segments.
    # `build_segments` returns the legacy Segment dataclass (chapter + range
    # + moments); we translate the relevant fields into the v1 shape.
    legacy_segments = build_segments(moments, duration)

    # TODO(P1, F-REC-6): when re-recording, read an existing timeline.json
    # and re-use stable segment IDs by matching `chapter` labels. For now
    # we always start fresh with `seg_001`, `seg_002`, ...

    v1_segments: list[Segment] = []
    chapter_label = ""
    for idx, lseg in enumerate(legacy_segments):
        sid = next_segment_id([s.id for s in v1_segments])
        chapter = lseg.chapter or ""
        # The label is the first moment's label when present — it's the most
        # human-meaningful summary of the chapter for the UI.
        label = ""
        if lseg.moments:
            label = lseg.moments[0].label or chapter
        v1_segments.append(
            Segment(
                id=sid,
                source="sources/main.mp4",
                source_start=lseg.source_start,
                source_end=lseg.source_end,
                target_duration=lseg.source_end - lseg.source_start,
                kind="recording",
                label=label or f"Chapter {idx + 1}",
                chapter=chapter,
                voiceover=SegmentVoiceover(enabled=True, script_clip_id=""),
                captions=SegmentRef(enabled=True, ref=f"captions/index.json#{sid}"),
                camera=SegmentRef(enabled=True, ref=f"camera.json#{sid}"),
                annotations=SegmentRef(enabled=True, ref=f"annotations.json#{sid}"),
            )
        )
        # last seen chapter label, used only for debugging clarity
        chapter_label = chapter or chapter_label

    timeline = Timeline(segments=v1_segments)

    # If a project.json already exists (re-record case), preserve user-tuned
    # fields and only refresh title/aspect/base_url when explicitly passed.
    project_json = project_dir / "project.json"
    if project_json.exists():
        project = load_project(project_dir)
        if title:
            project.title = title
        project.aspect = aspect or project.aspect
        if base_url:
            project.base_url = base_url
    else:
        project = Project(
            title=title or project_dir.name,
            aspect=aspect,
            fps=30,
            render_backend="remotion",
            tts_provider="kokoro",
            voice_id="",
            base_url=base_url,
            created_at=datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        )

    save_project(project_dir, project)
    save_timeline(project_dir, timeline)

    return ImportResult(
        project_dir=project_dir,
        project=project,
        timeline=timeline,
        source_path=dst,
        n_segments=len(v1_segments),
    )
