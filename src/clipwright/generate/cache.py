"""Generation cache — mirrors the TTS cache pattern from Move 1.

Cache key = SHA-256 of (prompt, image_ref_hashes, seed, duration,
provider, model_version, slot).

Sidecar format: <out>.cache.json
  { "hash": "<sha256>", "provider": "veo", "slot": "intro" }

Re-running generation with unchanged inputs hits the cache and costs $0.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def _file_hash(p: Path) -> str:
    """SHA-256 of a file's contents (for image reference hashing)."""
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_hash(
    *,
    prompt: str,
    image_refs: list[Path],
    seed: int | None,
    duration: float,
    provider: str,
    model_version: str,
    slot: str,
) -> str:
    """Deterministic hash of all generation inputs."""
    parts: list[Any] = [
        prompt,
        sorted(_file_hash(p) for p in image_refs if p.exists()),
        seed,
        round(duration, 3),
        provider,
        model_version,
        slot,
    ]
    raw = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _sidecar(out: Path) -> Path:
    return out.with_suffix(out.suffix + ".cache.json")


def read_cache(out: Path) -> str | None:
    """Return the stored hash for `out`, or None if not present / corrupt."""
    sc = _sidecar(out)
    if not sc.exists():
        return None
    try:
        return json.loads(sc.read_text()).get("hash")
    except Exception:  # noqa: BLE001
        return None


def write_cache(out: Path, h: str, provider: str, slot: str) -> None:
    _sidecar(out).write_text(json.dumps({"hash": h, "provider": provider, "slot": slot}))


def is_cached(out: Path, h: str) -> bool:
    """Return True iff `out` exists and its cache hash matches `h`."""
    return out.exists() and read_cache(out) == h
