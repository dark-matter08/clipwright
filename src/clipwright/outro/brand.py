"""Brand configuration for the outro card. Cyberpunk-restraint defaults."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class BrandConfig:
    title_lines: list[str] = field(default_factory=lambda: ["CLIP", "WRIGHT"])
    tagline: str = "// SHIP THE DEMO."
    url: str = "github.com/DarkMatter/clipwright"
    status_pill: str = "● SYSTEM.ONLINE"
    bg_rgb: tuple[int, int, int] = (8, 12, 22)
    accent_rgb: tuple[int, int, int] = (0, 245, 229)
    secondary_rgb: tuple[int, int, int] = (232, 121, 249)
    text_rgb: tuple[int, int, int] = (230, 240, 250)
    dim_rgb: tuple[int, int, int] = (90, 110, 130)
    grid_rgb: tuple[int, int, int] = (18, 26, 40)
    font_title: str = ""  # Empty -> fonts.resolve(bold=True)
    font_title_index: int = 0
    font_title_size: int = 110
    font_body: str = ""  # Empty -> fonts.resolve()
    font_body_index: int = 0
    font_body_size: int = 32
    font_small_size: int = 24
    width: int = 1080
    height: int = 1920
    fps: int = 60
    duration: float = 2.8
    show_grid: bool = True
    show_brackets: bool = True

    @classmethod
    def from_json(cls, path: Path) -> "BrandConfig":
        data = json.loads(path.read_text())
        for k in ("bg_rgb", "accent_rgb", "secondary_rgb", "text_rgb", "dim_rgb", "grid_rgb"):
            if k in data and isinstance(data[k], list):
                data[k] = tuple(data[k])
        return cls(**data)

    def to_json(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=2))
