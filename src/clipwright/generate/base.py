"""GenerateProvider ABC — mirrors tts/base.py pattern.

Every generative provider plugin must implement this interface. The contract
is simple: given a structured request, produce a local file (MP4 or PNG).

BYOK throughout: the provider reads API keys from the project environment
(os.environ). Clipwright never proxies credentials.

Providers are discovered by name:
  clipwright generate intro --provider veo    → VeoProvider
  clipwright generate hero  --provider dalle  → DalleProvider
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..errors import ClipwrightError


@dataclass
class GenerateRequest:
    """Structured input to a generation provider.

    Attributes:
        slot:       Target slot type ("intro", "broll", "outro", "hero").
        prompt:     Text prompt describing the desired content.
        image_refs: Local paths to reference images (e.g. brand_hero.png).
                    Providers that support image-to-video use these for
                    brand consistency.
        duration:   Desired clip duration in seconds (video providers only).
        width:      Target canvas width in pixels.
        height:     Target canvas height in pixels.
        seed:       Optional deterministic seed (not all providers honour it).
        extra:      Provider-specific overrides (passed through as-is).
    """
    slot: str
    prompt: str
    image_refs: list[Path] = field(default_factory=list)
    duration: float = 3.0
    width: int = 1080
    height: int = 1920
    seed: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class GenerateResult:
    """Output from a generation provider."""
    path: Path          # local path of the generated file (MP4 or PNG)
    provider: str       # provider name used
    prompt: str         # prompt that produced this result
    cached: bool = False


class GenerateProvider(ABC):
    """Base class for all generative scene providers."""

    #: Canonical name used in CLI --provider flag.
    name: str = ""

    @abstractmethod
    def generate(self, request: GenerateRequest, out: Path) -> GenerateResult:
        """Generate content and write it to `out`.

        Args:
            request: Structured description of what to generate.
            out:     Absolute path where the output file should be written.

        Returns:
            GenerateResult with path=out.

        Raises:
            ClipwrightError: On generation failure, quota, or safety refusal.
        """

    def validate_env(self) -> None:
        """Raise ClipwrightError if required environment variables are missing.

        Called before the generation loop so users get a clear message before
        spending time waiting for a failure. Default implementation is a no-op
        (providers that need keys override this).
        """
        return  # noqa: PIE790 — explicit no-op for ABC method with optional override


def get_provider(name: str) -> GenerateProvider:
    """Return an instantiated provider by name.

    Raises:
        ClipwrightError if the provider name is unknown.
    """
    from .dalle import DalleProvider
    from .runway import RunwayProvider
    from .veo import VeoProvider

    registry: dict[str, type[GenerateProvider]] = {
        "veo": VeoProvider,
        "runway": RunwayProvider,
        "dalle": DalleProvider,
    }
    cls = registry.get(name.lower())
    if cls is None:
        raise ClipwrightError(
            f"unknown generate provider {name!r}",
            fix=f"Use one of: {', '.join(sorted(registry))}",
        )
    return cls()
