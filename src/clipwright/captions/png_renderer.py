"""Render transparent PNG caption frames (one per chunk)."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..fonts import resolve as resolve_font
from .chunker import Chunk


@dataclass
class CaptionStyle:
    width: int = 1080
    height: int = 1920
    font_path: str = ""  # Empty -> use fonts.resolve() (bundled DejaVu or system fallback)
    font_index: int = 0
    font_size: int = 60
    text_rgba: tuple[int, int, int, int] = (255, 255, 255, 255)
    stroke_rgba: tuple[int, int, int, int] = (0, 0, 0, 255)
    stroke_width: int = 4
    pill_rgba: tuple[int, int, int, int] = (0, 0, 0, 180)
    pill_pad_x: int = 36
    pill_pad_y: int = 20
    pill_radius: int = 8
    y_ratio: float = 0.62

    @classmethod
    def from_json(cls, path: Path) -> CaptionStyle:
        data = json.loads(path.read_text())
        for k in ("text_rgba", "stroke_rgba", "pill_rgba"):
            if k in data and isinstance(data[k], list):
                data[k] = tuple(data[k])
        return cls(**data)

    def to_json_dict(self) -> dict:
        return asdict(self)


def render_chunk_png(chunk: Chunk, style: CaptionStyle, out_path: Path) -> Path:
    font_path = style.font_path or resolve_font(bold=True)
    font = ImageFont.truetype(font_path, style.font_size, index=style.font_index)
    img = Image.new("RGBA", (style.width, style.height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bb = d.textbbox((0, 0), chunk.text, font=font, stroke_width=style.stroke_width + 2)
    tw = bb[2] - bb[0]
    th = bb[3] - bb[1]
    x = (style.width - tw) // 2
    y = int(style.height * style.y_ratio)
    d.rounded_rectangle(
        (x - style.pill_pad_x, y - style.pill_pad_y, x + tw + style.pill_pad_x, y + th + style.pill_pad_y),
        radius=style.pill_radius,
        fill=style.pill_rgba,
    )
    d.text(
        (x - bb[0], y - bb[1]),
        chunk.text,
        font=font,
        fill=style.text_rgba,
        stroke_width=style.stroke_width,
        stroke_fill=style.stroke_rgba,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)
    return out_path


def render_all(chunks: list[Chunk], style: CaptionStyle, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i, ch in enumerate(chunks):
        p = out_dir / f"{i:03d}.png"
        render_chunk_png(ch, style, p)
        paths.append(p)
    index_path = out_dir.with_suffix(".json")
    index_path.write_text(
        json.dumps(
            [{"text": c.text, "start": c.start, "end": c.end} for c in chunks],
            indent=2,
        )
    )
    return paths
