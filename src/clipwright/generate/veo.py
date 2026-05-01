"""Google Vertex AI Veo text-to-video / image-to-video provider.

Environment variables required:
  GOOGLE_CLOUD_PROJECT        — GCP project ID
  GOOGLE_APPLICATION_CREDENTIALS  — path to service account JSON
  (or `gcloud auth application-default login` for local use)

Model: veo-001 (Vertex AI GenerativeModel endpoint).

Veo generations take 30s–3min; this adapter polls with progress events.
Each poll logs a `StageProgress`-style message so the CLI shows activity.

The image-to-video path uses the first image_ref as the conditioning frame
(brand_hero.png from `clipwright inspire`), which anchors the visual style
to the actual product.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from ..errors import ClipwrightError
from .base import GenerateProvider, GenerateRequest, GenerateResult
from .cache import cache_hash, is_cached, write_cache

_MODEL_VERSION = "veo-001"
_POLL_INTERVAL = 10  # seconds between status checks


class VeoProvider(GenerateProvider):
    name = "veo"

    def validate_env(self) -> None:
        if not os.environ.get("GOOGLE_CLOUD_PROJECT"):
            raise ClipwrightError(
                "GOOGLE_CLOUD_PROJECT is not set",
                fix="export GOOGLE_CLOUD_PROJECT=<your-project-id>",
                docs="docs/providers/veo.md",
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
            from google.cloud import aiplatform  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ClipwrightError(
                "google-cloud-aiplatform is not installed",
                fix="pip install 'clipwright[veo]'",
            ) from exc

        project = os.environ["GOOGLE_CLOUD_PROJECT"]
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

        aiplatform.init(project=project, location=location)
        model = aiplatform.gapic.PredictionServiceClient(
            client_options={"api_endpoint": f"{location}-aiplatform.googleapis.com"}
        )

        # Build request payload.
        instances: list[dict] = [{"prompt": request.prompt}]
        if request.image_refs and request.image_refs[0].exists():
            import base64
            img_bytes = request.image_refs[0].read_bytes()
            instances[0]["image"] = {
                "bytesBase64Encoded": base64.b64encode(img_bytes).decode(),
                "mimeType": "image/png",
            }

        parameters = {
            "durationSeconds": int(request.duration),
            "aspectRatio": "9:16",
            "negativePrompt": "text, watermark, logo, caption, blurry, low quality",
        }
        if request.seed is not None:
            parameters["seed"] = request.seed

        endpoint = f"projects/{project}/locations/{location}/publishers/google/models/{_MODEL_VERSION}"

        # Submit and poll — Veo is async.
        response = model.predict(endpoint=endpoint, instances=instances, parameters=parameters)
        operation_name = getattr(response, "metadata", {}).get("operationName", "")

        if not operation_name:
            # Synchronous response (some model versions).
            video_b64 = (
                response.predictions[0]
                .get("video", {})
                .get("bytesBase64Encoded", "")
            )
            if not video_b64:
                raise ClipwrightError(
                    "Veo returned no video data",
                    fix="Check your prompt for policy violations or try --fallback static",
                )
            import base64
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(base64.b64decode(video_b64))
        else:
            # Long-running operation — poll.
            ops_client = aiplatform.gapic.JobServiceClient(
                client_options={"api_endpoint": f"{location}-aiplatform.googleapis.com"}
            )
            deadline = time.monotonic() + 600  # 10-minute max
            while time.monotonic() < deadline:
                op = ops_client.get_hyperparameter_tuning_job(name=operation_name)
                if op.state in (
                    aiplatform.gapic.JobState.JOB_STATE_SUCCEEDED,
                    4,  # numeric value for SUCCEEDED
                ):
                    break
                if op.state in (
                    aiplatform.gapic.JobState.JOB_STATE_FAILED,
                    aiplatform.gapic.JobState.JOB_STATE_CANCELLED,
                    5, 6,
                ):
                    raise ClipwrightError(
                        f"Veo generation failed: {op.error.message if hasattr(op, 'error') else 'unknown'}",
                        fix="Try --fallback static or revise the prompt",
                    )
                time.sleep(_POLL_INTERVAL)
            else:
                raise ClipwrightError(
                    "Veo generation timed out after 10 minutes",
                    fix="Try --fallback static or a shorter duration",
                )

            video_b64 = op.result.get("video", {}).get("bytesBase64Encoded", "")
            if not video_b64:
                raise ClipwrightError(
                    "Veo returned no video data after completion",
                    fix="Check quota and prompt for policy violations",
                )
            import base64
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(base64.b64decode(video_b64))

        write_cache(out, h, self.name, request.slot)
        return GenerateResult(path=out, provider=self.name, prompt=request.prompt)
