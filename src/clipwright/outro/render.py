"""Render a branded outro card to mp4. PIL frames -> ffmpeg encode."""
from __future__ import annotations

import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..ffmpeg import run
from ..fonts import resolve as resolve_font
from .brand import BrandConfig


def ease_out_cubic(t: float) -> float:
    return 1 - (1 - t) ** 3


def _draw_frame(i: int, brand: BrandConfig) -> Image.Image:
    t = i / brand.fps
    W, H = brand.width, brand.height
    img = Image.new("RGB", (W, H), brand.bg_rgb)
    d = ImageDraw.Draw(img, "RGBA")

    if brand.show_grid:
        for y in range(0, H, 40):
            d.line([(0, y), (W, y)], fill=brand.grid_rgb, width=1)
        for x in range(0, W, 40):
            d.line([(x, 0), (x, H)], fill=brand.grid_rgb, width=1)

    if brand.show_brackets:
        alpha = int(255 * min(1.0, t / 0.4))
        L = 60
        pad = 60
        for x, y, dx, dy in [
            (pad, pad, 1, 1),
            (W - pad, pad, -1, 1),
            (pad, H - pad, 1, -1),
            (W - pad, H - pad, -1, -1),
        ]:
            d.line([(x, y), (x + dx * L, y)], fill=(*brand.accent_rgb, alpha), width=3)
            d.line([(x, y), (x, y + dy * L)], fill=(*brand.accent_rgb, alpha), width=3)

    title_path = brand.font_title or resolve_font(bold=True)
    body_path = brand.font_body or resolve_font()
    title_font = ImageFont.truetype(title_path, brand.font_title_size, index=brand.font_title_index)
    body_font = ImageFont.truetype(body_path, brand.font_body_size, index=brand.font_body_index)
    small_font = ImageFont.truetype(body_path, brand.font_small_size, index=brand.font_body_index)

    reveal_t = max(0.0, min(1.0, (t - 0.15) / 0.5))
    if reveal_t > 0:
        alpha = int(255 * ease_out_cubic(reveal_t))
        lines = brand.title_lines or [""]
        bboxes = [d.textbbox((0, 0), ln, font=title_font) for ln in lines]
        heights = [b[3] - b[1] for b in bboxes]
        widths = [b[2] - b[0] for b in bboxes]
        gap = 20
        total_h = sum(heights) + gap * (len(lines) - 1)
        y_top = H // 2 - total_h // 2 - 80
        palette = [brand.text_rgb, brand.accent_rgb, brand.secondary_rgb]
        cur_y = y_top
        for idx, ln in enumerate(lines):
            x = (W - widths[idx]) // 2
            color = palette[idx % len(palette)]
            d.text((x, cur_y), ln, font=title_font, fill=(*color, alpha))
            cur_y += heights[idx] + gap

    if t > 0.55:
        e2 = ease_out_cubic(min(1.0, (t - 0.55) / 0.4))
        cx = W // 2
        y_div = H // 2 + 110
        half = int(180 * e2)
        d.line([(cx - half, y_div), (cx + half, y_div)], fill=brand.secondary_rgb, width=2)

    if t > 0.9 and brand.tagline:
        alpha = int(255 * min(1.0, (t - 0.9) / 0.4))
        b = d.textbbox((0, 0), brand.tagline, font=body_font)
        tw = b[2] - b[0]
        d.text(((W - tw) // 2, H // 2 + 160), brand.tagline, font=body_font, fill=(*brand.dim_rgb, alpha))

    if t > 1.2 and brand.url:
        alpha = int(255 * min(1.0, (t - 1.2) / 0.4))
        b = d.textbbox((0, 0), brand.url, font=small_font)
        tw = b[2] - b[0]
        d.text(((W - tw) // 2, H - 180), brand.url, font=small_font, fill=(*brand.accent_rgb, alpha))

    if t > 0.3 and brand.status_pill:
        alpha = int(255 * min(1.0, (t - 0.3) / 0.3))
        b = d.textbbox((0, 0), brand.status_pill, font=small_font)
        tw = b[2] - b[0]
        d.text(((W - tw) // 2, 160), brand.status_pill, font=small_font, fill=(*brand.accent_rgb, alpha))

    return img


def render_outro(brand: BrandConfig, out: Path) -> Path:
    n = int(brand.duration * brand.fps)
    with tempfile.TemporaryDirectory(prefix="clipwright-outro-") as td:
        tdp = Path(td)
        for i in range(n):
            _draw_frame(i, brand).save(tdp / f"f_{i:04d}.png")
        out.parent.mkdir(parents=True, exist_ok=True)
        run(
            [
                "ffmpeg",
                "-y",
                "-framerate",
                str(brand.fps),
                "-i",
                str(tdp / "f_%04d.png"),
                "-f",
                "lavfi",
                "-t",
                f"{brand.duration}",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-r",
                str(brand.fps),
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-shortest",
                str(out),
            ]
        )
    return out
