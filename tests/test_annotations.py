"""Annotation event generation from segments.json bbox data."""
from __future__ import annotations

import json

from clipwright.edit.annotations import build_annotations, run


def _seg(src_start, src_end, moments):
    return {
        "source_start": src_start,
        "source_end": src_end,
        "duration": src_end - src_start,
        "moments": moments,
    }


def _moment(t, action_type, label="", bbox=None):
    m = {"t": t, "type": action_type, "label": label}
    if bbox:
        m["bbox"] = bbox
    return m


def test_empty_segments():
    result = build_annotations([])
    assert result["events"] == []
    assert result["viewport_w"] == 540
    assert result["viewport_h"] == 960


def test_no_bbox_moments_produce_no_events():
    segs = [_seg(0.0, 3.0, [_moment(1.0, "click", "Tap")])]
    result = build_annotations(segs)
    assert result["events"] == []


def test_navigate_action_skipped():
    """navigate never produces annotation overlays (no locator → no bbox)."""
    segs = [_seg(0.0, 3.0, [
        _moment(1.0, "navigate", "Open app", bbox={"x": 0, "y": 0, "w": 540, "h": 960}),
    ])]
    result = build_annotations(segs)
    assert result["events"] == [], "navigate should not produce annotations"


def test_click_produces_ripple_event():
    segs = [_seg(0.0, 5.0, [
        _moment(2.0, "click", "Tap the button", bbox={"x": 100, "y": 200, "w": 80, "h": 30}),
    ])]
    result = build_annotations(segs)
    assert len(result["events"]) == 1
    ev = result["events"][0]
    assert ev["action_type"] == "click"
    assert ev["cx"] == 100 + 80 / 2   # 140.0
    assert ev["cy"] == 200 + 30 / 2   # 215.0
    assert ev["bw"] == 80.0
    assert ev["bh"] == 30.0
    # annotation starts before and ends after the moment
    assert ev["t_in"] < 2.0
    assert ev["t_out"] > 2.0


def test_type_produces_event():
    segs = [_seg(0.0, 5.0, [
        _moment(1.5, "type", "Search query", bbox={"x": 50, "y": 400, "w": 300, "h": 40}),
    ])]
    result = build_annotations(segs)
    assert len(result["events"]) == 1
    assert result["events"][0]["action_type"] == "type"


def test_multiple_segments_output_timeline():
    """Events in the second segment should be offset by first segment's duration."""
    segs = [
        _seg(0.0, 3.0, [_moment(1.5, "click", "", bbox={"x": 100, "y": 100, "w": 60, "h": 20})]),
        _seg(5.0, 8.0, [_moment(6.5, "click", "", bbox={"x": 200, "y": 300, "w": 50, "h": 30})]),
    ]
    result = build_annotations(segs)
    assert len(result["events"]) == 2
    ev0, ev1 = result["events"]
    # First event at local output time ≈ 1.5
    assert abs(ev0["t_in"] - (1.5 - 0.1)) < 0.01
    # Second event: output_t for seg2 = 3.0 (dur of seg1), local = 6.5 - 5.0 = 1.5
    # → output time ≈ 3.0 + 1.5 = 4.5
    assert abs(ev1["t_in"] - (4.5 - 0.1)) < 0.01


def test_annotation_clamped_to_segment():
    """Annotations must not extend beyond the segment's output end."""
    segs = [_seg(0.0, 2.0, [
        _moment(1.9, "click", "", bbox={"x": 100, "y": 100, "w": 20, "h": 20}),
    ])]
    result = build_annotations(segs)
    if result["events"]:
        ev = result["events"][0]
        assert ev["t_out"] <= 2.0


def test_run_writes_file(tmp_path):
    segs_path = tmp_path / "segments.json"
    out_path = tmp_path / "annotations.json"
    doc = {
        "video": "/tmp/x.mp4",
        "duration": 6.0,
        "segments": [
            _seg(0.0, 3.0, [
                _moment(1.5, "click", "Tap", bbox={"x": 100, "y": 200, "w": 80, "h": 30}),
            ]),
        ],
    }
    segs_path.write_text(json.dumps(doc))
    result = run(segs_path, out_path)
    assert out_path.exists()
    on_disk = json.loads(out_path.read_text())
    assert on_disk["viewport_w"] == 540
    assert len(on_disk["events"]) == 1
    assert result == on_disk
