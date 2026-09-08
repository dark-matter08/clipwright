"""Portable font resolution.

Order of precedence:
1. Explicit path passed in (if it exists)
2. Bundled font at <repo>/templates/fonts/DejaVuSans.ttf
3. First existing system font from FALLBACKS

Install.sh fetches DejaVu into templates/fonts/ during setup. If the user clones
the repo manually without running install.sh, we fall back to the system list.
"""
from __future__ import annotations

from pathlib import Path

_BUNDLED_DIR = Path(__file__).resolve().parent.parent.parent / "templates" / "fonts"

_FALLBACKS = [
    # macOS
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    # Windows (WSL, etc.)
    "/mnt/c/Windows/Fonts/arial.ttf",
]


def resolve(preferred: str | Path | None = None, *, bold: bool = False) -> str:
    """Return an existing font path, preferring the caller's choice then bundled, then system."""
    if preferred:
        p = Path(preferred)
        if p.exists():
            return str(p)

    bundled_name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    bundled = _BUNDLED_DIR / bundled_name
    if bundled.exists():
        return str(bundled)
    # If bold requested but only regular bundled, accept regular.
    if bold:
        regular = _BUNDLED_DIR / "DejaVuSans.ttf"
        if regular.exists():
            return str(regular)

    for candidate in _FALLBACKS:
        if Path(candidate).exists():
            return candidate

    raise FileNotFoundError(
        "No usable font found. Run install.sh to fetch DejaVuSans into templates/fonts/, "
        "or set font_path in your caption/outro config."
    )
