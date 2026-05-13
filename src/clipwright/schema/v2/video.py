"""videos/<id>.json — one video deliverable inside a v2 project.

A `Video` is what a v1 project used to call its `timeline.json` — the
editable list of segments — plus an id and a human title. A v2 project
holds N of these and renders one MP4 per video.

The `Segment` shape is reused unchanged from v1, including its IDs
(`seg_NNN`) and per-segment refs. Segment IDs are unique *within a
video*, not globally across the project — that keeps editing simple
and matches what users intuit.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Reuse v1's Segment + supporting types unchanged.
from ..v1.timeline import Segment

_VIDEO_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*$")


@dataclass
class Video:
    """One editable video inside a v2 project.

    Stored at `<project>/videos/<video_id>.json`.
    """

    video_id: str
    title: str = ""
    segments: list[Segment] = field(default_factory=list)

    # Per-video Claude chat session id, persisted by the desktop so each
    # video gets its own conversation history independent of siblings.
    # Empty string means "no session yet; first chat turn will create one."
    chat_session_id: str = ""

    # Set on load; ignored on save.
    loaded_schema_version: int = 2

    def by_id(self, seg_id: str) -> Segment | None:
        for s in self.segments:
            if s.id == seg_id:
                return s
        return None

    def ids(self) -> list[str]:
        return [s.id for s in self.segments]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 2,
            "video_id": self.video_id,
            "title": self.title,
            "chat_session_id": self.chat_session_id,
            "segments": [s.to_dict() for s in self.segments],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Video:
        video_id = str(d.get("video_id", ""))
        if not _VIDEO_ID_RE.match(video_id):
            raise ValueError(
                f"video.video_id must match '[a-z][a-z0-9_-]*'; got {video_id!r}"
            )
        segments = [Segment.from_dict(s) for s in d.get("segments") or []]
        seen: set[str] = set()
        for s in segments:
            if s.id in seen:
                raise ValueError(f"duplicate segment id in video {video_id!r}: {s.id!r}")
            seen.add(s.id)
        return cls(
            video_id=video_id,
            title=str(d.get("title", "")),
            segments=segments,
            chat_session_id=str(d.get("chat_session_id", "")),
            loaded_schema_version=int(d.get("schema_version", 2)),
        )


def next_video_id(existing: list[str], hint: str = "") -> str:
    """Generate a unique video id, optionally biased by `hint`.

    `hint` is sanitized to match `[a-z][a-z0-9_-]*`. If empty or already
    taken, a numeric suffix is appended. If the sanitized hint is empty
    or doesn't start with a letter, falls back to `video-N`.
    """
    base = _sanitize_video_id(hint) if hint else ""
    if not base:
        # video-1, video-2, …
        existing_video_n: set[int] = set()
        for v in existing:
            m = re.match(r"^video-(\d+)$", v)
            if m:
                existing_video_n.add(int(m.group(1)))
        n = 1
        while n in existing_video_n:
            n += 1
        return f"video-{n}"
    if base not in existing:
        return base
    i = 2
    while f"{base}-{i}" in existing:
        i += 1
    return f"{base}-{i}"


def _sanitize_video_id(s: str) -> str:
    s = s.lower().strip()
    # Collapse anything non-[a-z0-9_-] to single hyphens.
    s = re.sub(r"[^a-z0-9_-]+", "-", s).strip("-_")
    # Must start with a letter to match _VIDEO_ID_RE.
    if not s or not s[0].isalpha():
        return ""
    return s
