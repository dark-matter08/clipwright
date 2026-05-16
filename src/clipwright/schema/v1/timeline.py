"""timeline.json — the editable timeline.

A flat list of segments in display order. Each segment references a source
file + range and points at other JSON files for VO, captions, camera,
annotations. Pointers use a `"file.json#seg_id"` shape so a file watcher
can dispatch invalidations by segment.

Stability invariants:
- Segment IDs are stable across edits. Splitting `seg_001` yields
  `seg_001` + a new id; it never renumbers downstream.
- `kind` is one of: "recording" (default), "scene", "generated".
- `scene_type` is required when kind == "scene"; null otherwise.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

SegmentKind = Literal["recording", "scene", "generated"]
# `panel` was added for the manhwa-recap template: a still image
# (downloaded panel) used as a segment source, distinct from a designed
# title/outro card (`title`/`outro`) or generic broll (`broll`).
SceneType = Literal["title", "broll", "outro", "intro", "hero", "panel"]

VALID_KINDS: set[str] = {"recording", "scene", "generated"}
VALID_SCENE_TYPES: set[str] = {"title", "broll", "outro", "intro", "hero", "panel"}

_SEG_ID_RE = re.compile(r"^seg_[a-z0-9]+$")
_REF_RE = re.compile(r"^[a-zA-Z0-9_./-]+\.json#seg_[a-z0-9]+$")


@dataclass
class SegmentVoiceover:
    """Per-segment voiceover binding.

    Points at a clip inside `voiceover/script.json`. Disabled when
    `enabled` is False (e.g. for music-only or silent segments).
    """

    enabled: bool = True
    script_clip_id: str = ""  # references voiceover/script.json clips[].id

    def to_dict(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "script_clip_id": self.script_clip_id}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SegmentVoiceover:
        return cls(
            enabled=bool(d.get("enabled", True)),
            script_clip_id=str(d.get("script_clip_id", "")),
        )


@dataclass
class SegmentRef:
    """Pointer to another file's per-segment data.

    Shape: `<relative_path>.json#<segment_id>`. Example: `camera.json#seg_001`.
    `enabled=False` skips the overlay/operation entirely at render time.
    """

    enabled: bool = True
    ref: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "ref": self.ref}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SegmentRef:
        ref = str(d.get("ref", ""))
        if ref and not _REF_RE.match(ref):
            raise ValueError(
                f"SegmentRef.ref must match '<path>.json#seg_<id>'; got {ref!r}"
            )
        return cls(enabled=bool(d.get("enabled", True)), ref=ref)


@dataclass
class Segment:
    """A single editable timeline segment.

    Either a slice of an imported/recorded source (`kind="recording"`) or
    a generated/designed scene (`kind="scene"` or `kind="generated"`).
    """

    id: str
    source: str = ""  # relative path; e.g. "sources/main.mp4". Empty for pure scenes.
    source_start: float = 0.0
    source_end: float = 0.0
    target_duration: float = 0.0  # output-timeline duration; TTS-stretched if VO present
    kind: str = "recording"
    scene_type: str | None = None
    label: str = ""
    chapter: str = ""
    voiceover: SegmentVoiceover = field(default_factory=SegmentVoiceover)
    captions: SegmentRef = field(default_factory=lambda: SegmentRef(ref=""))
    camera: SegmentRef = field(default_factory=lambda: SegmentRef(ref=""))
    annotations: SegmentRef = field(default_factory=lambda: SegmentRef(ref=""))

    @property
    def source_duration(self) -> float:
        return max(0.0, self.source_end - self.source_start)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "source_start": round(self.source_start, 3),
            "source_end": round(self.source_end, 3),
            "target_duration": round(self.target_duration, 3),
            "kind": self.kind,
            "scene_type": self.scene_type,
            "label": self.label,
            "chapter": self.chapter,
            "voiceover": self.voiceover.to_dict(),
            "captions": self.captions.to_dict(),
            "camera": self.camera.to_dict(),
            "annotations": self.annotations.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Segment:
        seg_id = str(d.get("id", ""))
        if not _SEG_ID_RE.match(seg_id):
            raise ValueError(
                f"segment.id must match 'seg_<alnum>'; got {seg_id!r}"
            )
        kind = str(d.get("kind", "recording"))
        if kind not in VALID_KINDS:
            raise ValueError(
                f"segment.kind must be one of {sorted(VALID_KINDS)}; got {kind!r}"
            )
        scene_type = d.get("scene_type")
        if scene_type is not None:
            scene_type = str(scene_type)
            if scene_type not in VALID_SCENE_TYPES:
                raise ValueError(
                    f"segment.scene_type must be one of {sorted(VALID_SCENE_TYPES)} "
                    f"or null; got {scene_type!r}"
                )
        if kind == "scene" and scene_type is None:
            raise ValueError(
                f"segment.scene_type is required when kind='scene' (id={seg_id})"
            )

        src_start = float(d.get("source_start", 0.0))
        src_end = float(d.get("source_end", 0.0))
        if kind == "recording":
            if src_end < src_start:
                raise ValueError(
                    f"segment {seg_id}: source_end ({src_end}) < source_start ({src_start})"
                )

        return cls(
            id=seg_id,
            source=str(d.get("source", "")),
            source_start=src_start,
            source_end=src_end,
            target_duration=float(d.get("target_duration", src_end - src_start)),
            kind=kind,
            scene_type=scene_type,
            label=str(d.get("label", "")),
            chapter=str(d.get("chapter", "")),
            voiceover=SegmentVoiceover.from_dict(d.get("voiceover") or {}),
            captions=SegmentRef.from_dict(d.get("captions") or {}),
            camera=SegmentRef.from_dict(d.get("camera") or {}),
            annotations=SegmentRef.from_dict(d.get("annotations") or {}),
        )


@dataclass
class Timeline:
    """Ordered list of segments — the editable EDL.

    Stored at `<project>/timeline.json`.
    """

    segments: list[Segment] = field(default_factory=list)

    # set on load; ignored on save (always writes current SCHEMA_VERSION).
    loaded_schema_version: int = 1

    def by_id(self, seg_id: str) -> Segment | None:
        for s in self.segments:
            if s.id == seg_id:
                return s
        return None

    def ids(self) -> list[str]:
        return [s.id for s in self.segments]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "segments": [s.to_dict() for s in self.segments],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Timeline:
        segs = [Segment.from_dict(s) for s in d.get("segments") or []]
        # enforce id uniqueness
        seen: set[str] = set()
        for s in segs:
            if s.id in seen:
                raise ValueError(f"duplicate segment id: {s.id!r}")
            seen.add(s.id)
        return cls(
            segments=segs,
            loaded_schema_version=int(d.get("schema_version", 1)),
        )


def next_segment_id(existing_ids: list[str]) -> str:
    """Generate the next `seg_NNN` id given a list of existing ids.

    Numeric ids are issued sequentially. Suffixed ids (e.g. `seg_001a` from
    a split) are preserved but do not advance the counter.
    """
    n = 0
    for sid in existing_ids:
        m = re.match(r"^seg_(\d+)$", sid)
        if m:
            n = max(n, int(m.group(1)))
    return f"seg_{n + 1:03d}"
