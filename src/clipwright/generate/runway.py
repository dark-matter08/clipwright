"""Runway Gen-3 / Gen-4 text-to-video / image-to-video provider.

Environment variable required:
  RUNWAYML_API_KEY  — RunwayML API key (https://app.runwayml.com/account)

Model: gen3a_turbo (fastest Runway model, ~30s).

Runway uses a submit-then-poll pattern with a task_id.
Polling continues until state is "SUCCEEDED" or "FAILED".
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from ..errors import ClipwrightError
from .base import GenerateProvider, GenerateRequest, GenerateResult
from .cache import cache_hash, is_cached, write_cache

_MODEL_VERSION = "gen3a_turbo"
_POLL_INTERVAL = 8  # seconds


class RunwayProvider(GenerateProvider):
    name = "runway"

    def validate_env(self) -> None:
        if not os.environ.get("RUNWAYML_API_KEY"):
            raise ClipwrightError(
                "RUNWAYML_API_KEY is not set",
                fix="export RUNWAYML_API_KEY=<your-key>",
                docs="docs/providers/runway.md",
            )

    def generate(self, request: GenerateRequest, out: Path) -> GenerateResult:
        self.validate_env()
        h = cache_hash(
            prompt=request.prompt,
            image_refs=request.image_refs,
            seed=request.seed,
            duration=request.duration,
            provider=self.name,
            model_version=_MODEL_VERSION,
            slot=request.slot,
        )
        if is_cached(out, h):
            return GenerateResult(path=out, provider=self.name, prompt=request.prompt, cached=True)

        try:
            import runwayml  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ClipwrightError(
                "runwayml is not installed",
                fix="pip install 'clipwright[runway]'",
            ) from exc

        client = runwayml.RunwayML(api_key=os.environ["RUNWAYML_API_KEY"])

        # Build request.
        kwargs: dict = {
            "model": _MODEL_VERSION,
            "prompt_text": request.prompt,
            "duration": int(request.duration),
            "ratio": "720:1280",  # 9:16 portrait
        }
        if request.seed is not None:
            kwargs["seed"] = request.seed

        # Image-to-video: use first image_ref as conditioning frame.
        if request.image_refs and request.image_refs[0].exists():
            import base64
            img_bytes = request.image_refs[0].read_bytes()
            b64 = base64.b64encode(img_bytes).decode()
            mime = "image/png" if str(request.image_refs[0]).endswith(".png") else "image/jpeg"
            kwargs["prompt_image"] = f"data:{mime};base64,{b64}"

        task = client.image_to_video.create(**kwargs)
        task_id = task.id

        # Poll until done.
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            result = client.tasks.retrieve(task_id)
            if result.status == "SUCCEEDED":
                break
            if result.status in ("FAILED", "CANCELLED"):
                raise ClipwrightError(
                    f"Runway generation failed (status={result.status})",
                    fix="Revise the prompt or use --fallback static",
                )
            time.sleep(_POLL_INTERVAL)
        else:
            raise ClipwrightError(
                "Runway generation timed out after 10 minutes",
                fix="Use --fallback static or reduce duration",
            )

        # Download output.
        output_url = result.output[0] if result.output else None
        if not output_url:
            raise ClipwrightError(
                "Runway returned no output URL",
                fix="Check quota or try again",
            )

        import urllib.request
        out.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(output_url, str(out))

        write_cache(out, h, self.name, request.slot)
        return GenerateResult(path=out, provider=self.name, prompt=request.prompt)
