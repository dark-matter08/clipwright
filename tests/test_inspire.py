"""Brand color extraction + copy parsing (no network calls)."""
from __future__ import annotations

from clipwright.inspire.color import (
    FALLBACK_COLOR,
    _is_brand_worthy,
    hex_to_rgb,
    parse_css_color,
    pick_brand_color,
    rgb_to_hex,
)

# ── hex_to_rgb / rgb_to_hex round-trip ──────────────────────────────────────

def test_hex_to_rgb_full():
    assert hex_to_rgb("#4f46e5") == (79, 70, 229)


def test_hex_to_rgb_short():
    assert hex_to_rgb("#abc") == (0xaa, 0xbb, 0xcc)


def test_rgb_to_hex_roundtrip():
    assert rgb_to_hex(79, 70, 229) == "#4f46e5"


# ── parse_css_color ──────────────────────────────────────────────────────────

def test_parse_hex():
    assert parse_css_color("#4f46e5") == "#4f46e5"


def test_parse_short_hex():
    result = parse_css_color("#abc")
    assert result == "#aabbcc"


def test_parse_rgb_function():
    result = parse_css_color("rgb(79, 70, 229)")
    assert result == "#4f46e5"


def test_parse_rgba_function():
    # rgba — parse ignores alpha
    result = parse_css_color("rgba(79, 70, 229, 0.9)")
    assert result == "#4f46e5"


def test_parse_unknown_returns_none():
    assert parse_css_color("hsl(240, 80%, 60%)") is None


# ── _is_brand_worthy ─────────────────────────────────────────────────────────

def test_saturated_blue_is_brand_worthy():
    assert _is_brand_worthy("#4f46e5")  # indigo


def test_white_not_brand_worthy():
    assert not _is_brand_worthy("#ffffff")


def test_black_not_brand_worthy():
    assert not _is_brand_worthy("#000000")


def test_light_grey_not_brand_worthy():
    # #e5e7eb is near-white grey (R=G≈B, saturation ≈ 0)
    assert not _is_brand_worthy("#e5e5e5")


def test_near_grey_not_brand_worthy():
    assert not _is_brand_worthy("#888888")


# ── pick_brand_color ─────────────────────────────────────────────────────────

def test_pick_theme_color_first():
    color = pick_brand_color(
        theme_color="#4f46e5",
        css_vars=["#ff0000"],
        screenshot_path=None,
    )
    assert color == "#4f46e5"


def test_pick_css_var_when_no_theme_color():
    color = pick_brand_color(
        theme_color=None,
        css_vars=["#4f46e5"],
        screenshot_path=None,
    )
    assert color == "#4f46e5"


def test_skip_unsaturated_theme_color():
    """Grey theme-color should fall through to css_vars."""
    color = pick_brand_color(
        theme_color="#888888",
        css_vars=["#4f46e5"],
        screenshot_path=None,
    )
    assert color == "#4f46e5"


def test_fallback_when_nothing():
    color = pick_brand_color(
        theme_color=None,
        css_vars=[],
        screenshot_path=None,
    )
    assert color == FALLBACK_COLOR


def test_fallback_when_all_grey():
    color = pick_brand_color(
        theme_color="#cccccc",
        css_vars=["#eeeeee", "#888888"],
        screenshot_path=None,
    )
    assert color == FALLBACK_COLOR


def test_pick_multiple_css_vars_takes_first_worthy():
    color = pick_brand_color(
        theme_color=None,
        css_vars=["#cccccc", "#4f46e5", "#ff0000"],
        screenshot_path=None,
    )
    # #cccccc is not worthy; #4f46e5 is first worthy
    assert color == "#4f46e5"
