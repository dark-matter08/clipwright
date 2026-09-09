"""Voice auditioning — synthesize a throwaway line so a voice can be
heard before it's committed to a project.

Picking a voice from a dropdown of names is guesswork: "onyx" and
"ballad" mean nothing until you hear them, and the alternative is
rendering a whole segment to find out. This synthesizes one short line
to a temp file that the desktop plays inline.

Two things make it cheap enough to run on every dropdown change:

  * **No alignment.** Providers that expose `synthesize_audio` skip
    forced alignment entirely — which for OpenAI is the difference
    between an HTTP round-trip and loading a Whisper model.
  * **Content-addressed cache.** The same (provider, voice, text) is
    synthesized once per machine. Re-auditioning a voice you've already
    heard is a file read, and it doesn't re-bill a paid API.
"""
from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

from .errors import ClipwrightError
from .tts import PROVIDERS, get_provider

# Short, punchy, and representative of what this tool actually produces:
# present tense, one concrete beat. A generic pangram would tell you
# nothing about how a voice handles narration.
DEFAULT_SAMPLE_TEXT = (
    "He walks into the dungeon already bleeding. This time, he doesn't walk out."
)


def sample_cache_dir() -> Path:
    """Machine-wide, not per-project — a voice sounds the same in every
    project, so caching per project would re-bill the API for nothing."""
    return Path(tempfile.gettempdir()) / "clipwright-voice-samples"


def sample_path(provider: str, voice: str, text: str) -> Path:
    key = hashlib.sha256(
        f"{provider}\x00{voice}\x00{text}".encode()
    ).hexdigest()[:16]
    safe_voice = "".join(c if c.isalnum() or c in "-_" else "_" for c in voice)
    return sample_cache_dir() / f"{provider}-{safe_voice}-{key}.mp3"


def synthesize_sample(
    provider: str,
    voice: str,
    *,
    text: str = DEFAULT_SAMPLE_TEXT,
    force: bool = False,
) -> Path:
    """Return a playable mp3 for (provider, voice), synthesizing if needed.

    Raises `ClipwrightError` with a fix hint for the things that actually
    go wrong here: an unknown provider, a missing API key, a voice the
    account can't use.
    """
    p = provider.strip().lower()
    if p not in PROVIDERS:
        raise ClipwrightError(
            f"unknown TTS provider {provider!r}",
            fix=f"Use one of: {', '.join(PROVIDERS)}.",
        )

    out = sample_path(p, voice, text)
    if out.exists() and out.stat().st_size > 0 and not force:
        return out

    out.parent.mkdir(parents=True, exist_ok=True)
    impl = get_provider(p)
    try:
        audio_only = getattr(impl, "synthesize_audio", None)
        if audio_only is not None:
            audio_only(text, out, voice=voice or None)
        else:
            # Kokoro and Piper only offer the full path. Their timings
            # are a byproduct we don't want, so they go to a temp file
            # that's discarded — still far cheaper than a real render.
            with tempfile.TemporaryDirectory() as td:
                impl.synthesize(
                    text, out, Path(td) / "timings.json", voice=voice or None
                )
    except Exception as e:
        # A partial write would be cached as if it were good.
        out.unlink(missing_ok=True)
        raise ClipwrightError(
            f"could not synthesize a {p} sample for voice {voice!r}: {e}",
            fix=(
                "Check the API key in Project settings → API keys."
                if p in ("openai", "elevenlabs")
                else f"Install the backend: pip install 'clipwright[{p}]'."
            ),
        ) from e

    if not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise ClipwrightError(
            f"{p} produced no audio for voice {voice!r}",
            fix="Try a different voice, or check the provider's status.",
        )
    return out
