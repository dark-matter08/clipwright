"""Shared TTS provider contract + alignment helpers.

Every backend emits two files:

    out_mp3:        synthesized audio (always MP3 for downstream uniformity)
    out_timestamps: ElevenLabs-shaped alignment JSON:
        {
          "characters": [...],
          "character_start_times_seconds": [...],
          "character_end_times_seconds": [...]
        }

Keeping the alignment shape identical means chunker.chars_to_words keeps working
for every provider — no downstream branching.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass
class Word:
    text: str
    start: float
    end: float


class TTSProvider(Protocol):
    name: str

    def synthesize(
        self,
        text: str,
        out_mp3: Path,
        out_timestamps: Path,
        *,
        voice: str | None = None,
    ) -> None: ...


def words_to_alignment(text: str, words: list[Word]) -> dict:
    """Reconstruct a character-level alignment from word timings.

    Linearly interpolates character times within each word; spaces take the gap
    between the preceding word's end and the next word's start (or 0 if flush).
    This matches the shape chunker.chars_to_words expects.
    """
    chars: list[str] = []
    cstart: list[float] = []
    cend: list[float] = []

    if not words:
        # Degenerate: dump the raw text with zero-width timings.
        for c in text:
            chars.append(c)
            cstart.append(0.0)
            cend.append(0.0)
        return {
            "characters": chars,
            "character_start_times_seconds": cstart,
            "character_end_times_seconds": cend,
        }

    # Walk the source text, match words in order. Characters between matched
    # words (spaces, punctuation) get interpolated timings from the gap.
    cursor = 0
    prev_end = 0.0
    for w in words:
        # Find this word in the remaining text (case-insensitive, whitespace-tolerant).
        target = w.text
        idx = text.lower().find(target.lower(), cursor)
        if idx < 0:
            # Fallback: append the word as-is; don't try to re-split the source.
            idx = cursor

        # Fill gap chars between prev_end and this word's start.
        gap_chars = text[cursor:idx]
        if gap_chars:
            gs = prev_end
            ge = w.start
            if ge < gs:
                ge = gs
            span = max(1e-6, ge - gs)
            for gi, c in enumerate(gap_chars):
                t0 = gs + span * (gi / len(gap_chars))
                t1 = gs + span * ((gi + 1) / len(gap_chars))
                chars.append(c)
                cstart.append(t0)
                cend.append(t1)

        # Emit the word itself with linearly interpolated char times.
        wtxt = text[idx : idx + len(target)] if idx + len(target) <= len(text) else target
        wlen = max(1, len(wtxt))
        span = max(1e-6, w.end - w.start)
        for ci, c in enumerate(wtxt):
            t0 = w.start + span * (ci / wlen)
            t1 = w.start + span * ((ci + 1) / wlen)
            chars.append(c)
            cstart.append(t0)
            cend.append(t1)
        cursor = idx + len(wtxt)
        prev_end = w.end

    # Trailing punctuation after the last word.
    tail = text[cursor:]
    if tail:
        for c in tail:
            chars.append(c)
            cstart.append(prev_end)
            cend.append(prev_end)

    return {
        "characters": chars,
        "character_start_times_seconds": cstart,
        "character_end_times_seconds": cend,
    }


def write_alignment(out: Path, alignment: dict) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(alignment, indent=2))
