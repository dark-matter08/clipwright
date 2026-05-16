"""Tests for `tts_segment` — per-segment TTS in v1 layout.

We never invoke a real TTS provider here. Instead a synthetic `_FakeProvider`
generates a known-duration MP3 (via ffmpeg lavfi) plus a hand-rolled
character alignment, and we monkeypatch `tts_segment.get_provider` to return
it. This keeps the tests fast, deterministic, and free of Kokoro/Piper/
ElevenLabs dependencies.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from clipwright import tts_segment as tts_segment_module
from clipwright.schema import (
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Video,
    save_project,
    save_video,
)
from clipwright.tts_segment import (
    TTSSegmentError,
    _compute_input_hash,
    _resolve_provider_and_voice,
    tts_segment,
)


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


# ---------------------------------------------------------------------------
# Fake provider — generates a real MP3 of a known duration via ffmpeg lavfi
# ---------------------------------------------------------------------------


class _FakeProvider:
    """A TTSProvider stand-in.

    Each call writes an MP3 of `audio_seconds` seconds (silent sine wave) and a
    synthetic ElevenLabs-shaped alignment spanning exactly `audio_seconds`.
    """

    name = "fake"

    def __init__(self, audio_seconds: float = 3.0) -> None:
        self.audio_seconds = audio_seconds
        self.last_text: str = ""
        self.last_voice: str | None = None
        self.call_count = 0

    def synthesize(
        self,
        text: str,
        out_mp3: Path,
        out_timestamps: Path,
        *,
        voice: str | None = None,
    ) -> None:
        self.last_text = text
        self.last_voice = voice
        self.call_count += 1

        subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
                "-f", "lavfi", "-i", f"sine=f=440:d={self.audio_seconds}",
                "-c:a", "libmp3lame", "-q:a", "9",
                str(out_mp3),
            ],
            check=True,
            capture_output=True,
        )

        # Synthetic alignment: evenly distribute chars over the audio.
        chars = list(text)
        n = max(1, len(chars))
        step = self.audio_seconds / n
        align = {
            "characters": chars,
            "character_start_times_seconds": [round(i * step, 4) for i in range(n)],
            "character_end_times_seconds": [round((i + 1) * step, 4) for i in range(n)],
        }
        out_timestamps.write_text(json.dumps(align))


@pytest.fixture
def fake_provider() -> _FakeProvider:
    return _FakeProvider(audio_seconds=3.0)


@pytest.fixture(autouse=True)
def patch_get_provider(monkeypatch: pytest.MonkeyPatch, fake_provider: _FakeProvider):
    """Every test gets the fake provider when `tts_segment` calls get_provider."""
    monkeypatch.setattr(
        tts_segment_module, "get_provider", lambda _name: fake_provider,
    )
    # Also allow our fake provider name through the validation set.
    monkeypatch.setattr(
        tts_segment_module, "PROVIDERS", (*tts_segment_module.PROVIDERS, "fake"),
    )


def _make_project(
    tmp_path: Path,
    *,
    target_duration: float = 3.0,
    text: str = "Hello world, quick demo of clipwright.",
    provider: str = "fake",
    voice: str = "test_voice",
) -> Path:
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    save_project(
        project_dir,
        Project(
            title="t", aspect="9:16", fps=30,
            render_backend="remotion",
            tts_provider=provider if provider in ("kokoro", "elevenlabs", "piper") else "kokoro",
            voice_id=voice,
        ),
    )
    save_video(
        project_dir,
        Video(video_id="main", segments=[
            Segment(
                id="seg_001",
                source="sources/main.mp4",
                source_start=0.0, source_end=target_duration,
                target_duration=target_duration,
                kind="recording",
                voiceover=SegmentVoiceover(enabled=True, script_clip_id="vo_001"),
                captions=SegmentRef(enabled=True, ref="captions/index.json#seg_001"),
                camera=SegmentRef(enabled=False, ref=""),
                annotations=SegmentRef(enabled=False, ref=""),
            ),
        ]),
    )
    (project_dir / "voiceover" / "scripts").mkdir(parents=True)
    (project_dir / "voiceover" / "scripts" / "main.json").write_text(json.dumps({
        "schema_version": 1,
        "clips": [
            {
                "id": "vo_001",
                "segment_id": "seg_001",
                "text": text,
                "target_seconds": target_duration,
                "voice": {"provider": provider, "voice_id": voice},
            },
        ],
    }))
    return project_dir


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_writes_mp3_and_timestamps(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    result = tts_segment(project_dir, "seg_001")

    assert result.cached is False
    assert result.mp3_path.exists()
    assert result.timestamps_path.exists()
    assert result.mp3_path.name == "seg_001.mp3"
    assert result.timestamps_path.name == "seg_001.timestamps.json"
    assert result.mp3_path.parent == project_dir / "voiceover" / "audio" / "main"

    # cache sidecar (per-video path)
    assert (project_dir / "voiceover" / "audio" / "main" / "seg_001.cache.json").exists()


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_emits_elevenlabs_shaped_timestamps(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    result = tts_segment(project_dir, "seg_001")
    align = json.loads(result.timestamps_path.read_text())
    assert {"characters", "character_start_times_seconds",
            "character_end_times_seconds"} <= set(align)


# ---------------------------------------------------------------------------
# Cache behavior
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_second_call_is_cached(
    tmp_path: Path, fake_provider: _FakeProvider
) -> None:
    project_dir = _make_project(tmp_path)
    first = tts_segment(project_dir, "seg_001")
    second = tts_segment(project_dir, "seg_001")
    assert first.cached is False
    assert second.cached is True
    assert fake_provider.call_count == 1, "provider must not be re-invoked on cache hit"


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_force_bypasses_cache(
    tmp_path: Path, fake_provider: _FakeProvider
) -> None:
    project_dir = _make_project(tmp_path)
    tts_segment(project_dir, "seg_001")
    forced = tts_segment(project_dir, "seg_001", force=True)
    assert forced.cached is False
    assert fake_provider.call_count == 2


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_invalidated_by_text_change(
    tmp_path: Path, fake_provider: _FakeProvider
) -> None:
    project_dir = _make_project(tmp_path, text="First take.")
    tts_segment(project_dir, "seg_001")

    # Edit the script clip text
    script_path = project_dir / "voiceover" / "scripts" / "main.json"
    payload = json.loads(script_path.read_text())
    payload["clips"][0]["text"] = "Different take entirely."
    script_path.write_text(json.dumps(payload))

    result = tts_segment(project_dir, "seg_001")
    assert result.cached is False
    assert fake_provider.call_count == 2


# ---------------------------------------------------------------------------
# Stretch behavior
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_stretches_when_too_long(tmp_path: Path) -> None:
    """Natural 6s audio with target 3s should be compressed via atempo."""
    project_dir = _make_project(tmp_path, target_duration=3.0)
    # bump the fake provider to emit 6s audio
    fake = _FakeProvider(audio_seconds=6.0)
    import clipwright.tts_segment as tsm
    orig = tsm.get_provider
    tsm.get_provider = lambda _name: fake
    try:
        result = tts_segment(project_dir, "seg_001")
    finally:
        tsm.get_provider = orig

    assert result.stretched is True
    assert result.natural_seconds == pytest.approx(6.0, abs=0.2)
    # post-stretch duration ≈ target
    from clipwright.ffmpeg import probe_duration
    assert probe_duration(result.mp3_path) == pytest.approx(3.0, abs=0.2)
    # timestamps were rescaled
    align = json.loads(result.timestamps_path.read_text())
    assert max(align["character_end_times_seconds"]) <= 3.2


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_does_not_stretch_when_close(tmp_path: Path) -> None:
    """Natural 3s audio with target 3s should not be stretched (within 3% band)."""
    project_dir = _make_project(tmp_path, target_duration=3.0)
    result = tts_segment(project_dir, "seg_001")
    assert result.stretched is False
    assert result.stretch_clamped is False


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_slows_down_when_too_short(tmp_path: Path) -> None:
    """Natural 4.5s audio in a 5s segment should slow to fit (atempo=0.9).

    User feedback: audible dead air between segments is worse than a
    mild slowdown. The TTS stage now stretches in both directions, up
    to the MIN_SLOW_ATEMPO floor.
    """
    project_dir = _make_project(tmp_path, target_duration=5.0)
    fake = _FakeProvider(audio_seconds=4.5)
    import clipwright.tts_segment as tsm
    orig = tsm.get_provider
    tsm.get_provider = lambda _name: fake
    try:
        result = tts_segment(project_dir, "seg_001")
    finally:
        tsm.get_provider = orig

    assert result.stretched is True
    assert result.stretch_clamped is False
    assert result.natural_seconds == pytest.approx(4.5, abs=0.2)
    # Post-stretch duration ≈ target (5.0s).
    from clipwright.ffmpeg import probe_duration
    assert probe_duration(result.mp3_path) == pytest.approx(5.0, abs=0.2)
    # final_seconds tracks the on-disk result.
    assert result.final_seconds == pytest.approx(5.0, abs=0.05)


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_tts_segment_clamps_extreme_slowdown(tmp_path: Path) -> None:
    """Natural 2s audio in a 10s segment exceeds MIN_SLOW_ATEMPO (0.80).

    Desired ratio would be 0.20 — far below the 0.80 floor. The
    stretcher should clamp to 0.80 (audio plays at 80% of natural
    speed), produce a 2.5s file (= 2.0 / 0.80), and set
    `stretch_clamped=True` so callers can warn the user to rewrite
    the script with more words for that beat.
    """
    project_dir = _make_project(tmp_path, target_duration=10.0)
    # Default fake provider emits 3s of audio; bump it down to 2.0s
    # so the desired-ratio calculation is unambiguously below the cap.
    fake = _FakeProvider(audio_seconds=2.0)
    import clipwright.tts_segment as tsm
    orig = tsm.get_provider
    tsm.get_provider = lambda _name: fake
    try:
        result = tts_segment(project_dir, "seg_001")
    finally:
        tsm.get_provider = orig

    assert result.stretched is True
    assert result.stretch_clamped is True
    # 2.0 / 0.80 = 2.5s — the clamped result.
    from clipwright.ffmpeg import probe_duration
    assert probe_duration(result.mp3_path) == pytest.approx(2.5, abs=0.2)
    # Still leaves dead air vs the 10s target — that's the point of the
    # clamp; we surface the mismatch instead of producing slurred audio.
    assert result.final_seconds < result.target_seconds


# ---------------------------------------------------------------------------
# Error paths — no ffmpeg required, fail before synthesis
# ---------------------------------------------------------------------------


def test_tts_segment_missing_id_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    with pytest.raises(TTSSegmentError, match="not found"):
        tts_segment(project_dir, "seg_999")


def test_tts_segment_voiceover_disabled_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    timeline = Video(video_id="main", segments=[
        Segment(
            id="seg_001", source="sources/main.mp4",
            source_start=0.0, source_end=3.0, target_duration=3.0,
            kind="recording",
            voiceover=SegmentVoiceover(enabled=False, script_clip_id=""),
            captions=SegmentRef(enabled=False, ref=""),
            camera=SegmentRef(enabled=False, ref=""),
            annotations=SegmentRef(enabled=False, ref=""),
        ),
    ])
    save_video(project_dir, timeline)
    with pytest.raises(TTSSegmentError, match="disabled"):
        tts_segment(project_dir, "seg_001")


def test_tts_segment_missing_script_json_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    (project_dir / "voiceover" / "scripts" / "main.json").unlink()
    with pytest.raises(TTSSegmentError, match="scripts/main.json not found"):
        tts_segment(project_dir, "seg_001")


def test_tts_segment_missing_clip_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    (project_dir / "voiceover" / "scripts" / "main.json").write_text(json.dumps({
        "schema_version": 1,
        "clips": [],
    }))
    with pytest.raises(TTSSegmentError, match="no script clip"):
        tts_segment(project_dir, "seg_001")


def test_tts_segment_empty_text_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path, text="")
    with pytest.raises(TTSSegmentError, match="no text"):
        tts_segment(project_dir, "seg_001")


def test_tts_segment_invalid_json_raises(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    (project_dir / "voiceover" / "scripts" / "main.json").write_text("{not json")
    with pytest.raises(TTSSegmentError, match="invalid JSON"):
        tts_segment(project_dir, "seg_001")


# ---------------------------------------------------------------------------
# Resolution + cache-hash logic — pure, no ffmpeg
# ---------------------------------------------------------------------------


def _video(**overrides) -> Video:
    """Helper: build a minimal `Video` for resolver tests, optionally
    setting `recap_overrides` keys via kwargs."""
    return Video(video_id="main", title="t", recap_overrides=overrides)


def test_resolve_provider_and_voice_clip_overrides() -> None:
    project = Project(tts_provider="kokoro", voice_id="default_voice")
    clip = {"voice": {"provider": "elevenlabs", "voice_id": "rachel"}}
    p, v = _resolve_provider_and_voice(project, _video(), clip)
    assert (p, v) == ("elevenlabs", "rachel")


def test_resolve_provider_and_voice_falls_back_to_project() -> None:
    project = Project(tts_provider="kokoro", voice_id="default_voice")
    p, v = _resolve_provider_and_voice(project, _video(), {})
    assert (p, v) == ("kokoro", "default_voice")


def test_resolve_provider_and_voice_legacy_flat_voice_id() -> None:
    """Older script.json shape: top-level `voice_id` without nested `voice`."""
    project = Project(tts_provider="kokoro", voice_id="default")
    p, v = _resolve_provider_and_voice(project, _video(), {"voice_id": "legacy"})
    assert v == "legacy"


def test_resolve_video_override_beats_project_default() -> None:
    """Per-video voice override (written by the desktop's ProjectSettings
    'Per-video overrides' panel into `recap_overrides`) must win over
    the project default.

    Regression: prior versions ignored `recap_overrides` entirely, so a
    user who set a per-video voice in the desktop saw the project
    default speak anyway."""
    project = Project(tts_provider="kokoro", voice_id="kokoro_voice")
    video = _video(voice_provider="elevenlabs", voice_id="rachel")
    p, v = _resolve_provider_and_voice(project, video, {})
    assert (p, v) == ("elevenlabs", "rachel")


def test_resolve_clip_override_beats_video_override() -> None:
    """Precedence: clip > video > project."""
    project = Project(tts_provider="kokoro", voice_id="kokoro_voice")
    video = _video(voice_provider="elevenlabs", voice_id="rachel")
    clip = {"voice": {"provider": "piper", "voice_id": "ryan"}}
    p, v = _resolve_provider_and_voice(project, video, clip)
    assert (p, v) == ("piper", "ryan")


def test_resolve_video_voice_id_only_overrides_voice() -> None:
    """Setting only `voice_id` in the per-video override (without
    `voice_provider`) overrides the voice but inherits the project
    provider."""
    project = Project(tts_provider="kokoro", voice_id="kokoro_voice")
    video = _video(voice_id="bf_george")
    p, v = _resolve_provider_and_voice(project, video, {})
    assert (p, v) == ("kokoro", "bf_george")


def test_compute_input_hash_deterministic() -> None:
    h1 = _compute_input_hash(text="hi", provider="kokoro", voice="v", target_seconds=3.0)
    h2 = _compute_input_hash(text="hi", provider="kokoro", voice="v", target_seconds=3.0)
    assert h1 == h2
    assert h1.startswith("sha256:")


def test_compute_input_hash_changes_with_each_input() -> None:
    base = _compute_input_hash(text="hi", provider="kokoro", voice="v", target_seconds=3.0)
    assert base != _compute_input_hash(text="bye", provider="kokoro", voice="v", target_seconds=3.0)
    assert base != _compute_input_hash(text="hi", provider="piper", voice="v", target_seconds=3.0)
    assert base != _compute_input_hash(text="hi", provider="kokoro", voice="x", target_seconds=3.0)
    assert base != _compute_input_hash(text="hi", provider="kokoro", voice="v", target_seconds=4.0)
