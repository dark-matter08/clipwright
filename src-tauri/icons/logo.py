#!/usr/bin/env python3
"""Generate the Clipwright Studio app icon.

Run from the repo root:

    python src-tauri/icons/logo.py            # writes logo.png (1024px)
    bun tauri icon src-tauri/icons/logo.png   # expands to every platform size

The mark is the app's own subject: three timeline lanes with the middle
one selected, crossed by a playhead. It's drawn rather than hand-authored
as SVG so the small sizes can be tuned numerically — an app icon is read
at 32px in the dock far more often than at 1024px, and shapes that look
balanced large go muddy small.

Design constraints come from DESIGN.md: geometric, no gradients, no soft
shadows, the cyan accent as the only expressive hue. Colors are the dark
theme's own tokens so the icon and the app agree.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

# Dark-theme tokens from src/styles/tokens.css, resolved to RGB.
BG = (12, 14, 17)          # --surface-base   216 16%  6%
LANE = (42, 49, 57)        # muted lane, ~ --surface-raised lifted
ACCENT = (20, 219, 250)    # --accent         188 96% 53%
EDGE = (28, 34, 41)        # hairline so the icon reads on black docks

# Supersample, then downsample once — Pillow has no built-in AA for
# rectangles, and 4x is enough that the rounded corners stay clean at 32px.
SCALE = 4
SIZE = 1024


def draw_icon(size: int) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # macOS does not round app icons for you, so the squircle is ours to
    # draw. 22% matches the platform's own corner ratio closely enough
    # that it doesn't read as a foreign shape in the dock.
    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, outline=EDGE, width=max(1, int(s * 0.004)))

    # Three lanes of clips. Widths and offsets differ because real
    # timelines are ragged — three equal bars read as a hamburger menu,
    # which is the failure mode of every "list of rectangles" icon.
    # Corner radius stays small: DESIGN.md rejects rounded-everything,
    # and pill shapes read as toggles rather than clips.
    lane_h = int(s * 0.135)
    gap = int(s * 0.075)
    total_h = lane_h * 3 + gap * 2
    top = (s - total_h) // 2
    clip_r = int(lane_h * 0.20)

    # (x0, x1) as fractions of the canvas. One clip per lane, of unequal
    # width — an earlier pass cut each lane into two pieces, which looked
    # right at 1024px and turned to mush at 32. Three shapes is the most
    # this canvas holds while staying legible in a dock.
    lanes = [
        ((0.155, 0.585), LANE),
        ((0.155, 0.845), ACCENT),   # the selected clip
        ((0.155, 0.480), LANE),
    ]
    for i, ((x0, x1), color) in enumerate(lanes):
        y = top + i * (lane_h + gap)
        d.rounded_rectangle(
            [int(s * x0), y, int(s * x1), y + lane_h], radius=clip_r, fill=color
        )

    # Playhead — crosses every lane, which is the thing that makes this
    # read as a timeline instead of a list. It runs over the clips, in
    # the foreground, exactly as it does in the app.
    ph_x = int(s * 0.675)
    ph_w = max(2, int(s * 0.042))
    ph_top = top - int(s * 0.105)
    ph_bot = top + total_h + int(s * 0.075)
    # A dark casing separates the playhead from the clip it crosses. It
    # has to be thin — at 3x the line width it read as a *gap cut into*
    # the accent lane rather than something passing over it.
    case = ph_w + max(2, int(s * 0.020))
    d.rectangle([ph_x - case // 2, ph_top, ph_x + case // 2, ph_bot], fill=BG)
    d.rectangle([ph_x - ph_w // 2, ph_top, ph_x + ph_w // 2, ph_bot], fill=ACCENT)

    # Triangular head — the one non-rectangular element, so the eye has
    # somewhere to land at 32px. Sized generously for the same reason:
    # a delicate head is the first thing lost on downsample.
    head_w = int(s * 0.098)
    head_h = int(s * 0.085)
    d.polygon(
        [
            (ph_x - head_w, ph_top),
            (ph_x + head_w, ph_top),
            (ph_x, ph_top + head_h),
        ],
        fill=ACCENT,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out_dir = Path(__file__).parent
    icon = draw_icon(SIZE)
    icon.save(out_dir / "logo.png")
    print(f"wrote {out_dir / 'logo.png'} ({SIZE}x{SIZE})")

    # Contact sheet at the sizes that actually matter, so a human can
    # eyeball legibility before running `tauri icon`.
    previews = [16, 32, 64, 128, 256]
    sheet_w = sum(previews) + 20 * (len(previews) + 1)
    sheet = Image.new("RGBA", (sheet_w, 256 + 40), (24, 27, 31, 255))
    x = 20
    for p in previews:
        sheet.paste(icon.resize((p, p), Image.LANCZOS), (x, 20 + (256 - p) // 2))
        x += p + 20
    sheet.save(out_dir / "logo-preview.png")
    print(f"wrote {out_dir / 'logo-preview.png'}")


if __name__ == "__main__":
    main()
