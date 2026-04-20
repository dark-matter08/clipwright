"""Unit tests for the caption chunker."""
from __future__ import annotations

from clipwright.captions.chunker import chars_to_words, chunk_words


def _align(text: str, step: float = 0.1) -> dict:
    chars = list(text)
    starts = [i * step for i in range(len(chars))]
    ends = [(i + 1) * step for i in range(len(chars))]
    return {
        "characters": chars,
        "character_start_times_seconds": starts,
        "character_end_times_seconds": ends,
    }


def test_chars_to_words_splits_on_space_and_punct():
    align = _align("hi there. world!")
    words = chars_to_words(align)
    texts = [w.text for w in words]
    assert texts == ["hi", "there", "world"]
    assert words[1].ends_sentence is True
    assert words[-1].ends_sentence is True


def test_chunk_two_words_uppercase():
    align = _align("one two three four")
    words = chars_to_words(align)
    chunks = chunk_words(words, n=2, upper=True)
    assert [c.text for c in chunks] == ["ONE TWO", "THREE FOUR"]


def test_sentence_boundary_flushes_chunk_early():
    align = _align("hi. hello world")
    words = chars_to_words(align)
    chunks = chunk_words(words, n=2, upper=True)
    assert chunks[0].text == "HI"
    assert chunks[1].text == "HELLO WORLD"


def test_no_overlap_between_adjacent_chunks():
    align = _align("alpha beta gamma delta")
    words = chars_to_words(align)
    chunks = chunk_words(words, n=2, upper=True)
    for a, b in zip(chunks, chunks[1:], strict=False):
        assert a.end <= b.start, f"{a} overlaps {b}"


def test_last_chunk_has_tail_hold():
    align = _align("one two")
    words = chars_to_words(align)
    last_word_end = words[-1].end
    chunks = chunk_words(words, n=2, upper=True, tail_hold=0.2)
    assert chunks[-1].end > last_word_end
