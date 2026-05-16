"""GenerateProvider ABC + cache module tests (no network calls)."""
from __future__ import annotations

from clipwright.generate.cache import (
    cache_hash,
    is_cached,
    read_cache,
    write_cache,
)

# ── cache_hash ───────────────────────────────────────────────────────────────

def test_cache_hash_deterministic():
    h1 = cache_hash(prompt="foo", image_refs=[], seed=42, duration=3.0,
                    provider="veo", model_version="veo-001", slot="intro")
    h2 = cache_hash(prompt="foo", image_refs=[], seed=42, duration=3.0,
                    provider="veo", model_version="veo-001", slot="intro")
    assert h1 == h2


def test_cache_hash_changes_on_prompt(tmp_path):
    kwargs = dict(image_refs=[], seed=None, duration=3.0,
                  provider="veo", model_version="veo-001", slot="intro")
    h1 = cache_hash(prompt="a", **kwargs)
    h2 = cache_hash(prompt="b", **kwargs)
    assert h1 != h2


def test_cache_hash_changes_on_provider():
    kwargs = dict(prompt="p", image_refs=[], seed=None, duration=3.0,
                  model_version="veo-001", slot="intro")
    assert cache_hash(provider="veo", **kwargs) != cache_hash(provider="runway", **kwargs)


def test_cache_hash_changes_on_slot():
    kwargs = dict(prompt="p", image_refs=[], seed=None, duration=3.0,
                  provider="veo", model_version="veo-001")
    assert cache_hash(slot="intro", **kwargs) != cache_hash(slot="outro", **kwargs)


def test_cache_hash_includes_image_file(tmp_path):
    """Cache hash must change when the image reference file changes."""
    img = tmp_path / "hero.png"
    img.write_bytes(b"v1")
    h1 = cache_hash(prompt="p", image_refs=[img], seed=None, duration=3.0,
                    provider="veo", model_version="veo-001", slot="intro")
    img.write_bytes(b"v2")
    h2 = cache_hash(prompt="p", image_refs=[img], seed=None, duration=3.0,
                    provider="veo", model_version="veo-001", slot="intro")
    assert h1 != h2


# ── write_cache / read_cache ─────────────────────────────────────────────────

def test_write_and_read_cache(tmp_path):
    out = tmp_path / "intro.mp4"
    out.write_bytes(b"fake video")
    write_cache(out, "abc123", "veo", "intro")
    assert read_cache(out) == "abc123"


def test_read_cache_missing_returns_none(tmp_path):
    out = tmp_path / "intro.mp4"
    assert read_cache(out) is None


def test_read_cache_corrupt_returns_none(tmp_path):
    out = tmp_path / "intro.mp4"
    out.write_bytes(b"fake")
    (out.with_suffix(out.suffix + ".cache.json")).write_text("not-json{{")
    assert read_cache(out) is None


# ── is_cached ────────────────────────────────────────────────────────────────

def test_is_cached_true(tmp_path):
    out = tmp_path / "intro.mp4"
    out.write_bytes(b"ok")
    write_cache(out, "deadbeef", "veo", "intro")
    assert is_cached(out, "deadbeef")


def test_is_cached_false_wrong_hash(tmp_path):
    out = tmp_path / "intro.mp4"
    out.write_bytes(b"ok")
    write_cache(out, "aaa", "veo", "intro")
    assert not is_cached(out, "bbb")


def test_is_cached_false_file_missing(tmp_path):
    out = tmp_path / "intro.mp4"
    assert not is_cached(out, "anyhash")


# ── get_provider ─────────────────────────────────────────────────────────────

def test_get_provider_veo():
    from clipwright.generate.base import get_provider
    prov = get_provider("veo")
    assert prov.name == "veo"


def test_get_provider_runway():
    from clipwright.generate.base import get_provider
    prov = get_provider("runway")
    assert prov.name == "runway"


def test_get_provider_dalle():
    from clipwright.generate.base import get_provider
    prov = get_provider("dalle")
    assert prov.name == "dalle"


def test_get_provider_unknown_raises():
    import pytest

    from clipwright.errors import ClipwrightError
    from clipwright.generate.base import get_provider
    with pytest.raises(ClipwrightError, match="unknown_provider_xyz"):
        get_provider("unknown_provider_xyz")


# ── validate_env (no-key) ────────────────────────────────────────────────────

def test_veo_validate_env_raises_without_key(monkeypatch):
    import pytest
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    from clipwright.errors import ClipwrightError
    from clipwright.generate.veo import VeoProvider
    with pytest.raises(ClipwrightError, match="GOOGLE_CLOUD_PROJECT"):
        VeoProvider().validate_env()


def test_runway_validate_env_raises_without_key(monkeypatch):
    import pytest
    monkeypatch.delenv("RUNWAYML_API_KEY", raising=False)
    from clipwright.errors import ClipwrightError
    from clipwright.generate.runway import RunwayProvider
    with pytest.raises(ClipwrightError, match="RUNWAYML_API_KEY"):
        RunwayProvider().validate_env()


def test_dalle_validate_env_raises_without_key(monkeypatch):
    import pytest
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    from clipwright.errors import ClipwrightError
    from clipwright.generate.dalle import DalleProvider
    with pytest.raises(ClipwrightError, match="OPENAI_API_KEY"):
        DalleProvider().validate_env()
