"""Project + video config loaders. JSON-only on purpose: no yaml dependency.

Layout (v2, multi-video):

    <project>/
        .clipwright.json            # ProjectConfig
        videos/
            <slug>/
                video.json          # VideoConfig (overrides)
                browse-plan.json
                script.json
                out/
                    ...

Resolving "which config applies to stage X for video Y" is a two-step merge:
load the project config, then overlay any non-None fields from the video
config. `resolve(root, slug)` returns a fully-merged `ProjectConfig` ready to
hand to a pipeline stage — callers don't need to know the merge happened.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Optional

CONFIG_NAME = ".clipwright.json"
VIDEO_CONFIG_NAME = "video.json"
VIDEOS_DIR = "videos"

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
    tts_provider: str = "kokoro"
    voice_id: str = ""
    tts_model: str = "eleven_turbo_v2_5"
    outro_preset: str = "cyberpunk"
    caption_preset: str = "bold-overlay"
    out_dir: str = "out"
    pre_roll: float = 0.8
    post_roll: float = 2.0
    merge_gap: float = 5.0
    split_gap: float = 15.0
    lead: float = 0.4
    tail: float = 0.3
    mobile: bool = False
    user_agent: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def resolution(self) -> tuple[int, int]:
        if self.aspect not in ASPECTS:
            raise ValueError(f"unknown aspect {self.aspect!r}; valid: {list(ASPECTS)}")
        return ASPECTS[self.aspect]


@dataclass
class VideoConfig:
    """Per-video overrides. Any None/empty field falls back to ProjectConfig."""
    slug: str = "main"
    title: str = ""
    aspect: Optional[str] = None
    target_duration: Optional[float] = None
    template: Optional[str] = None
    notes: str = ""
    extra: dict = field(default_factory=dict)


# ---------- project-level I/O ----------

def load(root: Path) -> ProjectConfig:
    path = root / CONFIG_NAME
    if not path.exists():
        return ProjectConfig()
    data = json.loads(path.read_text())
    known = {f.name for f in fields(ProjectConfig)}
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


# ---------- video-level I/O ----------

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "untitled"


def videos_root(root: Path) -> Path:
    return root / VIDEOS_DIR


def video_root(root: Path, slug: str) -> Path:
    return root / VIDEOS_DIR / slug


def resolve_video_out(root: Path, slug: str) -> Path:
    out = video_root(root, slug) / "out"
    out.mkdir(parents=True, exist_ok=True)
    return out


def list_video_slugs(root: Path) -> list[str]:
    vroot = videos_root(root)
    if not vroot.is_dir():
        return []
    slugs = []
    for child in sorted(vroot.iterdir()):
        if not child.is_dir():
            continue
        if not (child / VIDEO_CONFIG_NAME).exists() and not (child / "browse-plan.json").exists():
            continue
        slugs.append(child.name)
    return slugs


def load_video(root: Path, slug: str) -> VideoConfig:
    path = video_root(root, slug) / VIDEO_CONFIG_NAME
    if not path.exists():
        return VideoConfig(slug=slug, title=slug)
    data = json.loads(path.read_text())
    known = {f.name for f in fields(VideoConfig)}
    core = {k: v for k, v in data.items() if k in known}
    extra = {k: v for k, v in data.items() if k not in known}
    core.setdefault("slug", slug)
    core.setdefault("title", slug)
    vc = VideoConfig(**core)
    vc.extra = extra
    return vc


def write_video(root: Path, vcfg: VideoConfig) -> Path:
    path = video_root(root, vcfg.slug) / VIDEO_CONFIG_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    data = asdict(vcfg)
    extra = data.pop("extra", {}) or {}
    data.update(extra)
    path.write_text(json.dumps(data, indent=2) + "\n")
    return path


def list_videos(root: Path) -> list[VideoConfig]:
    return [load_video(root, s) for s in list_video_slugs(root)]


# ---------- merging ----------

def _merge(pcfg: ProjectConfig, vcfg: VideoConfig) -> ProjectConfig:
    """Return a *new* ProjectConfig with video overrides applied."""
    merged = ProjectConfig(**{f.name: getattr(pcfg, f.name) for f in fields(ProjectConfig)})
    if vcfg.aspect:
        merged.aspect = vcfg.aspect
    if vcfg.template:
        merged.extra = {**merged.extra, "template": vcfg.template}
    if vcfg.target_duration is not None:
        merged.extra = {**merged.extra, "target_duration": vcfg.target_duration}
    return merged


# ---------- resolution entry point ----------

@dataclass
class Resolved:
    project_root: Path
    project_cfg: ProjectConfig   # already merged with video overrides
    video_cfg: VideoConfig
    video_root: Path
    out_dir: Path
    browse_plan: Path
    script: Path


def pick_slug(root: Path, requested: Optional[str]) -> str:
    slugs = list_video_slugs(root)
    if requested:
        if requested not in slugs:
            raise FileNotFoundError(
                f"video {requested!r} not found under {root / VIDEOS_DIR}. "
                f"Available: {', '.join(slugs) or '(none; run `clipwright video new <slug>`)'}"
            )
        return requested
    if len(slugs) == 0:
        raise FileNotFoundError(
            f"no videos in {root / VIDEOS_DIR}. Run `clipwright video new <slug>`."
        )
    if len(slugs) > 1:
        raise ValueError(
            f"project has {len(slugs)} videos — specify --video <slug>. "
            f"Available: {', '.join(slugs)}"
        )
    return slugs[0]


def resolve(root: Path, slug: Optional[str] = None) -> Resolved:
    """One-shot resolution for any pipeline stage."""
    pcfg = load(root)
    chosen = pick_slug(root, slug)
    vcfg = load_video(root, chosen)
    vroot = video_root(root, chosen)
    merged = _merge(pcfg, vcfg)
    out = resolve_video_out(root, chosen)
    return Resolved(
        project_root=root,
        project_cfg=merged,
        video_cfg=vcfg,
        video_root=vroot,
        out_dir=out,
        browse_plan=vroot / "browse-plan.json",
        script=vroot / merged.voice_script,
    )
