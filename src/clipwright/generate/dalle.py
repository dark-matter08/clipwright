"""OpenAI DALL·E 3 image generation provider.

Environment variable required:
  OPENAI_API_KEY  — OpenAI API key

Produces a PNG image (not a video). Intended for static hero illustration
inside the TitleCard scene when no photo-realistic hero exists.

Output: a 1080×1920 PNG written to `out`.
"""
from __future__ import annotations

import os
from pathlib import Path

from ..errors import ClipwrightError
from .base import GenerateProvider, GenerateRequest, GenerateResult
from .cache import cache_hash, is_cached, write_cache

_MODEL_VERSION = "dall-e-3"


class DalleProvider(GenerateProvider):
    name = "dalle"

    def validate_env(self) -> None:
        if not os.environ.get("OPENAI_API_KEY"):
            raise ClipwrightError(
                "OPENAI_API_KEY is not set",
                fix="export OPENAI_API_KEY=<your-key>",
                docs="docs/providers/dalle.md",
            )

    def generate(self, request: GenerateRequest, out: Path) -> GenerateResult:
        self.validate_env()
        h = cache_hash(
            prompt=request.prompt,
            image_refs=[],   # DALL·E 3 is text-only (no img2img in standard API)
            seed=request.seed,
            duration=0.0,
            provider=self.name,
            model_version=_MODEL_VERSION,
            slot=request.slot,
        )
        if is_cached(out, h):
            return GenerateResult(path=out, provider=self.name, prompt=request.prompt, cached=True)

        try:
            from openai import OpenAI  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ClipwrightError(
                "openai is not installed",
                fix="pip install 'clipwright[dalle]'",
            ) from exc

        client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

        # DALL·E 3 supports 1024×1024, 1024×1792, 1792×1024.
        # 1024×1792 is the closest 9:16 aspect ratio available.
        response = client.images.generate(
            model=_MODEL_VERSION,
            prompt=request.prompt,
            size="1024x1792",
            quality="hd",
            n=1,
            response_format="url",
        )

        image_url = response.data[0].url
        if not image_url:
            raise ClipwrightError(
                "DALL·E 3 returned no image URL",
                fix="Check your prompt for policy violations or try again",
            )

        # Download and save.
        import urllib.request
        tmp = out.with_suffix(".tmp.png")
        out.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(image_url, str(tmp))

        # Upscale to exactly 1080×1920 if Pillow is available.
        try:
            from PIL import Image  # type: ignore[import-untyped]
            img = Image.open(str(tmp)).convert("RGBA")
            img = img.resize((request.width, request.height), Image.LANCZOS)
            img.save(str(out), format="PNG")
            tmp.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            tmp.rename(out)

        write_cache(out, h, self.name, request.slot)
        return GenerateResult(path=out, provider=self.name, prompt=request.prompt)
