"""v1 → v2 schema migration.

A v1 project has:
    <project>/project.json                       (schema_version: 1)
    <project>/timeline.json                      (schema_version: 1)
    <project>/voiceover/audio/<seg>.{mp3,timestamps.json,cache.json}
    <project>/captions/<seg>/...
    <project>/out/segments/<seg>.mp4

A v2 project rearranges per-segment artifacts under a per-video subdir:
    <project>/project.json                       (schema_version: 2)
    <project>/videos/main.json                   (schema_version: 2, video_id="main")
    <project>/voiceover/audio/main/<seg>.{mp3,timestamps.json,cache.json}
    <project>/captions/main/<seg>/...
    <project>/out/segments/main/<seg>.mp4
    <project>/out/final/main.mp4                 (replaces out/final.mp4)

Migration is auto-applied on `load_project`. Originals are backed up to
`<project>/.clipwright/v1-backup/` so the user can roll back manually if
anything looks wrong after upgrade.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def is_v1_project(project_dir: Path) -> bool:
    """Heuristic: a v1 project has `timeline.json` at the root but no
    `videos/` directory. New v2 projects never write `timeline.json`."""
    pj = project_dir / "project.json"
    if not pj.exists():
        return False
    try:
        payload = json.loads(pj.read_text())
    except json.JSONDecodeError:
        return False
    if int(payload.get("schema_version", 1)) >= 2:
        return False
    return (project_dir / "timeline.json").exists()


@dataclass
class MigrationReport:
    project_dir: Path
    backup_dir: Path
    moved_paths: list[tuple[Path, Path]]
    """List of (from, to) pairs of every file/dir relocation performed.
    Useful for tests and for a "what just changed" log line in the UI."""


def upgrade_v1_project_to_v2(project_dir: Path, video_id: str = "main") -> MigrationReport:
    """Convert a v1 project layout in-place to v2.

    Idempotent: re-running on an already-v2 project is a no-op.
    """
    project_dir = Path(project_dir).resolve()
    backup_dir = project_dir / ".clipwright" / "v1-backup"
    moved: list[tuple[Path, Path]] = []

    if not is_v1_project(project_dir):
        return MigrationReport(project_dir, backup_dir, moved)

    backup_dir.mkdir(parents=True, exist_ok=True)

    # 1. Bump project.json#schema_version → 2.
    pj = project_dir / "project.json"
    payload: dict[str, Any] = json.loads(pj.read_text())
    _backup(pj, backup_dir / "project.json", moved)
    payload["schema_version"] = 2
    _atomic_write_json(pj, payload)

    # 2. Convert timeline.json → videos/<video_id>.json.
    timeline_path = project_dir / "timeline.json"
    timeline_payload: dict[str, Any] = json.loads(timeline_path.read_text())
    _backup(timeline_path, backup_dir / "timeline.json", moved)
    video_payload = {
        "schema_version": 2,
        "video_id": video_id,
        "title": payload.get("title", "") or video_id,
        "chat_session_id": "",
        "segments": timeline_payload.get("segments", []),
    }
    videos_dir = project_dir / "videos"
    videos_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(videos_dir / f"{video_id}.json", video_payload)
    moved.append((timeline_path, videos_dir / f"{video_id}.json"))
    timeline_path.unlink()

    # 3. Per-segment artifacts move from flat `<area>/<seg>.<ext>` →
    #    `<area>/<video_id>/<seg>.<ext>`.
    _migrate_voiceover_audio(project_dir, video_id, moved)
    _migrate_voiceover_script(project_dir, video_id, moved)
    _migrate_captions(project_dir, video_id, moved)
    _migrate_out_segments(project_dir, video_id, moved)
    _migrate_out_final(project_dir, video_id, moved)

    return MigrationReport(project_dir, backup_dir, moved)


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Tmp + rename so a crash mid-write leaves the v1 original intact."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _backup(src: Path, dst: Path, moved: list[tuple[Path, Path]]) -> None:
    """Copy the file to the backup dir, preserving timestamps. Idempotent."""
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    moved.append((src, dst))


def _migrate_voiceover_script(
    project_dir: Path, video_id: str, moved: list[tuple[Path, Path]]
) -> None:
    """v1 had a single `voiceover/script.json`; v2 scopes by video."""
    flat = project_dir / "voiceover" / "script.json"
    if not flat.exists():
        return
    new_path = project_dir / "voiceover" / "scripts" / f"{video_id}.json"
    new_path.parent.mkdir(parents=True, exist_ok=True)
    flat.replace(new_path)
    moved.append((flat, new_path))


def _migrate_voiceover_audio(
    project_dir: Path, video_id: str, moved: list[tuple[Path, Path]]
) -> None:
    audio_dir = project_dir / "voiceover" / "audio"
    if not audio_dir.exists():
        return
    new_dir = audio_dir / video_id
    new_dir.mkdir(parents=True, exist_ok=True)
    for entry in list(audio_dir.iterdir()):
        if entry.is_dir():
            continue  # already scoped (re-runs)
        target = new_dir / entry.name
        entry.replace(target)
        moved.append((entry, target))


def _migrate_captions(
    project_dir: Path, video_id: str, moved: list[tuple[Path, Path]]
) -> None:
    captions_dir = project_dir / "captions"
    if not captions_dir.exists():
        return
    new_dir = captions_dir / video_id
    new_dir.mkdir(parents=True, exist_ok=True)
    for entry in list(captions_dir.iterdir()):
        # `style.json` is project-scoped, not per-segment — leave it alone.
        if entry.name == "style.json":
            continue
        # Skip already-scoped per-video dirs (re-runs).
        if entry.is_dir() and entry.name == video_id:
            continue
        # v1 had per-segment dirs at the captions/ root; move each into the video.
        if entry.is_dir():
            target = new_dir / entry.name
            entry.replace(target)
            moved.append((entry, target))


def _migrate_out_segments(
    project_dir: Path, video_id: str, moved: list[tuple[Path, Path]]
) -> None:
    seg_dir = project_dir / "out" / "segments"
    if not seg_dir.exists():
        return
    new_dir = seg_dir / video_id
    new_dir.mkdir(parents=True, exist_ok=True)
    for entry in list(seg_dir.iterdir()):
        # Skip already-scoped subdirs (re-runs) and the existing _work scratch.
        if entry.is_dir() and entry.name in (video_id, "_work"):
            continue
        target = new_dir / entry.name
        entry.replace(target)
        moved.append((entry, target))


def _migrate_out_final(
    project_dir: Path, video_id: str, moved: list[tuple[Path, Path]]
) -> None:
    flat = project_dir / "out" / "final.mp4"
    if not flat.exists():
        return
    new_dir = project_dir / "out" / "final"
    new_dir.mkdir(parents=True, exist_ok=True)
    target = new_dir / f"{video_id}.mp4"
    flat.replace(target)
    moved.append((flat, target))
