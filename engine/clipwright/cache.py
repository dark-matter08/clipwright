"""Canonical content-hashed cache sidecar I/O.

Each per-segment pipeline stage (TTS, captions, segment render) writes a
sidecar JSON next to its output:

    out/segments/<video>/<seg>.mp4
    out/segments/<video>/<seg>.cache.json   ← this file

The sidecar carries:

    {
      "schema_version": 1,
      "input_hash": "<sha256>",
      "produced_at": "<rfc3339 UTC>",
      "tool_version": "<clipwright version>"
    }

`input_hash` is whatever the stage chose as the content key — typically a
SHA-256 over (source path + range + voice + style + camera + …). Re-running
a stage with the same inputs hits the cache and is a no-op.

This module is the *only* place that knows the sidecar shape. Stages call
:func:`read_input_hash` / :func:`write_input_hash` instead of re-implementing
JSON wrangling. Schema upgrades (e.g. adding a `model_version` field) land
here once.

Legacy ``{ "hash": ... }`` sidecars from the v1 CLI helpers (see
``engine/clipwright/cli.py``) use a different shape and are NOT readable via
this module — they have their own private helpers and are scoped to the
v1 legacy commands.
"""
from __future__ import annotations

import datetime
import json
import os
from pathlib import Path

from . import __version__

SCHEMA_VERSION = 1


def read_input_hash(cache_path: Path) -> str | None:
    """Return the stored ``input_hash`` or ``None`` if the sidecar is
    missing, unreadable, or corrupt.

    A missing sidecar is the common "no cache yet" case — callers treat the
    None return as "must re-run." A *corrupt* sidecar (truncated write,
    foreign JSON) also returns None so the stage re-runs and overwrites it
    cleanly, rather than crashing on a bad file the user can't easily fix.
    """
    if not cache_path.exists():
        return None
    try:
        return json.loads(cache_path.read_text()).get("input_hash")
    except (json.JSONDecodeError, OSError):
        return None


def write_input_hash(cache_path: Path, input_hash: str) -> None:
    """Atomically replace ``cache_path`` with a fresh sidecar for ``input_hash``.

    Writes through a temp file + ``os.replace`` so a SIGKILL or concurrent
    write never leaves a torn sidecar mid-loop. Concurrent ``render-segment``
    invocations targeting the same seg are the realistic case here — without
    atomicity, a Windows reader catches a `PermissionError` mid-write and
    a Unix reader catches a partial-JSON file (handled gracefully but still
    forces an unnecessary re-render).

    ``os.replace`` is atomic on POSIX and on Windows (atomic-rename was
    added in Python 3.3 specifically for this case).
    """
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "input_hash": input_hash,
        "produced_at": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "tool_version": __version__,
    }
    # Suffix with the PID so two parallel writers don't clobber each other's
    # temp file (last-replace-wins is still correct; we just don't want one
    # writer to delete the other's in-flight tmp).
    tmp_path = cache_path.with_suffix(cache_path.suffix + f".tmp-{os.getpid()}")
    tmp_path.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp_path, cache_path)
