"""Migrate legacy single-video project layout to multi-video layout.

Legacy (v1):

    <project>/
        .clipwright.json
        browse-plan.json
        demo.py
        script.json
        out/...

New (v2):

    <project>/
        .clipwright.json        # unchanged
        videos/
            main/
                video.json
                browse-plan.json
                demo.py
                script.json
                out/...
        .migration              # breadcrumb
"""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from . import config as cfg_mod

LEGACY_MOVE_NAMES: tuple[str, ...] = (
    "browse-plan.json",
    "demo.py",
    "script.json",
    "beat_map.json",
    "out",
)


def is_legacy(root: Path) -> bool:
    """True if the project has the v1 layout and hasn't been migrated."""
    if not (root / cfg_mod.CONFIG_NAME).exists():
        return False
    if (root / cfg_mod.VIDEOS_DIR).is_dir() and any((root / cfg_mod.VIDEOS_DIR).iterdir()):
        return False
    return any((root / n).exists() for n in LEGACY_MOVE_NAMES)


def plan(root: Path, slug: str = "main") -> list[tuple[Path, Path]]:
    """Return the planned `(src, dst)` mv list for dry-run display."""
    dst_root = root / cfg_mod.VIDEOS_DIR / slug
    moves = []
    for name in LEGACY_MOVE_NAMES:
        src = root / name
        if src.exists():
            moves.append((src, dst_root / name))
    return moves


def run(root: Path, slug: str = "main", dry_run: bool = False) -> list[tuple[Path, Path]]:
    """Perform the migration. Returns the list of moves that (would have) happened."""
    if not is_legacy(root):
        return []
    moves = plan(root, slug)
    if dry_run:
        return moves

    dst_root = root / cfg_mod.VIDEOS_DIR / slug
    dst_root.mkdir(parents=True, exist_ok=True)

    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)

    pcfg = cfg_mod.load(root)
    vcfg = cfg_mod.VideoConfig(slug=slug, title=pcfg.name or slug)
    cfg_mod.write_video(root, vcfg)

    (root / ".migration").write_text(
        json.dumps(
            {
                "version": 2,
                "migrated_at": datetime.now(timezone.utc).isoformat(),
                "slug": slug,
                "moved": [str(d.relative_to(root)) for _, d in moves],
                "project_cfg_snapshot": asdict(pcfg),
            },
            indent=2,
        )
        + "\n"
    )
    return moves


def ensure_migrated(root: Path) -> bool:
    """Idempotent: migrate if legacy, else no-op. Returns True if work happened."""
    if is_legacy(root):
        run(root)
        return True
    return False
