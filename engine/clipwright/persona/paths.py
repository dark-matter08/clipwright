"""Where the persona library and its memory live on disk.

User-level, not per-project: a persona is reusable across every project,
so it can't live inside one. Mirrors `credentials.py`'s resolution
(`$CLIPWRIGHT_HOME` → `$XDG_CONFIG_HOME/clipwright` → `~/.clipwright`)
so the whole user-level surface moves together when that's overridden —
which is also what makes the test suite able to point at a tmp dir.

Split by shape, deliberately:

  * Persona *definitions* are JSON documents — hand-editable, diffable,
    trivially copied to clone or shared with someone else.
  * Persona *memory* is a SQLite database — an append-only log that gets
    queried, ranked and joined. A directory of JSON files would make
    "what has this persona learned about pacing?" a full scan.
"""
from __future__ import annotations

import os
from pathlib import Path


def base_dir() -> Path:
    env = os.environ.get("CLIPWRIGHT_HOME")
    if env:
        return Path(env).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser() / "clipwright"
    return Path.home() / ".clipwright"


def personas_dir() -> Path:
    return base_dir() / "personas"


def persona_path(persona_id: str) -> Path:
    return personas_dir() / f"{persona_id}.json"


def memory_db_path() -> Path:
    return base_dir() / "persona-memory.db"
