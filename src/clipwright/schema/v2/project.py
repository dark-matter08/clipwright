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
TTSProvider = Literal["kokoro", "elevenlabs", "piper", "openai"]

VALID_ASPECTS: set[str] = {"9:16", "16:9", "1:1"}
VALID_BACKENDS: set[str] = {"remotion", "ffmpeg"}
# vibevoice reserved; add back when a backend ships. See v1/project.py.
VALID_TTS_PROVIDERS: set[str] = {"kokoro", "elevenlabs", "piper", "openai"}


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
    # Templates bound to this project. The FIRST entry is the
    # "primary" — it drives `render_preset` selection and supplies
    # default project settings (aspect, fps, …). Additional entries
    # only contribute behavioral guidance: their `system_prompt`
    # text is concatenated into the agent prompt so the LLM has the
    # full editorial lens for the product. A typical use case is a
    # manhwa-reader platform producing chapter recaps:
    # `["manhwa-recap-single", "product-demo"]` → Remotion renders
    # the recap visually while Claude still knows it's pitching a
    # product.
    template_ids: list[str] = field(default_factory=list)
    # Back-compat alias. v0.x projects used a single `template_id`
    # field; we still serialize it (= template_ids[0] when set) so
    # older readers don't choke, and accept it on load when
    # `template_ids` is absent.
    template_id: str = ""
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
        # Emit `template_ids` whenever any template is bound. The
        # legacy `template_id` mirrors `template_ids[0]` so v0.x
        # readers (and the migration path) still see a meaningful
        # value when this project gets opened by an older binary.
        ids = list(self.template_ids)
        if not ids and self.template_id:
            ids = [self.template_id]
        if ids:
            d["template_ids"] = ids
            d["template_id"] = ids[0]
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
        # Resolve template bindings. Prefer `template_ids` (the
        # current shape); fall back to legacy `template_id` when
        # only the single field is present. Whitespace stripped +
        # empty strings dropped so a stray "" doesn't pollute the
        # list.
        raw_ids = d.get("template_ids")
        if isinstance(raw_ids, list):
            template_ids = [str(x).strip() for x in raw_ids if str(x).strip()]
        else:
            template_ids = []
        legacy_id = str(d.get("template_id", "")).strip()
        if not template_ids and legacy_id:
            template_ids = [legacy_id]
        # Keep `template_id` in sync with template_ids[0] so older
        # callsites reading the single field still work.
        primary = template_ids[0] if template_ids else ""
        return cls(
            title=str(d.get("title", "")),
            aspect=aspect,
            fps=fps,
            render_backend=backend,
            tts_provider=tts,
            voice_id=str(d.get("voice_id", "")),
            base_url=str(d.get("base_url", "")),
            created_at=str(d.get("created_at", "")),
            template_ids=template_ids,
            template_id=primary,
            extra=dict(d.get("extra", {})),
            loaded_schema_version=int(d.get("schema_version", 2)),
        )
