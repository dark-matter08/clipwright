"""Forced alignment for providers whose API returns audio but no timings.

ElevenLabs hands back character-level timings; Kokoro emits token timings
natively. Piper and OpenAI return audio only, so we transcribe what was
generated and take the word timings from that.

Whisper is being used here as an *aligner*, not a recognizer: we already
know the exact words, so the decoder is biased with `initial_prompt` and
we keep only the timings. tiny.en (~39 MB) is plenty for that and adds
~100–300 ms per clip.
"""
from __future__ import annotations

from pathlib import Path

from .base import Word

# Cached across calls — loading the model costs far more than a clip.
# One process synthesizes many segments in a row, so paying the load
# once matters.
_MODEL = None


def _load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "forced alignment requires faster-whisper: "
            "pip install 'clipwright[openai]' (or [piper])"
        ) from e
    _MODEL = WhisperModel("tiny.en", device="cpu", compute_type="int8")
    return _MODEL


def align_with_whisper(audio_path: Path, text: str) -> list[Word]:
    """Word timings for `audio_path`, biased toward the known `text`."""
    model = _load_model()
    segments, _ = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        language="en",
        initial_prompt=text,  # Bias the decoder toward the known script.
    )
    words: list[Word] = []
    for seg in segments:
        for w in seg.words or []:
            token = (w.word or "").strip()
            if not token:
                continue
            words.append(Word(token, float(w.start), float(w.end)))
    return words
