"""Schema v2 models — project as a collection of videos."""
from __future__ import annotations

# v2 reuses v1's segment/ref dataclasses unchanged — segments are the
# editable unit and didn't need to grow when the parent shape did.
from ..v1.timeline import Segment, SegmentRef, SegmentVoiceover
from . import migrate
from .project import Project
from .video import Video, next_video_id

__all__ = [
    "Project",
    "Video",
    "Segment",
    "SegmentRef",
    "SegmentVoiceover",
    "next_video_id",
    "migrate",
]
