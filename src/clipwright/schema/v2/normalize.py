"""Auto-normalize v2 projects whose video manifests carry non-conforming ids.

Earlier desktop builds let the user type any string into "+ New video",
including capitals (`Chapter-1-recap`). The strict `[a-z][a-z0-9_-]*`
regex now rejects those manifests on load — leaving the project stuck.

`normalize_v2_video_ids` walks `videos/*.json`, finds files whose stored
`video_id` (or filename stem) doesn't match the regex, sanitizes the id
to a conforming form, and renames in place:

  - rewrites `video_id` inside the manifest
  - renames the file: `videos/Chapter-1.json` → `videos/chapter-1.json`
  - relocates per-video artifact dirs: `voiceover/audio/<old>/` →
    `voiceover/audio/<new>/`, same for captions, out/segments, chat
    sessions, and the per-video script file + final mp4
  - resolves collisions by appending `-2`, `-3`, … to the sanitized id

Idempotent: re-running on an already-normalized project is a no-op.
Safe: if both the old and new locations exist, the new one wins and
the old is left alone (caller can resolve by hand).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .video import VIDEO_ID_RE, sanitize_video_id


@dataclass
class NormalizationReport:
    project_dir: Path
    renames: list[tuple[str, str]]
    """List of `(old_video_id, new_video_id)` pairs that were normalized."""


# Per-video subtrees we relocate when renaming. Each entry is either a
# directory (most) or a parent-of-files (script.json case).
_VIDEO_DIRS = [
    "voiceover/audio",
    "captions",
    "out/segments",
    "chat/sessions",
]


def normalize_v2_video_ids(project_dir: Path) -> NormalizationReport:
    project_dir = Path(project_dir).resolve()
    videos_dir = project_dir / "videos"
    renames: list[tuple[str, str]] = []
    if not videos_dir.exists():
        return NormalizationReport(project_dir, renames)

    for entry in sorted(videos_dir.iterdir()):
        if not entry.is_file() or entry.suffix != ".json":
            continue
        try:
            payload = json.loads(entry.read_text())
        except json.JSONDecodeError:
            continue
        old_id = str(payload.get("video_id") or entry.stem)
        file_stem = entry.stem

        # Conforming and consistent — nothing to do.
        if VIDEO_ID_RE.match(old_id) and file_stem == old_id:
            continue

        new_id = _pick_new_id(old_id, entry, videos_dir)
        if new_id == old_id and entry.stem == new_id:
            continue
        payload["video_id"] = new_id

        # Two-step rename via a unique temp name. macOS APFS is case-
        # insensitive: `Chapter-1.json` and `chapter-1.json` share an
        # inode and `Path.resolve()` collapses them. A naive write to
        # the new name would overwrite content in place while preserving
        # the *old* case on disk. We go through `.normalize-tmp-<id>.json`
        # and unlink the old entry by its exact recorded path so the
        # filesystem actually drops the case-mismatched name before we
        # place the new one.
        #
        # We always reach this block with at least one of (filename case,
        # video_id field) needing to change — the early-return above
        # filters out fully-conforming entries — so the unlink is safe.
        new_path = videos_dir / f"{new_id}.json"
        tmp_path = videos_dir / f".normalize-tmp-{new_id}.json"
        tmp_path.write_text(json.dumps(payload, indent=2) + "\n")
        entry.unlink()
        tmp_path.rename(new_path)

        # Relocate per-video subdirs through the same temp dance.
        for area in _VIDEO_DIRS:
            parent = project_dir / area
            old_sub = parent / old_id
            new_sub = parent / new_id
            if _entry_exists_with_name(parent, old_id) and not _entry_exists_with_name(parent, new_id):
                _case_safe_rename(old_sub, new_sub)

        # Per-video files.
        for old_file, new_file, parent in [
            (project_dir / "voiceover" / "scripts" / f"{old_id}.json",
             project_dir / "voiceover" / "scripts" / f"{new_id}.json",
             project_dir / "voiceover" / "scripts"),
            (project_dir / "out" / "final" / f"{old_id}.mp4",
             project_dir / "out" / "final" / f"{new_id}.mp4",
             project_dir / "out" / "final"),
        ]:
            if _entry_exists_with_name(parent, old_file.name) and not _entry_exists_with_name(parent, new_file.name):
                _case_safe_rename(old_file, new_file)

        renames.append((old_id, new_id))

    if renames:
        _append_migration_log(project_dir, renames)

    return NormalizationReport(project_dir, renames)


def _append_migration_log(
    project_dir: Path, renames: list[tuple[str, str]]
) -> None:
    """Append a JSONL entry per rename to ``.clipwright/migrations.log``.

    Schema healing mutates user data — silently relocating files and rewriting
    manifest fields. The log gives the user (and any future bug report) a
    durable record of what changed and when.

    Best-effort: failures here don't abort the rename, but they shouldn't
    happen in practice — the directory is already used by the rest of
    `.clipwright/` (session ids, permission mode, etc.).
    """
    log_dir = project_dir / ".clipwright"
    log_path = log_dir / "migrations.log"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with log_path.open("a", encoding="utf-8") as f:
            for old, new in renames:
                entry = {
                    "ts": ts,
                    "kind": "video_id_normalize",
                    "old": old,
                    "new": new,
                }
                f.write(json.dumps(entry) + "\n")
    except OSError:
        # Mutating user data silently is exactly the failure mode we wanted
        # to avoid, but a write error here means we already mutated and
        # CAN'T record. Surface to stderr at least — the test harness
        # captures stderr so this still flags in CI.
        import sys
        print(
            f"clipwright: schema heal succeeded but migration log write failed at {log_path}",
            file=sys.stderr,
        )


def _entry_exists_with_name(parent: Path, name: str) -> bool:
    """Case-sensitive existence check inside `parent`.

    `Path.exists()` returns True for either case on case-insensitive FS;
    iterating the directory returns the actual on-disk names so we can
    distinguish "Chapter-X is there" from "chapter-X is there."
    """
    if not parent.exists():
        return False
    try:
        return any(entry.name == name for entry in parent.iterdir())
    except OSError:
        return False


def _case_safe_rename(old: Path, new: Path) -> None:
    """Rename `old` → `new`, handling case-only differences on
    case-insensitive filesystems (macOS APFS, Windows NTFS default).

    `Path.resolve()` does NOT case-canonicalize on case-insensitive FS,
    so a comparison there would miss case-only collisions. Compare
    lowercased names within the same parent dir instead — that catches
    `Foo` → `foo` and forces the rename through a temp name.
    """
    same_parent = str(old.parent) == str(new.parent)
    if same_parent and old.name.lower() == new.name.lower() and old.name != new.name:
        tmp = old.with_name(f".normalize-tmp-{new.name}")
        old.rename(tmp)
        tmp.rename(new)
    else:
        old.rename(new)


def _pick_new_id(old_id: str, entry: Path, videos_dir: Path) -> str:
    """Sanitize `old_id` (or the file stem as fallback) into a
    conforming id that doesn't collide with any *other* file in
    `videos_dir`. Uses directory-listing existence so case-insensitive
    filesystems don't falsely report collisions."""
    base = sanitize_video_id(old_id) or sanitize_video_id(entry.stem) or "video-x"

    def collision(name: str) -> bool:
        # A name collides only if a *different* file with that literal
        # on-disk name already exists. The entry being renamed doesn't
        # count as its own conflict.
        if not _entry_exists_with_name(videos_dir, name):
            return False
        return entry.name != name

    if not collision(f"{base}.json"):
        return base
    i = 2
    while collision(f"{base}-{i}.json"):
        i += 1
    return f"{base}-{i}"
