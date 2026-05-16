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
        #
        # Use `b64_json` instead of the (deprecated) URL form: it eliminates
        # the second HTTP hop, avoids urllib SSL/timeout pitfalls, and
        # removes the temp-file dance. The bytes come back inline with the
        # generate response.
        response = client.images.generate(
            model=_MODEL_VERSION,
            prompt=request.prompt,
            size="1024x1792",
            quality="hd",
            n=1,
            response_format="b64_json",
        )

        b64 = response.data[0].b64_json
        if not b64:
            raise ClipwrightError(
                "DALL·E 3 returned no image data",
                fix="Check your prompt for policy violations or try again",
            )

        import base64
        import binascii

        try:
            png_bytes = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ClipwrightError(
                f"DALL·E 3 returned malformed base64 data: {exc}",
                fix="Retry the generation; this usually indicates a transient API issue",
            ) from exc

        out.parent.mkdir(parents=True, exist_ok=True)

        # Upscale to exactly 1080×1920 if Pillow is available; otherwise
        # write the 1024×1792 PNG as-is. The bare-except covers PIL import
        # failure, PIL unable-to-decode (e.g. the API returned non-PNG bytes
        # that decoded cleanly from base64 but aren't an image), and any
        # other PIL runtime issue — none of those are worth crashing the
        # whole run when we can fall back to the raw bytes.
        try:
            import io

            from PIL import Image  # type: ignore[import-untyped]
            img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
            img = img.resize((request.width, request.height), Image.LANCZOS)
            img.save(str(out), format="PNG")
        except Exception:  # noqa: BLE001
            out.write_bytes(png_bytes)

        write_cache(out, h, self.name, request.slot)
        return GenerateResult(path=out, provider=self.name, prompt=request.prompt)
