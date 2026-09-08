"""TTS provider registry. Lazy-imports backends so extras are optional."""
from __future__ import annotations

from .base import TTSProvider, Word, words_to_alignment, write_alignment

PROVIDERS = ("kokoro", "piper", "elevenlabs")


def get_provider(name: str) -> TTSProvider:
    n = name.lower()
    if n == "kokoro":
        from .kokoro import KokoroProvider
        return KokoroProvider()
    if n == "piper":
        from .piper import PiperProvider
        return PiperProvider()
    if n == "elevenlabs":
        from .elevenlabs import ElevenLabsProvider
        return ElevenLabsProvider()
    raise ValueError(f"unknown tts provider {name!r}; valid: {PROVIDERS}")


__all__ = ["TTSProvider", "Word", "words_to_alignment", "write_alignment", "PROVIDERS", "get_provider"]
