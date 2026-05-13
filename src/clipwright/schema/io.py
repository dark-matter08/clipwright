"""Atomic JSON load/save for the v2 schema, with v1 auto-migration.

Public surface:

    load_project(dir) -> Project          # auto-migrates v1 on first read
    save_project(dir, project)
    load_video(dir, video_id) -> Video
    save_video(dir, video)
    list_videos(dir) -> list[str]         # all video_ids in the project
    create_video(dir, video_id, title)   # writes an empty Video manifest

Atomic writes everywhere (tmp + rename). Migration runs on `load_project`
once; subsequent loads are no-ops because the v1 markers are gone after
the first run.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from . import paths
from .v2 import Project, Video
from .v2 import migrate as _v2_migrate
from .v2 import normalize as _v2_normalize

SCHEMA_VERSION = 2


class SchemaError(ValueError):
    """Raised when a project file is malformed or fails validation."""


class SchemaVersionError(SchemaError):
    """Raised when a project file's schema_version is newer than supported."""


# ---------------------------------------------------------------------------
# Atomic IO primitives
# ---------------------------------------------------------------------------


def _read_json(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as e:
        raise SchemaError(f"file not found: {path}") from e
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise SchemaError(f"{path}: invalid JSON: {e}") from e
    if not isinstance(data, dict):
        raise SchemaError(f"{path}: top-level must be an object")
    return data


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    """Same-dir tmp + rename. Guarantees no partial files on crash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Project — top-level manifest
# ---------------------------------------------------------------------------


def load_project(project_dir: Path) -> Project:
    """Read `<project_dir>/project.json`, auto-migrating v1 if needed."""
    path = Path(project_dir) / "project.json"
    payload = _read_json(path)
    version = int(payload.get("schema_version", 1))
    if version > SCHEMA_VERSION:
        raise SchemaVersionError(
            f"{path}: schema_version={version} is newer than this clipwright "
            f"supports (max {SCHEMA_VERSION}). Upgrade clipwright."
        )
    if version < SCHEMA_VERSION:
        # Auto-migrate. Re-read after; the migration rewrote the file.
        _v2_migrate.upgrade_v1_project_to_v2(Path(project_dir))
        payload = _read_json(path)
    # Heal any non-conforming video_ids written by earlier desktop builds
    # before validation hardened. Idempotent.
    _v2_normalize.normalize_v2_video_ids(Path(project_dir))
    try:
        return Project.from_dict(payload)
    except ValueError as e:
        raise SchemaError(f"{path}: {e}") from e


def save_project(project_dir: Path, project: Project) -> Path:
    path = Path(project_dir) / "project.json"
    _write_json_atomic(path, project.to_dict())
    return path


# ---------------------------------------------------------------------------
# Videos — per-deliverable timelines
# ---------------------------------------------------------------------------


def list_videos(project_dir: Path) -> list[str]:
    """Return every video_id present in `<project>/videos/`, sorted.

    Sort order: a video_id literally named "main" first (the canonical
    first-import slot), then alphabetical. Keeps the UI predictable.
    """
    vdir = paths.videos_dir(project_dir)
    if not vdir.exists():
        return []
    ids: list[str] = []
    for f in vdir.iterdir():
        if f.is_file() and f.suffix == ".json":
            ids.append(f.stem)
    ids.sort(key=lambda x: (0 if x == "main" else 1, x))
    return ids


def load_video(project_dir: Path, video_id: str) -> Video:
    path = paths.video_manifest_path(Path(project_dir), video_id)
    payload = _read_json(path)
    version = int(payload.get("schema_version", 2))
    if version > SCHEMA_VERSION:
        raise SchemaVersionError(
            f"{path}: schema_version={version} is newer than this clipwright "
            f"supports (max {SCHEMA_VERSION}). Upgrade clipwright."
        )
    try:
        return Video.from_dict(payload)
    except ValueError as e:
        raise SchemaError(f"{path}: {e}") from e


def save_video(project_dir: Path, video: Video) -> Path:
    path = paths.video_manifest_path(Path(project_dir), video.video_id)
    _write_json_atomic(path, video.to_dict())
    return path


def create_video(project_dir: Path, video_id: str, title: str = "") -> Video:
    """Write an empty `<video_id>.json` manifest. Errors if it already exists."""
    path = paths.video_manifest_path(Path(project_dir), video_id)
    if path.exists():
        raise SchemaError(f"video already exists: {video_id} ({path})")
    video = Video(video_id=video_id, title=title or video_id, segments=[])
    save_video(project_dir, video)
    return video
