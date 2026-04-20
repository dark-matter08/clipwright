"""Kokoro TTS backend — Apache-2.0, ~82M params, near-human narration.

Install extra:  pip install 'clipwright[kokoro]'
Model downloads on first use via the `kokoro` Python package (~330MB).

Kokoro's `KPipeline` yields (graphemes, phonemes, audio, tokens) per chunk,
where `tokens` carry per-token start/end times. We aggregate tokens back into
word-level spans (splitting on whitespace in `graphemes`) and feed the result
through `words_to_alignment` so the output shape matches ElevenLabs.
"""
from __future__ import annotations

from pathlib import Path

from ..ffmpeg import run
from .base import Word, words_to_alignment, write_alignment

DEFAULT_VOICE = "af_heart"  # American female, default warm narration voice
DEFAULT_LANG = "a"  # 'a' = American English; 'b' = British English


def synthesize(
    text: str,
    out_mp3: Path,
    out_timestamps: Path,
    *,
    voice: str | None = None,
    lang_code: str = DEFAULT_LANG,
    speed: float = 1.0,
) -> None:
    try:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
    except ImportError as e:
        raise RuntimeError(
            "kokoro backend requires extras: pip install 'clipwright[kokoro]'\n"
            f"(import failed: {e})"
        ) from e

    pipeline = KPipeline(lang_code=lang_code)
    v = voice or DEFAULT_VOICE

    audio_chunks: list[np.ndarray] = []
    words: list[Word] = []
    time_offset = 0.0
    sample_rate = 24000  # Kokoro output rate

    for result in pipeline(text, voice=v, speed=speed):
        # result is a Result object with .graphemes, .audio, .tokens
        audio = getattr(result, "audio", None)
        if audio is None:
            continue
        audio_np = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
        audio_chunks.append(audio_np)

        tokens = getattr(result, "tokens", None) or []
        # Group tokens into words: a new word starts whenever the token text
        # contains whitespace or punctuation that breaks words.
        cur_text = ""
        cur_start: float | None = None
        cur_end: float | None = None
        for tok in tokens:
            t_text = getattr(tok, "text", "") or ""
            t_start = getattr(tok, "start_ts", None)
            t_end = getattr(tok, "end_ts", None)
            if t_start is None or t_end is None:
                continue
            t_start = float(t_start) + time_offset
            t_end = float(t_end) + time_offset

            stripped = t_text.strip()
            if not stripped:
                if cur_text and cur_start is not None and cur_end is not None:
                    words.append(Word(cur_text, cur_start, cur_end))
                cur_text, cur_start, cur_end = "", None, None
                continue
            if cur_start is None:
                cur_start = t_start
            cur_text += stripped
            cur_end = t_end
        if cur_text and cur_start is not None and cur_end is not None:
            words.append(Word(cur_text, cur_start, cur_end))

        # Advance offset by this chunk's duration.
        time_offset += len(audio_np) / sample_rate

    if not audio_chunks:
        raise RuntimeError("Kokoro produced no audio (empty input?)")

    merged = np.concatenate(audio_chunks)
    out_mp3.parent.mkdir(parents=True, exist_ok=True)

    # Write WAV first, then transcode to MP3 with ffmpeg for downstream uniformity.
    wav_path = out_mp3.with_suffix(".wav")
    sf.write(str(wav_path), merged, sample_rate)
    run(["ffmpeg", "-y", "-i", str(wav_path), "-b:a", "192k", str(out_mp3)])
    wav_path.unlink(missing_ok=True)

    alignment = words_to_alignment(text, words)
    write_alignment(out_timestamps, alignment)


class KokoroProvider:
    name = "kokoro"

    def synthesize(
        self,
        text: str,
        out_mp3: Path,
        out_timestamps: Path,
        *,
        voice: str | None = None,
    ) -> None:
        synthesize(text, out_mp3, out_timestamps, voice=voice)
