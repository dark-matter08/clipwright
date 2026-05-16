"""Lockstep contract test — validator regex ↔ renderer file paths ↔ template prompt.

**The bug we're guarding against:** at one point the schema's
`_REF_RE` only accepted the legacy `<path>.json#seg_<id>` fragment
shape, but the renderer (`manhwa_backend._load_camera`) was reading
per-segment files directly (`camera/<seg>.json`) and the
manhwa-recommendations template prompt was instructing the agent to
write that per-segment shape. So the agent wrote the correct shape,
the renderer read the correct shape, and only the validator was out
of sync — a user with a perfectly-good project hit a `SchemaError` on
load and couldn't render.

The fix was widening the regex, but the structural lesson is bigger:
these three specifications are coupled by convention, not by code.
Future churn (someone narrows the regex; someone changes the renderer
to demand a fragment again; someone rewrites the template) can
reintroduce the drift.

This file pins all three together with one round-trip test per legal
ref shape. If any of the three diverges from the others, the
matching subtest fails in CI before anyone can ship the change.

**Maintenance contract:** when adding a new legal ref shape, you MUST:

  1. Update `_REF_RE` in `clipwright.schema.v1.timeline` to accept it.
  2. Make the renderer (`manhwa_backend._load_camera` and similar
     loaders) able to find files written in that shape.
  3. Add a new `_RefCase` entry below pinning the shape end-to-end.

If a case here doesn't have a matching codepath, that's the bug — not
the test.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from clipwright.render.manhwa_backend import _load_camera
from clipwright.schema import Project, SegmentRef, save_project
from clipwright.schema.v1.timeline import _REF_RE


@dataclass(frozen=True)
class _RefCase:
    """One legal ref shape + the on-disk path the renderer expects.

    `template_example` is the literal example string the
    manhwa-recommendations template / agent prompts can reference.
    `disk_relpath` is where the renderer (`_load_camera` and friends)
    will look for the file — when the two diverge, the project is
    valid-on-paper but unrenderable, which is the exact failure mode
    this contract guards against.
    """

    label: str
    template_example: str
    disk_relpath: str  # relative to project_dir; the renderer's chosen path
    video_id: str
    seg_id: str


# Every legal ref shape. Adding a row here forces both the regex and
# the renderer to support it (failing subtests pinpoint which one
# needs the change).
_CASES: list[_RefCase] = [
    _RefCase(
        label="flat per-segment file",
        template_example="camera/seg_001.json",
        disk_relpath="camera/seg_001.json",
        video_id="main",
        seg_id="seg_001",
    ),
    _RefCase(
        label="per-segment file scoped by video",
        template_example="camera/my-video/seg_002.json",
        disk_relpath="camera/my-video/seg_002.json",
        video_id="my-video",
        seg_id="seg_002",
    ),
]


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c.label)
def test_ref_shape_passes_validator(case: _RefCase) -> None:
    """The regex MUST accept every template-example string."""
    assert _REF_RE.match(case.template_example), (
        f"Regex rejects template-example ref {case.template_example!r}. "
        f"Either the regex regressed or the template prompt's example "
        f"drifted to a shape the validator never supported. Update "
        f"`_REF_RE` in schema/v1/timeline.py if the shape should be legal."
    )


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c.label)
def test_ref_shape_constructs_via_segmentref_from_dict(case: _RefCase) -> None:
    """`SegmentRef.from_dict` is the load-path the videos/<id>.json
    parser uses. If this fails, the user's project file is unloadable."""
    ref = SegmentRef.from_dict({"enabled": True, "ref": case.template_example})
    assert ref.ref == case.template_example


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c.label)
def test_ref_shape_is_findable_by_renderer(tmp_path: Path, case: _RefCase) -> None:
    """The disk path the renderer constructs MUST match the template-
    example ref. Otherwise the project loads cleanly, validation
    passes, and rendering silently falls back to "no camera data" —
    the worst kind of silent failure."""
    save_project(tmp_path, Project())
    cam_path = tmp_path / case.disk_relpath
    cam_path.parent.mkdir(parents=True, exist_ok=True)
    # Distinctive payload so we know the renderer found THIS file
    # vs. an unrelated fallback / cache.
    cam_path.write_text(
        json.dumps(
            {
                "keyframes": [
                    {"t": 0.0, "zoom": 1.0, "pan_x": 0.0, "pan_y": 0.0},
                    {"t": 5.0, "zoom": 1.2, "pan_x": 0.0, "pan_y": 0.1},
                ]
            }
        )
    )
    loaded = _load_camera(tmp_path, case.video_id, case.seg_id)
    assert len(loaded) == 2, (
        f"Renderer didn't find {cam_path}. The template example "
        f"{case.template_example!r} promises this disk location to the "
        f"agent, but `_load_camera` is checking somewhere else. Either "
        f"add the path to the renderer's lookup list OR drop this case "
        f"from the contract."
    )
    # Sanity check: the loaded keyframes are the ones we wrote.
    assert loaded[0]["zoom"] == 1.0
    assert loaded[1]["zoom"] == 1.2


def test_legacy_fragment_shape_still_validates() -> None:
    """The legacy `<path>.json#seg_<id>` shape is used by the
    captions index file (one JSON with N seg chunks). It MUST keep
    working — caption rendering depends on it."""
    ref = SegmentRef.from_dict({
        "enabled": True,
        "ref": "captions/index.json#seg_042",
    })
    assert ref.ref == "captions/index.json#seg_042"


def test_invalid_shape_message_lists_all_legal_examples() -> None:
    """The error message must teach every legal shape so the agent /
    user can self-correct on the next try. Without this, a typo on
    a ref means a 1-line cryptic error and no path forward."""
    with pytest.raises(ValueError) as exc_info:
        SegmentRef.from_dict({"ref": "not-a-json-path"})
    msg = str(exc_info.value)
    # The error must include at least one example of each shape we
    # documented as legal — that's what makes it self-diagnosing.
    assert "camera/seg_001.json" in msg, f"missing flat example in: {msg}"
    assert "captions/index.json#seg_001" in msg, f"missing fragment example in: {msg}"
