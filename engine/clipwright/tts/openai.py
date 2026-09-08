"""OpenAI TTS backend — paid API, high-quality voices.

The speech endpoint returns audio and nothing else: no character or word
timings, unlike ElevenLabs' `/with-timestamps`. Clipwright's captions are
built from character-level alignment, so we synthesize, then force-align
the result with faster-whisper — the same approach `piper.py` takes, via
the shared `align.py`.

That makes captioned OpenAI clips need the alignment extra:

    pip install 'clipwright[openai]'

Sampling a voice does NOT need it — `synthesize_audio` skips alignment
entirely, which is why the desktop's voice preview stays fast and works
on a bare install.

stdlib urllib throughout, to keep the `openai` SDK out of the base
dependency set for one HTTP call.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

from .align import align_with_whisper
from .base import words_to_alignment, write_alignment

ENDPOINT = "https://api.openai.com/v1/audio/speech"

# `gpt-4o-mini-tts` is the current-generation model: better prosody than
# tts-1 at a similar price, and it accepts an `instructions` string for
# steering delivery. `tts-1` / `tts-1-hd` remain valid values here.
DEFAULT_MODEL = "gpt-4o-mini-tts"
DEFAULT_VOICE = "alloy"

# The voices the API accepts. Kept here so a typo fails locally with a
# useful message instead of a 400 from the server mid-render.
VOICES = (
    "alloy", "ash", "ballad", "coral", "echo",
    "fable", "onyx", "nova", "sage", "shimmer", "verse",
)


def _request_audio(
    text: str,
    *,
    voice: str,
    api_key: str,
    model: str,
    instructions: str | None,
    response_format: str = "mp3",
) -> bytes:
    body: dict = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": response_format,
    }
    # Only gpt-4o-mini-tts honors `instructions`; tts-1 rejects unknown
    # fields, so send it only when we have something to say.
    if instructions:
        body["instructions"] = instructions

    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        # The API returns a JSON error body; surfacing its message beats
        # "HTTP Error 401" when the real problem is an expired key or a
        # voice name the account can't use.
        detail = ""
        try:
            payload = json.loads(e.read().decode("utf-8"))
            detail = payload.get("error", {}).get("message", "")
        except Exception:
            pass
        raise RuntimeError(
            f"OpenAI TTS request failed ({e.code})" + (f": {detail}" if detail else "")
        ) from e


def _resolve_key(api_key: str | None) -> str:
    if api_key:
        return api_key
    from ..credentials import get_openai_api_key

    key = get_openai_api_key()
    if not key:
        raise RuntimeError(
            "OpenAI API key not set. Add it in Project settings → API keys, "
            "or export OPENAI_API_KEY."
        )
    return key


def _resolve_voice(voice: str | None) -> str:
    v = (voice or DEFAULT_VOICE).strip()
    if v not in VOICES:
        raise RuntimeError(
            f"unknown OpenAI voice {v!r}; valid: {', '.join(VOICES)}"
        )
    return v


def synthesize_audio(
    text: str,
    out_mp3: Path,
    *,
    voice: str | None = None,
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
    instructions: str | None = None,
) -> None:
    """Audio only — no alignment, no faster-whisper. Used for previews."""
    audio = _request_audio(
        text,
        voice=_resolve_voice(voice),
        api_key=_resolve_key(api_key),
        model=model,
        instructions=instructions,
    )
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    out_mp3.write_bytes(audio)


def synthesize(
    text: str,
    out_mp3: Path,
    out_timestamps: Path,
    *,
    voice: str | None = None,
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
    instructions: str | None = None,
) -> None:
    synthesize_audio(
        text,
        out_mp3,
        voice=voice,
        api_key=api_key,
        model=model,
        instructions=instructions,
    )

    # Align against the mp3 we just wrote. faster-whisper reads mp3
    # directly, so there's no wav round-trip to do here.
    words = align_with_whisper(out_mp3, text)
    write_alignment(out_timestamps, words_to_alignment(text, words))


class OpenAIProvider:
    name = "openai"

    def synthesize(
        self,
        text: str,
        out_mp3: Path,
        out_timestamps: Path,
        *,
        voice: str | None = None,
    ) -> None:
        synthesize(text, out_mp3, out_timestamps, voice=voice)

    def synthesize_audio(
        self,
        text: str,
        out_mp3: Path,
        *,
        voice: str | None = None,
    ) -> None:
        synthesize_audio(text, out_mp3, voice=voice)
