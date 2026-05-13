"""Versioned project schemas.

A clipwright project on disk is a directory of JSON + media files. The shapes
of those JSON files are defined here, versioned, and atomically loaded/saved.

Public surface:

    from clipwright.schema import (
        SCHEMA_VERSION,
        Project, Timeline, Segment, SegmentVoiceover, SegmentRef,
        load_project, save_project,
        load_timeline, save_timeline,
        SchemaError, SchemaVersionError,
    )

Versioning:

    Every JSON file written by clipwright carries a `schema_version` integer.
    The current version is `SCHEMA_VERSION`. Loaders refuse to read newer
    versions and migrate older ones via `migrate.upgrade(payload, target)`.
    For v1 there is nothing to migrate; the hook exists for future versions.
"""
from __future__ import annotations

from .io import (
    SchemaError,
    SchemaVersionError,
    load_project,
    load_timeline,
    save_project,
    save_timeline,
)
from .v1 import (
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Timeline,
)
from .v1 import migrate as _migrate_v1

SCHEMA_VERSION = 1

__all__ = [
    "SCHEMA_VERSION",
    "Project",
    "Timeline",
    "Segment",
    "SegmentRef",
    "SegmentVoiceover",
    "load_project",
    "save_project",
    "load_timeline",
    "save_timeline",
    "SchemaError",
    "SchemaVersionError",
]

# Re-export migration hook so callers can `from clipwright.schema import migrate`
migrate = _migrate_v1
