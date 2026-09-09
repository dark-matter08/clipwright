"""Tests for the OpenAI TTS backend and voice sampling.

No network. `_request_audio` is monkeypatched to return canned bytes, and
the aligner is stubbed — we're testing the wiring (key resolution, voice
validation, error surfacing, sample caching), not OpenAI's audio or
Whisper's timings.
"""
from __future__ import annotations

import json
import urllib.error
from pathlib import Path

import pytest

from clipwright.errors import ClipwrightError
from clipwright.tts import PROVIDERS, get_provider
from clipwright.tts import openai as openai_tts
from clipwright.tts.base import Word

FAKE_MP3 = b"ID3\x04\x00" + b"\x00" * 512


def test_openai_is_registered() -> None:
    """The schema, CLI help and desktop voice picker all offered
    `openai` while the registry didn't — selecting it failed at
    synthesis time. Pin that it resolves."""
    assert "openai" in PROVIDERS
    assert get_provider("openai").name == "openai"


def test_synthesize_audio_writes_mp3(tmp_path: Path, monkeypatch) -> None:
    seen: dict = {}

    def fake_request(text, *, voice, api_key, model, instructions, response_format="mp3"):
        seen.update(text=text, voice=voice, api_key=api_key, model=model)
        return FAKE_MP3

    monkeypatch.setattr(openai_tts, "_request_audio", fake_request)
    out = tmp_path / "nested" / "sample.mp3"
    openai_tts.synthesize_audio("Hello there.", out, voice="onyx", api_key="sk-test")

    assert out.read_bytes() == FAKE_MP3
    assert seen["voice"] == "onyx"
    assert seen["api_key"] == "sk-test"
    assert seen["model"] == openai_tts.DEFAULT_MODEL


