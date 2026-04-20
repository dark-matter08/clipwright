"""Unit tests for dead-time merging/splitting."""
from __future__ import annotations

from clipwright.edit.trim import compute_ranges


def _ms(*ts: float) -> list[dict]:
    return [{"t": t, "action": "click"} for t in ts]


def test_empty_moments_returns_full_range():
    assert compute_ranges([], 10.0) == [(0.0, 10.0)]


def test_single_action_window():
    r = compute_ranges(_ms(5.0), 30.0, pre_roll=0.5, post_roll=1.0, merge_gap=2.0, split_gap=10.0)
    assert r == [(4.5, 6.0)]


def test_close_actions_merge():
    r = compute_ranges(
        _ms(2.0, 2.5, 3.0),
        30.0,
        pre_roll=0.5,
        post_roll=1.0,
        merge_gap=2.0,
        split_gap=10.0,
    )
    assert r == [(1.5, 4.0)]


def test_far_actions_do_not_merge():
    r = compute_ranges(
        _ms(1.0, 20.0),
        30.0,
        pre_roll=0.5,
        post_roll=1.0,
        merge_gap=2.0,
        split_gap=10.0,
    )
    assert r == [(0.5, 2.0), (19.5, 21.0)]


def test_long_merged_window_is_split():
    moments = _ms(*[t for t in range(0, 40)])
    r = compute_ranges(
        moments,
        50.0,
        pre_roll=0.2,
        post_roll=0.2,
        merge_gap=2.0,
        split_gap=3.0,
    )
    assert len(r) > 1
    for a, b in zip(r, r[1:], strict=False):
        assert a[1] <= b[0] + 1e-9


def test_pre_roll_clamped_to_zero():
    r = compute_ranges(_ms(0.1), 10.0, pre_roll=0.5, post_roll=1.0, merge_gap=2.0, split_gap=10.0)
    assert r[0][0] == 0.0
