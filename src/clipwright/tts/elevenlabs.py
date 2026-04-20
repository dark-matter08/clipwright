"""ElevenLabs /with-timestamps synthesis. stdlib urllib to keep deps optional."""
from __future__ import annotations

import base64
import json
import urllib.request
from pathlib import Path

ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"


def synthesize(
    text: str,
    voice_id: str,
    api_key: str,
    out_mp3: Path,
    out_timestamps: Path,
    *,
    model_id: str = "eleven_turbo_v2_5",
    output_format: str = "mp3_44100_128",
    stability: float = 0.45,
    similarity_boost: float = 0.75,
    style: float = 0.0,
) -> None:
    body = {
        "text": text,
        "model_id": model_id,
        "output_format": output_format,
        "voice_settings": {
            "stability": stability,
            "similarity_boost": similarity_boost,
            "style": style,
        },
    }
    req = urllib.request.Request(
        ENDPOINT.format(voice_id=voice_id),
        data=json.dumps(body).encode("utf-8"),
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    audio_b64 = payload.get("audio_base64") or payload.get("audio")
    if not audio_b64:
        raise RuntimeError("ElevenLabs response missing audio_base64")
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    out_mp3.write_bytes(base64.b64decode(audio_b64))

    alignment = payload.get("alignment") or payload.get("normalized_alignment")
    if not alignment:
        raise RuntimeError("ElevenLabs response missing alignment")
    out_timestamps.parent.mkdir(parents=True, exist_ok=True)
    out_timestamps.write_text(json.dumps(alignment, indent=2))