def test_synthesize_audio_skips_alignment(tmp_path: Path, monkeypatch) -> None:
    """The preview path must not align at all — that's what keeps
    auditioning a voice a single round-trip."""
    monkeypatch.setattr(
        openai_tts, "_request_audio", lambda *a, **k: FAKE_MP3
    )

    def explode(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("preview path must not align")

    monkeypatch.setattr(openai_tts, "align_via_api", explode)
    openai_tts.synthesize_audio("Hi.", tmp_path / "a.mp3", api_key="sk-test")


def test_synthesize_writes_alignment(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(openai_tts, "_request_audio", lambda *a, **k: FAKE_MP3)
    monkeypatch.setattr(
        openai_tts,
        "align_via_api",
        lambda _p, **_k: [Word("Hi", 0.0, 0.4), Word("there", 0.4, 1.0)],
    )
    mp3 = tmp_path / "a.mp3"
    ts = tmp_path / "a.json"
    openai_tts.synthesize("Hi there", mp3, ts, voice="nova", api_key="sk-test")

    payload = json.loads(ts.read_text())
    # The ElevenLabs-shaped alignment is what the caption chunker reads;
    # every provider has to emit it or captions break downstream.
    assert set(payload) == {
        "characters",
        "character_start_times_seconds",
        "character_end_times_seconds",
    }
    assert "".join(payload["characters"]) == "Hi there"


def test_unknown_voice_fails_locally(tmp_path: Path, monkeypatch) -> None:
    """Catching a bad voice before the request beats a 400 mid-render."""
    def explode(*_a, **_k):  # pragma: no cover - must never run
        raise AssertionError("should not reach the network")

    monkeypatch.setattr(openai_tts, "_request_audio", explode)
    with pytest.raises(RuntimeError, match="unknown OpenAI voice"):
        openai_tts.synthesize_audio(
            "x", tmp_path / "a.mp3", voice="morgan-freeman", api_key="sk-test"
        )


def test_missing_key_names_where_to_set_it(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(openai_tts, "_request_audio", lambda *a, **k: FAKE_MP3)
    monkeypatch.setattr("clipwright.credentials.get_openai_api_key", lambda: "")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="API keys|OPENAI_API_KEY"):
        openai_tts.synthesize_audio("x", tmp_path / "a.mp3")


def test_http_error_surfaces_api_message(tmp_path: Path, monkeypatch) -> None:
    """`HTTP Error 401` alone doesn't tell you the key expired."""
    import io

    def raise_http(req, *a, **k):
        raise urllib.error.HTTPError(
            openai_tts.ENDPOINT,
            401,
            "Unauthorized",
            {},
            io.BytesIO(json.dumps({"error": {"message": "Incorrect API key"}}).encode()),
        )

    monkeypatch.setattr(openai_tts.urllib.request, "urlopen", raise_http)
    with pytest.raises(RuntimeError, match="Incorrect API key"):
        openai_tts.synthesize_audio("x", tmp_path / "a.mp3", api_key="sk-bad")


# ---------------------------------------------------------------------------
# Voice sampling
# ---------------------------------------------------------------------------


def test_sample_is_cached_by_provider_voice_text(tmp_path: Path, monkeypatch) -> None:
    """Re-auditioning a voice must not re-bill a paid API."""
    from clipwright import tts_sample

    monkeypatch.setattr(tts_sample, "sample_cache_dir", lambda: tmp_path / "cache")
    calls = {"n": 0}

    class FakeProvider:
        name = "openai"

        def synthesize_audio(self, text, out_mp3, *, voice=None):
            calls["n"] += 1
            out_mp3.parent.mkdir(parents=True, exist_ok=True)
            out_mp3.write_bytes(FAKE_MP3)

    monkeypatch.setattr(tts_sample, "get_provider", lambda _n: FakeProvider())

    first = tts_sample.synthesize_sample("openai", "onyx")
    second = tts_sample.synthesize_sample("openai", "onyx")
    assert first == second
    assert calls["n"] == 1, "second audition should be a cache hit"

    # A different voice is a different sample.
    tts_sample.synthesize_sample("openai", "nova")
    assert calls["n"] == 2

    # …and --force re-synthesizes the same one.
    tts_sample.synthesize_sample("openai", "onyx", force=True)
    assert calls["n"] == 3


def test_sample_falls_back_for_providers_without_audio_only(
    tmp_path: Path, monkeypatch
) -> None:
    """Kokoro and Piper only expose the full path; the timings they
    produce are a byproduct we discard rather than a reason to fail."""
    from clipwright import tts_sample

    monkeypatch.setattr(tts_sample, "sample_cache_dir", lambda: tmp_path / "cache")

    class FullOnlyProvider:
        name = "kokoro"

        def synthesize(self, text, out_mp3, out_timestamps, *, voice=None):
            out_mp3.parent.mkdir(parents=True, exist_ok=True)
            out_mp3.write_bytes(FAKE_MP3)
            out_timestamps.write_text("{}")

    monkeypatch.setattr(tts_sample, "get_provider", lambda _n: FullOnlyProvider())
    out = tts_sample.synthesize_sample("kokoro", "af_heart")
    assert out.exists() and out.read_bytes() == FAKE_MP3


def test_sample_rejects_unknown_provider() -> None:
    from clipwright import tts_sample

    with pytest.raises(ClipwrightError, match="unknown TTS provider"):
        tts_sample.synthesize_sample("acme-voices", "bob")


def test_failed_sample_is_not_cached(tmp_path: Path, monkeypatch) -> None:
    """A half-written file would be served as a good sample forever."""
    from clipwright import tts_sample

    monkeypatch.setattr(tts_sample, "sample_cache_dir", lambda: tmp_path / "cache")

    class BrokenProvider:
        name = "openai"

        def synthesize_audio(self, text, out_mp3, *, voice=None):
            out_mp3.parent.mkdir(parents=True, exist_ok=True)
            out_mp3.write_bytes(b"")  # partial write, then failure
            raise RuntimeError("network died")

    monkeypatch.setattr(tts_sample, "get_provider", lambda _n: BrokenProvider())
    with pytest.raises(ClipwrightError, match="could not synthesize"):
        tts_sample.synthesize_sample("openai", "onyx")
    assert not tts_sample.sample_path("openai", "onyx", tts_sample.DEFAULT_SAMPLE_TEXT).exists()


def test_ui_voice_catalog_matches_the_backend() -> None:
    """The desktop's voice list and the backend's must agree.

    They didn't: the catalog shipped the original six voices while the
    API (and `VOICES`) had eleven, so ash/ballad/coral/sage/verse were
    unreachable from the app. The reverse drift is worse — a voice
    offered in the picker that `_resolve_voice` rejects fails at
    synthesis, after the user has committed it to a project.
    """
    import re

    catalog = Path(__file__).resolve().parent.parent / "src" / "lib" / "voiceCatalog.ts"
    assert catalog.exists(), f"voice catalog not found at {catalog}"

    block = catalog.read_text().split("openai: [", 1)[1].split("],", 1)[0]
    ui_voices = set(re.findall(r'value:\s*"([^"]+)"', block))
    assert ui_voices == set(openai_tts.VOICES), (
        "desktop voice catalog is out of step with clipwright.tts.openai.VOICES.\n"
        f"  only in UI:      {sorted(ui_voices - set(openai_tts.VOICES))}\n"
        f"  only in backend: {sorted(set(openai_tts.VOICES) - ui_voices)}"
    )


def test_alignment_falls_back_to_local_when_the_api_fails(
    tmp_path: Path, monkeypatch
) -> None:
    """A network blip on the second call shouldn't lose a synthesis the
    user already paid for."""
    monkeypatch.setattr(openai_tts, "_request_audio", lambda *a, **k: FAKE_MP3)

    def api_down(*_a, **_k):
        raise RuntimeError("transcription unavailable")

    monkeypatch.setattr(openai_tts, "align_via_api", api_down)
    monkeypatch.setattr(
        "clipwright.tts.align.align_with_whisper",
        lambda _p, _t: [Word("Hi", 0.0, 0.5)],
    )
    ts = tmp_path / "a.json"
    openai_tts.synthesize("Hi", tmp_path / "a.mp3", ts, api_key="sk-test")
    assert "characters" in json.loads(ts.read_text())


def test_alignment_failure_names_both_causes(tmp_path: Path, monkeypatch) -> None:
    """When both paths are gone, say so — a bare 'alignment failed'
    sends you looking at the wrong one."""
    monkeypatch.setattr(openai_tts, "_request_audio", lambda *a, **k: FAKE_MP3)
    monkeypatch.setattr(
        openai_tts, "align_via_api", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("api down"))
    )
    monkeypatch.setattr(
        "clipwright.tts.align.align_with_whisper",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("no faster-whisper")),
    )
    with pytest.raises(RuntimeError, match="api down.*no faster-whisper"):
        openai_tts.synthesize("Hi", tmp_path / "a.mp3", tmp_path / "a.json", api_key="sk-test")
