"""Piper TTS backend — MIT, ~20MB, CPU-only, offline forever.

Piper does not expose word timings, so we run faster-whisper on the generated
audio for forced alignment. Adds ~100-300ms per clip; fully deterministic.

Install extra:  pip install 'clipwright[piper]'
Voice models (.onnx) are downloaded on first use from the piper-voices hub.
"""
from __future__ import annotations

import json
import tempfile
import urllib.request
from pathlib import Path

from ..ffmpeg import run
from .base import Word, words_to_alignment, write_alignment

DEFAULT_VOICE = "en_US-lessac-medium"
# Voice cache lives alongside other clipwright caches.
_CACHE = Path.home() / ".cache" / "clipwright" / "piper-voices"
_VOICE_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"


def _voice_url_parts(voice: str) -> tuple[str, str, str, str]:
    """en_US-lessac-medium -> (en, en_US, lessac, medium)."""
    locale, speaker, quality = voice.split("-", 2)
    lang = locale.split("_")[0]
    return lang, locale, speaker, quality


def _ensure_voice(voice: str) -> Path:
    _CACHE.mkdir(parents=True, exist_ok=True)
    lang, locale, speaker, quality = _voice_url_parts(voice)
    onnx = _CACHE / f"{voice}.onnx"
    cfg = _CACHE / f"{voice}.onnx.json"
    if onnx.exists() and cfg.exists():
        return onnx
    base = f"{_VOICE_BASE}/{lang}/{locale}/{speaker}/{quality}"
    for name, dest in [
        (f"{voice}.onnx", onnx),
        (f"{voice}.onnx.json", cfg),
    ]:
        url = f"{base}/{name}"
        with urllib.request.urlopen(url) as resp, open(dest, "wb") as fh:
            fh.write(resp.read())
    return onnx


def _align_with_whisper(wav_path: Path, text: str) -> list[Word]:
    """Forced-alignment via faster-whisper word_timestamps."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "piper backend requires faster-whisper for alignment: "
            "pip install 'clipwright[piper]'"
        ) from e

    # tiny.en is ~39MB and plenty for forced alignment against known text.
    model = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(
        str(wav_path),
        word_timestamps=True,
        language="en",
        initial_prompt=text,  # Bias decoder toward the known script.
    )
    words: list[Word] = []
    for seg in segments:
        for w in seg.words or []:
            token = (w.word or "").strip()
            if not token:
                continue
            words.append(Word(token, float(w.start), float(w.end)))
    return words


def synthesize(
    text: str,
    out_mp3: Path,
    out_timestamps: Path,
    *,
    voice: str | None = None,
) -> None:
    try:
        from piper import PiperVoice
    except ImportError as e:
        raise RuntimeError(
            "piper backend requires extras: pip install 'clipwright[piper]'\n"
            f"(import failed: {e})"
        ) from e

    v_name = voice or DEFAULT_VOICE
    onnx_path = _ensure_voice(v_name)
    voice_obj = PiperVoice.load(str(onnx_path))

    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wav_path = Path(tf.name)

    try:
        import wave

        with wave.open(str(wav_path), "wb") as wf:
            voice_obj.synthesize(text, wf)

        run(["ffmpeg", "-y", "-i", str(wav_path), "-b:a", "192k", str(out_mp3)])

        words = _align_with_whisper(wav_path, text)
    finally:
        wav_path.unlink(missing_ok=True)

    alignment = words_to_alignment(text, words)
    write_alignment(out_timestamps, alignment)


class PiperProvider:
    name = "piper"

    def synthesize(
        self,
        text: str,
        out_mp3: Path,
        out_timestamps: Path,
        *,
        voice: str | None = None,
    ) -> None:
        synthesize(text, out_mp3, out_timestamps, voice=voice)
