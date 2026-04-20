"""ElevenLabs character-level timestamps -> 2-word UPPERCASE caption chunks."""
from __future__ import annotations

from dataclasses import dataclass

SENT_TERMINATORS = {".", "!", "?"}
BREAK_PUNCT = {".", ",", "!", "?", ";", ":", "—", "-"}


@dataclass
class Word:
    text: str
    start: float
    end: float
    ends_sentence: bool


@dataclass
class Chunk:
    text: str
    start: float
    end: float


def chars_to_words(align: dict) -> list[Word]:
    chars = align["characters"]
    starts = align["character_start_times_seconds"]
    ends = align["character_end_times_seconds"]
    words: list[Word] = []
    cur = ""
    s: float | None = None
    e: float | None = None
    for c, cs, ce in zip(chars, starts, ends, strict=False):
        if c.isspace() or c in BREAK_PUNCT:
            if cur and s is not None and e is not None:
                words.append(Word(cur, s, e, c in SENT_TERMINATORS))
            cur, s, e = "", None, None
            continue
        if s is None:
            s = cs
        cur += c
        e = ce
    if cur and s is not None and e is not None:
        words.append(Word(cur, s, e, True))
    return words


def chunk_words(
    words: list[Word],
    *,
    n: int = 2,
    upper: bool = True,
    tail_hold: float = 0.2,
    max_extend: float = 0.15,
    min_gap: float = 0.03,
) -> list[Chunk]:
    """Group up to n words per chunk; flush at sentence boundary. Snap to word boundaries."""
    if not words:
        return []
    chunks: list[Chunk] = []
    buf: list[Word] = []
    for w in words:
        buf.append(w)
        if len(buf) >= n or w.ends_sentence:
            text = " ".join(x.text for x in buf)
            if upper:
                text = text.upper()
            chunks.append(Chunk(text, buf[0].start, buf[-1].end))
            buf = []
    if buf:
        text = " ".join(x.text for x in buf)
        if upper:
            text = text.upper()
        chunks.append(Chunk(text, buf[0].start, buf[-1].end))

    for i in range(len(chunks) - 1):
        nxt = chunks[i + 1].start
        chunks[i].end = min(chunks[i].end + max_extend, nxt - min_gap)
    chunks[-1].end = chunks[-1].end + tail_hold
    return chunks


def chunks_with_offset(chunks: list[Chunk], offset: float) -> list[Chunk]:
    return [Chunk(c.text, c.start + offset, c.end + offset) for c in chunks]
