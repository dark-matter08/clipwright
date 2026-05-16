"""Canonical cache sidecar I/O — the helpers tts_segment / caption_segment /
render_segment all use to read & write `<output>.cache.json`."""
from __future__ import annotations

import json

from clipwright.cache import read_input_hash, write_input_hash


def test_read_returns_none_when_missing(tmp_path):
    assert read_input_hash(tmp_path / "missing.cache.json") is None


def test_write_then_read_roundtrip(tmp_path):
    path = tmp_path / "seg_001.cache.json"
    write_input_hash(path, "sha256:deadbeef")
    assert read_input_hash(path) == "sha256:deadbeef"


def test_write_creates_parent_dirs(tmp_path):
    """The sidecar lives next to its output — write must mkdir on demand."""
    path = tmp_path / "out" / "segments" / "video" / "seg_001.cache.json"
    write_input_hash(path, "sha256:abc")
    assert path.exists()
    assert read_input_hash(path) == "sha256:abc"


def test_write_includes_full_payload(tmp_path):
    """Sidecar carries schema_version, produced_at, and tool_version
    for forensics / future-proof reads."""
    path = tmp_path / "x.cache.json"
    write_input_hash(path, "sha256:xyz")
    payload = json.loads(path.read_text())
    assert payload["schema_version"] == 1
    assert payload["input_hash"] == "sha256:xyz"
    assert payload["produced_at"]
    assert payload["tool_version"]


def test_read_returns_none_on_corrupt_json(tmp_path):
    """Corrupt sidecar must be treated as a cache miss, not crash."""
    path = tmp_path / "bad.cache.json"
    path.write_text("not json at all {{{")
    assert read_input_hash(path) is None


def test_read_returns_none_when_input_hash_missing(tmp_path):
    """Sidecar with valid JSON but no `input_hash` field is a cache miss."""
    path = tmp_path / "wrong-shape.cache.json"
    path.write_text(json.dumps({"hash": "old-shape"}))  # v1 cli shape, not v2
    assert read_input_hash(path) is None


def test_write_overwrites_existing(tmp_path):
    """Re-writing a sidecar with a new hash replaces the old one."""
    path = tmp_path / "x.cache.json"
    write_input_hash(path, "sha256:first")
    write_input_hash(path, "sha256:second")
    assert read_input_hash(path) == "sha256:second"


def test_write_leaves_no_tmp_files(tmp_path):
    """Atomic-write tmp suffix must be cleaned up after rename."""
    path = tmp_path / "x.cache.json"
    write_input_hash(path, "sha256:abc")
    # Parent dir should contain exactly the final file, no `.tmp-*` siblings.
    siblings = [p.name for p in path.parent.iterdir()]
    assert siblings == ["x.cache.json"], f"unexpected tmp leftovers: {siblings}"
