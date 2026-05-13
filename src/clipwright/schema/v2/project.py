"""project.json — collection-level metadata for schema v2.

A v2 project is a *collection of videos*. The fields here describe what's
shared across every video in the collection: visual identity (aspect,
fps), default voice + provider, optional base URL for Record-mode
projects. Each individual deliverable lives under `videos/<id>.json`
and shares this manifest.

The schema is field-for-field compatible with v1 except for the
`schema_version` bump. Migration is therefore trivial: rewrite the
version int, leave everything else alone, and lay out the new
`videos/` directory.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Aspect = Literal["9:16", "16:9", "1:1"]
RenderBackend = Literal["remotion", "ffmpeg"]
TTSProvider = Literal["kokoro", "elevenlabs", "piper"]

VALID_ASPECTS: set[str] = {"9:16", "16:9", "1:1"}
VALID_BACKENDS: set[str] = {"remotion", "ffmpeg"}
# vibevoice reserved; add back when a backend ships. See v1/project.py.
VALID_TTS_PROVIDERS: set[str] = {"kokoro", "elevenlabs", "piper"}


@dataclass
class Project:
    """Root project manifest, schema v2.

    Stored at `<project>/project.json`.
    """

    title: str = ""
    aspect: str = "9:16"
    fps: int = 30
    render_backend: str = "remotion"
    tts_provider: str = "kokoro"
    voice_id: str = ""
    base_url: str = ""
    created_at: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    # Set on load; ignored on save (we always emit current SCHEMA_VERSION).
    loaded_schema_version: int = 2

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "schema_version": 2,
            "title": self.title,
            "aspect": self.aspect,
            "fps": self.fps,
            "render_backend": self.render_backend,
            "tts_provider": self.tts_provider,
            "voice_id": self.voice_id,
            "base_url": self.base_url,
            "created_at": self.created_at,
        }
        if self.extra:
            d["extra"] = dict(self.extra)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Project:
        aspect = str(d.get("aspect", "9:16"))
        if aspect not in VALID_ASPECTS:
            raise ValueError(
                f"project.aspect must be one of {sorted(VALID_ASPECTS)}, got {aspect!r}"
            )
        backend = str(d.get("render_backend", "remotion"))
        if backend not in VALID_BACKENDS:
            raise ValueError(
                f"project.render_backend must be one of {sorted(VALID_BACKENDS)}, got {backend!r}"
            )
        tts = str(d.get("tts_provider", "kokoro"))
        if tts not in VALID_TTS_PROVIDERS:
            raise ValueError(
                f"project.tts_provider must be one of {sorted(VALID_TTS_PROVIDERS)}, got {tts!r}"
            )
        fps = int(d.get("fps", 30))
        if fps not in (24, 30, 60):
            raise ValueError(f"project.fps must be 24, 30, or 60; got {fps}")
        return cls(
            title=str(d.get("title", "")),
            aspect=aspect,
            fps=fps,
            render_backend=backend,
            tts_provider=tts,
            voice_id=str(d.get("voice_id", "")),
            base_url=str(d.get("base_url", "")),
            created_at=str(d.get("created_at", "")),
            extra=dict(d.get("extra", {})),
            loaded_schema_version=int(d.get("schema_version", 2)),
        )
