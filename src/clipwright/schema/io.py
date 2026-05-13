"""Atomic JSON load/save with schema migration.

All schema JSON files go through these helpers so that:
- We never leave a partial file on disk after a crash mid-write (tmp + rename).
- Older `schema_version` files migrate forward on read.
- Newer `schema_version` files are rejected with a clear error.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .v1 import Project, Timeline
from .v1 import migrate as _migrate

SCHEMA_VERSION = 1


class SchemaError(ValueError):
    """Raised when a project file is malformed or fails validation."""


class SchemaVersionError(SchemaError):
    """Raised when a project file's schema_version is newer than supported."""


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
    """Write JSON to `path` atomically: write to tmp in the same dir, then rename.

    Same-directory tmp guarantees rename() is atomic on POSIX and Windows.
    """
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
        # best-effort cleanup; ignore errors so original exception propagates
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _migrate_to_current(payload: dict[str, Any], *, path: Path) -> dict[str, Any]:
    try:
        return _migrate.upgrade(payload, target=SCHEMA_VERSION)
    except ValueError as e:
        version = payload.get("schema_version", "?")
        if isinstance(version, int) and version > SCHEMA_VERSION:
            raise SchemaVersionError(
                f"{path}: schema_version={version} is newer than this clipwright "
                f"supports (max {SCHEMA_VERSION}). Upgrade clipwright."
            ) from e
        raise SchemaError(f"{path}: migration failed: {e}") from e


def load_project(project_dir: Path) -> Project:
    """Load `<project_dir>/project.json`."""
    path = Path(project_dir) / "project.json"
    payload = _read_json(path)
    payload = _migrate_to_current(payload, path=path)
    try:
        return Project.from_dict(payload)
    except ValueError as e:
        raise SchemaError(f"{path}: {e}") from e


def save_project(project_dir: Path, project: Project) -> Path:
    """Write `<project_dir>/project.json` atomically."""
    path = Path(project_dir) / "project.json"
    _write_json_atomic(path, project.to_dict())
    return path


def load_timeline(project_dir: Path) -> Timeline:
    """Load `<project_dir>/timeline.json`."""
    path = Path(project_dir) / "timeline.json"
    payload = _read_json(path)
    payload = _migrate_to_current(payload, path=path)
    try:
        return Timeline.from_dict(payload)
    except ValueError as e:
        raise SchemaError(f"{path}: {e}") from e


def save_timeline(project_dir: Path, timeline: Timeline) -> Path:
    """Write `<project_dir>/timeline.json` atomically."""
    path = Path(project_dir) / "timeline.json"
    _write_json_atomic(path, timeline.to_dict())
    return path
