"""Versioned project schemas (currently v2: project = collection of videos).

A clipwright project on disk is a directory of JSON + media files. The
current schema is v2; v1 projects auto-migrate on first load.

Public surface:

    from clipwright.schema import (
        SCHEMA_VERSION,
        Project, Video, Segment, SegmentRef, SegmentVoiceover,
        next_video_id,
        load_project, save_project,
        load_video, save_video, list_videos, create_video,
        SchemaError, SchemaVersionError,
        paths,
    )

The v1 dataclasses remain importable as `clipwright.schema.v1.*` because
the migration code needs them. v1 IS NOT exposed at the top level.
"""
from __future__ import annotations

from . import paths
from .io import (
    SCHEMA_VERSION,
    SchemaError,
    SchemaVersionError,
    create_video,
    delete_video,
    list_videos,
    load_project,
    load_video,
    save_project,
    save_video,
)
from .v2 import (
    PanelFrame,
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Video,
    migrate,
    next_video_id,
)
from .v2.adopt import AdoptionReport, adopt_v1_artifacts

__all__ = [
    "SCHEMA_VERSION",
    "Project",
    "Video",
    "Segment",
    "SegmentRef",
    "SegmentVoiceover",
    "PanelFrame",
    "next_video_id",
    "load_project",
    "save_project",
    "load_video",
    "save_video",
    "list_videos",
    "create_video",
    "delete_video",
    "adopt_v1_artifacts",
    "AdoptionReport",
    "SchemaError",
    "SchemaVersionError",
    "paths",
    "migrate",
]
