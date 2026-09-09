"""OpenAI TTS backend — paid API, high-quality voices.

The speech endpoint returns audio and nothing else: no character or word
timings, unlike ElevenLabs' `/with-timestamps`. Clipwright's captions are
built from character-level alignment, so the audio has to be aligned
after the fact.

We do that with OpenAI's own transcription endpoint, which returns word
timestamps for an uploaded file. Using it costs nothing extra in
dependencies: anyone synthesizing with this provider already has the key
that call needs. The earlier design force-aligned locally with
faster-whisper — correct, but it made captioned OpenAI clips require a
~40 MB model download that the rest of the provider doesn't. Local
alignment is still the fallback when the API call fails and
faster-whisper happens to be installed.

Sampling a voice skips alignment entirely (`synthesize_audio`), which is
why the desktop's voice preview is one round-trip.

stdlib urllib throughout, to keep the `openai` SDK out of the base
dependency set for two HTTP calls.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from .base import Word, words_to_alignment, write_alignment

ENDPOINT = "https://api.openai.com/v1/audio/speech"
TRANSCRIBE_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions"
# `whisper-1` is the model that exposes word-level
# `timestamp_granularities`. The newer gpt-4o transcribe models are
# better at recognition but don't return word timings, which is the only
# thing we want here — we already know the words.
ALIGN_MODEL = "whisper-1"

# `gpt-4o-mini-tts` is the current-generation model: better prosody than
# tts-1 at a similar price, and it accepts an `instructions` string for
# steering delivery. `tts-1` / `tts-1-hd` remain valid values here.
DEFAULT_MODEL = "gpt-4o-mini-tts"
DEFAULT_VOICE = "alloy"

# The voices the API accepts. Kept here so a typo fails locally with a
# useful message instead of a 400 from the server mid-render.
#
# `marin` and `cedar` are the newest generation and are only served by
# `gpt-4o-mini-tts` — the legacy `tts-1` / `tts-1-hd` models reject them
# with an enum error. That's fine at the default model, but if you pass
# `model="tts-1"` you're limited to the eleven below them.
VOICES = (
    "alloy", "ash", "ballad", "coral", "echo",
    "fable", "onyx", "nova", "sage", "shimmer", "verse",
    "marin", "cedar",
)


def _request_audio(
    text: str,
    *,
    voice: str,
    api_key: str,
    model: str,
    instructions: str | None,
    speed: float = 1.0,
    response_format: str = "mp3",
) -> bytes:
    body: dict = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": response_format,
    }
    # Verified against the API: `speed` scales duration cleanly on
    # gpt-4o-mini-tts as well as tts-1 (0.5 → ~2x length, 2.0 → ~0.55x).
    # Native is better than re-timing afterwards, so we use it here and
    # only fall back to ffmpeg for providers that lack it.
    if abs(speed - 1.0) > 1e-3:
        body["speed"] = max(0.25, min(4.0, float(speed)))
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
    speed: float = 1.0,
) -> None:
    """Audio only — no alignment. Used for previews."""
    audio = _request_audio(
        text,
        voice=_resolve_voice(voice),
        api_key=_resolve_key(api_key),
        model=model,
        instructions=instructions,
        speed=speed,
    )
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    out_mp3.write_bytes(audio)


def align_via_api(mp3: Path, *, api_key: str) -> list[Word]:
    """Word timings from OpenAI's transcription endpoint.

    Hand-rolled multipart because this is the only file upload in the
    codebase and `requests` isn't a dependency. The response's `words`
    array is exactly the shape `words_to_alignment` wants.
    """
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'
            f"\r\n\r\n{value}\r\n".encode()
        )

    field("model", ALIGN_MODEL)
    field("response_format", "verbose_json")
    # The `[]` suffix is required — the API reads this as an array.
    field("timestamp_granularities[]", "word")
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{mp3.name}"\r\nContent-Type: audio/mpeg\r\n\r\n'.encode()
        + mp3.read_bytes()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        TRANSCRIBE_ENDPOINT,
        data=b"".join(parts),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass
        raise RuntimeError(
            f"OpenAI alignment failed ({e.code})" + (f": {detail}" if detail else "")
        ) from e

    return [
        Word(str(w.get("word", "")).strip(), float(w.get("start", 0.0)), float(w.get("end", 0.0)))
        for w in payload.get("words") or []
        if str(w.get("word", "")).strip()
    ]


def synthesize(
    text: str,
    out_mp3: Path,
    out_timestamps: Path,
    *,
    voice: str | None = None,
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
    instructions: str | None = None,
    speed: float = 1.0,
) -> None:
    key = _resolve_key(api_key)
    synthesize_audio(
        text,
        out_mp3,
        voice=voice,
        api_key=key,
        model=model,
        instructions=instructions,
        speed=speed,
    )

    # Align through the same account that just synthesized — no local
    # model, nothing extra to install.
    try:
        words = align_via_api(out_mp3, api_key=key)
    except Exception as api_err:
        # Network blip or an account without transcription access: fall
        # back to local alignment IF it happens to be available, rather
        # than losing a paid synthesis over a second call.
        try:
            from .align import align_with_whisper

            words = align_with_whisper(out_mp3, text)
        except Exception as local_err:
            raise RuntimeError(
                f"OpenAI alignment failed ({api_err}), and local fallback is "
                f"unavailable ({local_err}). Captions need word timings; "
                "either retry, or install the local aligner with "
                "`pip install 'clipwright[openai]'`."
            ) from api_err

    if not words:
        raise RuntimeError(
            "OpenAI alignment returned no words for this clip",
            )
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
        instructions: str | None = None,
        speed: float = 1.0,
    ) -> None:
        synthesize_audio(
            text, out_mp3, voice=voice, instructions=instructions, speed=speed
        )
