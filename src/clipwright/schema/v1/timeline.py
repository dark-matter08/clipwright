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
class PanelFrame:
    """One image inside a segment's `panels` sequence.

    `panels` enables a segment to cycle through N images sequentially
    with crossfade transitions — each frame gets its own slice of the
    segment's total `target_duration`. This is distinct from `sources`
    (stacked comic-strip layout within one frame); use `panels` when
    you want N images shown one-after-another, use `sources` when you
    want N images in a card-stack at once.

    Fields:
        source: relative path to the image (e.g. "sources/panels/ch1/p07.webp").
        duration_seconds: how long this image stays on screen, in seconds.
            Optional — when omitted (or 0), the remaining time on the
            segment is split equally across all frames without an
            explicit duration. So you can mix-and-match: give two of
            five frames an explicit duration and the other three split
            the leftover.
    """

    source: str
    duration_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"source": self.source}
        if self.duration_seconds > 0:
            out["duration_seconds"] = round(self.duration_seconds, 3)
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> PanelFrame:
        src = str(d.get("source", "")).strip()
        if not src:
            raise ValueError("panels[].source is required and must be non-empty")
        return cls(
            source=src,
            duration_seconds=float(d.get("duration_seconds", 0.0) or 0.0),
        )


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
    # `panels` lets one segment cycle through N images sequentially with
    # crossfade transitions. When non-empty, the manhwa-recap renderer
    # ignores `source` and instead plays the panels in order, with each
    # frame's `duration_seconds` defining its on-screen time (any frame
    # without an explicit duration shares the leftover equally). The
    # voiceover/captions/audio still belong to the whole segment — only
    # the visual cycles. Use this when one beat has multiple supporting
    # images (e.g. an escalation sequence where 3 panels land under one
    # voiceover sentence).
    panels: list[PanelFrame] = field(default_factory=list)

    @property
    def source_duration(self) -> float:
        return max(0.0, self.source_end - self.source_start)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
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
        # `panels` is a new opt-in field. Omit it when empty so existing
        # single-image segments round-trip identical bytes on save — keeps
        # diffs clean and avoids gratuitous schema-version churn.
        if self.panels:
            out["panels"] = [p.to_dict() for p in self.panels]
        return out

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

        raw_panels = d.get("panels") or []
        if not isinstance(raw_panels, list):
            raise ValueError(
                f"segment {seg_id}: `panels` must be a list of "
                f"{{source, duration_seconds?}} objects; got {type(raw_panels).__name__}"
            )
        panels = [
            PanelFrame.from_dict(p) if isinstance(p, dict) else PanelFrame(source=str(p))
            for p in raw_panels
        ]
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
            panels=panels,
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
