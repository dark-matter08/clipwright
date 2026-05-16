"""Tests for the per-clip TTS and caption caching helpers in cli.py."""
from __future__ import annotations

import json

from clipwright.cli import _cache_hash, _read_cache, _write_cache


def test_cache_hash_is_deterministic():
    h1 = _cache_hash("hello world", "voice-abc", "kokoro", "12.5")
    h2 = _cache_hash("hello world", "voice-abc", "kokoro", "12.5")
    assert h1 == h2


def test_cache_hash_differs_on_text_change():
    h1 = _cache_hash("hello world", "v", "kokoro", "")
    h2 = _cache_hash("hello world!", "v", "kokoro", "")
    assert h1 != h2


def test_cache_hash_differs_on_provider_change():
    h1 = _cache_hash("text", "v", "kokoro", "10.0")
    h2 = _cache_hash("text", "v", "elevenlabs", "10.0")
    assert h1 != h2


def test_write_and_read_cache(tmp_path):
    f = tmp_path / "clip.cache.json"
    h = _cache_hash("the quick brown fox", "voice", "piper", "8.0")
    _write_cache(f, h)
    assert f.exists()
    assert json.loads(f.read_text()) == {"hash": h}
    assert _read_cache(f) == h


def test_read_cache_missing_file(tmp_path):
    assert _read_cache(tmp_path / "nonexistent.json") is None


def test_read_cache_corrupt_file(tmp_path):
    f = tmp_path / "bad.json"
    f.write_text("not json at all }{")
    assert _read_cache(f) is None


def test_cache_miss_on_stale_hash(tmp_path):
    f = tmp_path / "clip.cache.json"
    _write_cache(f, "old-hash")
    current = _cache_hash("new text", "v", "kokoro", "")
    assert _read_cache(f) != current
