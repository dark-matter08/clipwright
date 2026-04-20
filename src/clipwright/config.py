"""Project config loader. JSON-only on purpose: no yaml dependency."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

CONFIG_NAME = ".clipwright.json"

ASPECTS: dict[str, tuple[int, int]] = {
    "9:16": (1080, 1920),
    "16:9": (1920, 1080),
    "1:1": (1080, 1080),
}


@dataclass
class ProjectConfig:
    name: str = "clipwright-project"
    aspect: str = "9:16"
    fps: int = 60
    url: str = "https://example.com"
    demo_script: str = "demo.py"
    voice_script: str = "script.json"
    voice_id: str = "21m00Tcm4TlvDq8ikWAP"
    tts_model: str = "eleven_turbo_v2_5"
    outro_preset: str = "cyberpunk"
    caption_preset: str = "bold-overlay"
    out_dir: str = "out"
    pre_roll: float = 0.5
    post_roll: float = 1.0
    merge_gap: float = 2.0
    split_gap: float = 3.0
    lead: float = 0.4
    tail: float = 0.3
    extra: dict = field(default_factory=dict)

    @property
    def resolution(self) -> tuple[int, int]:
        if self.aspect not in ASPECTS:
            raise ValueError(f"unknown aspect {self.aspect!r}; valid: {list(ASPECTS)}")
        return ASPECTS[self.aspect]

    def resolve_out(self, root: Path) -> Path:
        p = (root / self.out_dir).resolve()
        p.mkdir(parents=True, exist_ok=True)
        return p


def load(root: Path) -> ProjectConfig:
    path = root / CONFIG_NAME
    if not path.exists():
        return ProjectConfig()
    data = json.loads(path.read_text())
    known = {f for f in ProjectConfig.__dataclass_fields__}
    core = {k: v for k, v in data.items() if k in known}
    extra = {k: v for k, v in data.items() if k not in known}
    cfg = ProjectConfig(**core)
    cfg.extra = extra
    return cfg


def write(root: Path, cfg: ProjectConfig) -> Path:
    path = root / CONFIG_NAME
    data = asdict(cfg)
    extra = data.pop("extra", {}) or {}
    data.update(extra)
    path.write_text(json.dumps(data, indent=2) + "\n")
    return path
