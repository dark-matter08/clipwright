"""Camera keyframe zoom patterns per action type."""
from __future__ import annotations

from clipwright.edit.keyframes import ZOOM_BY_TYPE, build_keyframes


def _seg(start: float, end: float, moments: list[dict]) -> dict:
    return {
        "source_start": start,
        "source_end": end,
        "duration": end - start,
        "moments": moments,
    }


def test_empty_segments_no_keyframes():
    plan = build_keyframes([])
    assert plan.total_duration == 0.0
    assert plan.keyframes == []


def test_flat_on_navigate():
    moments = [{"t": 1.0, "type": "navigate", "label": "", "fields": {}}]
    plan = build_keyframes([_seg(0.5, 3.0, moments)])
    # No punch keyframes for navigate — only 1.0 at seg bounds.
    zooms = {round(k.zoom, 2) for k in plan.keyframes}
    assert zooms == {1.0}


def test_click_is_flat():
    # Camera was flattened to 1.0 for all action types to avoid jitter
    # (see keyframes.py module docstring). Verify click doesn't produce
    # any zoom above 1.0.
    moments = [{"t": 1.0, "type": "click", "label": "tap", "fields": {}}]
    plan = build_keyframes([_seg(0.5, 3.0, moments)])
    assert ZOOM_BY_TYPE["click"] == 1.0, "click zoom must stay flat until camera motion is re-enabled"
    zooms = {round(k.zoom, 2) for k in plan.keyframes}
    assert zooms == {1.0}


def test_type_peaks_higher_than_click():
    moments = [{"t": 1.0, "type": "type", "label": "", "fields": {}}]
    plan = build_keyframes([_seg(0.5, 3.0, moments)])
    assert max(k.zoom for k in plan.keyframes) == ZOOM_BY_TYPE["type"]


def test_output_timeline_spans_concat_of_segments():
    plan = build_keyframes([_seg(0, 2, []), _seg(10, 13, [])])
    assert plan.total_duration == 5.0  # 2 + 3


def test_bbox_sets_focus_on_flat_keyframe():
    """When a moment carries bbox data, the keyframe focus should reflect
    the element centroid even when zoom is 1.0 (flat camera).
    Click at centroid (200, 300) in a 540×960 viewport → focus (0.37, 0.31)."""
    moments = [{
        "t": 1.0,
        "type": "click",
        "label": "tap",
        "fields": {},
        "bbox": {"x": 170, "y": 285, "w": 60, "h": 30},
    }]
    # centroid: x=200, y=300; normalized: x=200/540≈0.370, y=300/960≈0.3125
    plan = build_keyframes([_seg(0.5, 3.0, moments)], viewport=(540, 960))
    focus_xs = [k.focus[0] for k in plan.keyframes if k.focus != (0.5, 0.5)]
    assert focus_xs, "expected at least one keyframe with bbox-derived focus"
    assert abs(focus_xs[0] - 200 / 540) < 0.01


def test_no_bbox_defaults_to_center_focus():
    """Moments without bbox data get (0.5, 0.5) focus."""
    moments = [{"t": 1.0, "type": "click", "label": "tap", "fields": {}}]
    plan = build_keyframes([_seg(0.5, 3.0, moments)])
    non_center = [k for k in plan.keyframes if k.focus != (0.5, 0.5)]
    assert non_center == []
