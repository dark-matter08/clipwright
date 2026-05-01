"""Primary brand color extraction.

Priority order (mirrors Move 9 spec):
  1. <meta name="theme-color"> content attribute.
  2. First CSS custom property on :root that looks like a brand color
     (hue-saturated, not near white/black/grey).
  3. Dominant non-background color from the page screenshot via Pillow.
  4. Fallback: Clipwright default (#1a1a2e).

All results are returned as lowercase hex strings (#rrggbb).
"""
from __future__ import annotations

import colorsys
import re

_HEX_RE = re.compile(r"#([0-9a-fA-F]{3,8})")
_RGB_RE = re.compile(r"rgb[a]?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)")

FALLBACK_COLOR = "#1a1a2e"


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    h = h[:6]
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def _is_brand_worthy(h: str) -> bool:
    """Return True if the color is saturated enough to be a brand color.

    Excludes near-white (lightness > 0.92), near-black (lightness < 0.08),
    and near-grey (saturation < 0.15).
    """
    try:
        r, g, b = hex_to_rgb(h)
        _hue, sat, light = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        return sat > 0.15 and 0.08 < light < 0.92
    except Exception:  # noqa: BLE001
        return False


def parse_css_color(value: str) -> str | None:
    """Parse a CSS color string into a #rrggbb hex. Returns None on failure."""
    value = value.strip().lower()
    m = _HEX_RE.match(value)
    if m:
        try:
            r, g, b = hex_to_rgb(m.group(0))
            return rgb_to_hex(r, g, b)
        except Exception:  # noqa: BLE001
            pass
    m = _RGB_RE.match(value)
    if m:
        return rgb_to_hex(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    # Named colors: only handle the most common brand-adjacent ones.
    named = {
        "white": "#ffffff", "black": "#000000", "red": "#ff0000",
        "blue": "#0000ff", "green": "#008000", "navy": "#001f5b",
    }
    return named.get(value)


def dominant_from_screenshot(png_path: str, *, n_colors: int = 8) -> str | None:
    """Return the most saturated non-background color from a PNG.

    Uses a simple quantize + pick approach via Pillow.
    Returns None if Pillow is not installed or the image can't be read.
    """
    try:
        from PIL import Image  # type: ignore[import-untyped]
    except ImportError:
        return None
    try:
        img = Image.open(png_path).convert("RGB")
        # Downscale for speed.
        img = img.resize((120, 120), Image.LANCZOS)
        quantized = img.quantize(colors=n_colors)
        palette = quantized.getpalette()  # flat R G B R G B ...
        if not palette:
            return None
        best: str | None = None
        best_sat = 0.0
        for i in range(n_colors):
            r, g, b = palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]
            h = rgb_to_hex(r, g, b)
            _hue, sat, _light = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if sat > best_sat and _is_brand_worthy(h):
                best_sat = sat
                best = h
        return best
    except Exception:  # noqa: BLE001
        return None


def pick_brand_color(
    *,
    theme_color: str | None,
    css_vars: list[str],
    screenshot_path: str | None,
) -> str:
    """Choose the best brand color from the available signals in priority order."""
    if theme_color:
        parsed = parse_css_color(theme_color)
        if parsed and _is_brand_worthy(parsed):
            return parsed

    for val in css_vars:
        parsed = parse_css_color(val)
        if parsed and _is_brand_worthy(parsed):
            return parsed

    if screenshot_path:
        dominant = dominant_from_screenshot(screenshot_path)
        if dominant:
            return dominant

    return FALLBACK_COLOR
