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


def test_click_produces_punch():
    moments = [{"t": 1.0, "type": "click", "label": "tap", "fields": {}}]
    plan = build_keyframes([_seg(0.5, 3.0, moments)])
    peaks = [k.zoom for k in plan.keyframes if k.zoom > 1.0]
    assert peaks and max(peaks) == ZOOM_BY_TYPE["click"]


def test_type_peaks_higher_than_click():
    moments = [{"t": 1.0, "type": "type", "label": "", "fields": {}}]
    plan = build_keyframes([_seg(0.5, 3.0, moments)])
    assert max(k.zoom for k in plan.keyframes) == ZOOM_BY_TYPE["type"]


def test_output_timeline_spans_concat_of_segments():
    plan = build_keyframes([_seg(0, 2, []), _seg(10, 13, [])])
    assert plan.total_duration == 5.0  # 2 + 3
