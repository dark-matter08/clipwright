"""Segment building rules from the 11-step diagram."""
from __future__ import annotations

from clipwright.edit.segments import build_segments


def _m(t: float, type_: str = "click", label: str = "") -> dict:
    return {"t": t, "action": type_, "label": label, "fields": {}}


def test_empty_moments_produces_whole_video():
    segs = build_segments([], 10.0)
    assert len(segs) == 1
    assert segs[0].source_start == 0.0
    assert segs[0].source_end == 10.0


def test_close_moments_merge():
    segs = build_segments([_m(2.0), _m(3.0)], 20.0, lead=0.5, trail=1.0, merge_gap=2.0, split_gap=3.0)
    assert len(segs) == 1
    assert segs[0].source_start == 1.5
    assert len(segs[0].moments) == 2


def test_far_moments_produce_separate_segments():
    # Moments 5s apart — gap 4s > merge_gap 2s → separate.
    segs = build_segments([_m(2.0), _m(7.0)], 20.0, lead=0.5, trail=1.0, merge_gap=2.0, split_gap=3.0)
    assert len(segs) == 2


def test_internal_split_on_long_gap():
    segs = build_segments([_m(2.0), _m(3.0), _m(7.0), _m(8.0)], 20.0,
                          lead=0.5, trail=1.0, merge_gap=2.0, split_gap=3.0)
    assert len(segs) == 2
    assert len(segs[0].moments) == 2
    assert len(segs[1].moments) == 2


def test_final_tail_added():
    segs = build_segments([_m(2.0)], 20.0, lead=0.5, trail=1.0, final_tail=1.0)
    # window = [1.5, 3.0] + 1s tail = 4.0
    assert abs(segs[-1].source_end - 4.0) < 1e-6


def test_chapter_groups_override_timing():
    # Two chapters with a huge internal gap — stays as two chapters, not four segments.
    moments = [
        {"t": 1.0, "action": "click", "label": "", "chapter": "library"},
        {"t": 30.0, "action": "click", "label": "", "chapter": "library"},
        {"t": 60.0, "action": "click", "label": "", "chapter": "reader"},
        {"t": 62.0, "action": "click", "label": "", "chapter": "reader"},
    ]
    segs = build_segments(moments, 100.0)
    assert len(segs) == 2
    assert segs[0].chapter == "library"
    assert segs[1].chapter == "reader"
    assert len(segs[0].moments) == 2
    assert len(segs[1].moments) == 2


def test_preserves_moment_type_and_label():
    segs = build_segments([_m(2.0, type_="type", label="Search shows")], 10.0)
    m = segs[0].moments[0]
    assert m.type == "type"
    assert m.label == "Search shows"
