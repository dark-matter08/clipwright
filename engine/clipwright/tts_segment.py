"""Per-segment TTS synthesis in the v1 project layout (SRS P0.6).

Synthesizes the voiceover for one segment, stretching the result to its
`target_duration`, and writes outputs into the v1 layout so that
`caption_segment` and `render_segment` can consume them with no rewiring:

    <project>/voiceover/audio/<seg_id>.mp3
    <project>/voiceover/audio/<seg_id>.timestamps.json
    <project>/voiceover/audio/<seg_id>.cache.json   ← SRS §5.8

Closes the per-segment loop end-to-end (script → audio → captions → render),
which is the SRS Phase 0 exit prerequisite for Phase 1 desktop work.

Provider + voice resolution:
  1. Clip-level override: `script.json#clips[].voice.{provider,voice_id}`
  2. Project default:    `project.json#tts_provider` + `project.json#voice_id`

Time-stretch behavior:
  - Synthesize at the provider's natural speed.
  - If natural duration falls outside `target_seconds * [0.97, 1.03]`,
    apply ffmpeg `atempo` (pitch preserved) to bring it into range, and
    rescale the character timestamps to match.
  - Stretching is **bidirectional** — speed up when audio is too long,
    slow down when audio is too short. The user-feedback rule
    "never slow down" was reversed once concat-time dead air between
    segments became the bigger annoyance.
  - Slow-down is capped at `0.80×` (the audio is allowed to play back at
    80% of natural speed, no slower). Beyond that, even the best TTS
    provider's output starts to sound slurred and the right answer is to
    rewrite the script with more words for that beat — see the agent
    prompt's "Voiceover ↔ segment alignment" guidance. When the cap
    fires we still apply the maximum allowed slowdown so the trailing
    gap is as small as possible, and the result carries
    `stretched=True, stretch_clamped=True` so the caller can warn.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .cache import read_input_hash as _read_cache_hash
from .cache import write_input_hash as _write_cache
from .ffmpeg import probe_duration, require, shift_pitch, stretch_audio
from .schema import (
    Project,
    Segment,
    Video,
    load_project,
    load_video,
)
from .schema import (
    paths as schema_paths,
)
from .tts import PROVIDERS, get_provider


class TTSSegmentError(Exception):
    """Per-segment TTS failure with a fix hint."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


#: Smallest atempo ratio allowed when slowing TTS to fill a segment.
#: 0.80 ≈ 20% slower — audible but not slurred for Kokoro / ElevenLabs.
#: Below this the audio gets noticeably degraded and the right answer is
#: to rewrite the script with more words for that beat.
MIN_SLOW_ATEMPO = 0.80


@dataclass
class TTSSegmentResult:
    seg_id: str
    mp3_path: Path
    timestamps_path: Path
    provider: str
    voice: str
    target_seconds: float
    natural_seconds: float       # raw provider duration before stretch
    stretched: bool              # True iff atempo ratio was applied
    #: True iff a slowdown was clamped at MIN_SLOW_ATEMPO. Indicates the
    #: script for this segment is materially shorter than the segment's
    #: `target_duration` — caller should consider rewriting the clip's
    #: `text` rather than padding harder.
    stretch_clamped: bool = False
    #: The post-stretch duration on disk (== target_seconds when stretch
    #: was unclamped, otherwise the clamped result). Useful when callers
    #: want to know the actual final audio length.
    final_seconds: float = 0.0
    cached: bool = False         # True iff we skipped recompute
    input_hash: str = ""


def tts_segment(
    project_dir: Path,
    seg_id: str,
    *,
    video_id: str = "main",
    force: bool = False,
) -> TTSSegmentResult:
    """Synthesize, stretch, and persist TTS outputs for one segment.

    Args:
        project_dir: project root.
        seg_id: stable segment id.
        video_id: which video's timeline owns this segment. Default "main".
        force: bypass the content-hash cache.
    """
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    video = load_video(project_dir, video_id)

    seg = video.by_id(seg_id)
    if seg is None:
        raise TTSSegmentError(
            f"segment {seg_id!r} not found in video {video_id!r}",
            fix="Run `clipwright video list` and `clipwright status` to see valid ids.",
        )

    if not seg.voiceover.enabled:
        raise TTSSegmentError(
            f"segment {seg_id}: voiceover is disabled",
            fix=f"Set `voiceover.enabled = true` on the segment in videos/{video_id}.json.",
        )

    clip = _resolve_clip(project_dir, video_id, seg)
    text = (clip.get("text") or "").strip()
    if not text:
        raise TTSSegmentError(
            f"segment {seg_id}: script clip has no text",
            fix=f"Fill `text` for clip {clip.get('id', '?')!r} in voiceover/scripts/{video_id}.json.",
        )

    voice_cfg = resolve_voice_config(project, video, clip)
    provider_name, voice_id = voice_cfg.provider, voice_cfg.voice_id
    if provider_name not in PROVIDERS:
        raise TTSSegmentError(
            f"unknown TTS provider {provider_name!r}",
            fix=f"Set tts_provider to one of: {', '.join(PROVIDERS)}.",
        )

    target_seconds = float(
        clip.get("target_seconds")
        if clip.get("target_seconds") is not None
        else seg.target_duration
    )
    if target_seconds <= 0:
        raise TTSSegmentError(
            f"segment {seg_id}: target_seconds must be > 0 (got {target_seconds})",
            fix="Fix `target_duration` on the segment or `target_seconds` on the clip.",
        )

    audio_dir = schema_paths.video_audio_dir(project_dir, video_id)
    audio_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = schema_paths.video_audio_mp3(project_dir, video_id, seg_id)
    ts_path = schema_paths.video_audio_timestamps(project_dir, video_id, seg_id)
    cache_path = schema_paths.video_audio_cache(project_dir, video_id, seg_id)

    # Clip speed wins over the persona's, so a single rushed beat can be
    # slowed without editing the persona everything else shares.
    speed = float(clip.get("speed") or voice_cfg.speed or 1.0)
    tone = {
        "pitch_semitones": round(voice_cfg.pitch_semitones, 3),
        "instructions": voice_cfg.instructions,
        "stability": round(voice_cfg.stability, 3),
        "similarity_boost": round(voice_cfg.similarity_boost, 3),
        "style": round(voice_cfg.style, 3),
    }
    input_hash = _compute_input_hash(
        text=text,
        provider=provider_name,
        voice=voice_id,
        target_seconds=target_seconds,
        speed=speed,
        tone=tone,
    )

    if not force and mp3_path.exists() and ts_path.exists():
        if _read_cache_hash(cache_path) == input_hash:
            return TTSSegmentResult(
                seg_id=seg_id,
                mp3_path=mp3_path,
                timestamps_path=ts_path,
                provider=provider_name,
                voice=voice_id,
                target_seconds=target_seconds,
                natural_seconds=probe_duration(mp3_path),
                stretched=False,
                cached=True,
                input_hash=input_hash,
            )

    require()  # ffmpeg/ffprobe on PATH (needed for stretch + duration probe)

    provider = get_provider(provider_name)
    synth_kwargs: dict = {"voice": voice_id}
    # Each provider takes a different subset of the persona's tone
    # controls; passing an unknown kwarg is a TypeError, so this fans out
    # explicitly rather than splatting the whole config.
    if provider_name == "kokoro" and abs(speed - 1.0) > 1e-3:
        # Kokoro's speed multiplier keeps token timestamps correct, so
        # it's applied at synthesis rather than as a post-stretch.
        synth_kwargs["speed"] = speed
    elif provider_name == "openai" and voice_cfg.instructions.strip():
        # Free-text delivery steering — the strongest tone lever any
        # provider exposes, and OpenAI-only.
        synth_kwargs["instructions"] = voice_cfg.instructions.strip()
    provider.synthesize(text, out_mp3=mp3_path, out_timestamps=ts_path, **synth_kwargs)

    # Pitch is nobody's native feature — shift it ourselves, before the
    # duration probe, so the time-stretch below still lands on target.
    if abs(voice_cfg.pitch_semitones) > 1e-3:
        shift_pitch(mp3_path, voice_cfg.pitch_semitones)

    natural = probe_duration(mp3_path)
    stretched = False
    stretch_clamped = False
    final_seconds = natural
    # Bidirectional time-stretch. The goal is no audible dead air between
    # segments after concat. atempo > 1 speeds up; < 1 slows down.
    #   - natural >> target → speed up (no cap; uncapped speed-up is fine
    #     for Kokoro/ElevenLabs up to ~2× before it sounds chipmunky).
    #   - natural << target → slow down, but only down to MIN_SLOW_ATEMPO
    #     (0.80). Beyond that the audio degrades and the right answer is
    #     to rewrite the script for that beat with more words.
    #   - within ±3% of target → leave it; imperceptible.
    if natural > target_seconds * 1.03 or natural < target_seconds * 0.97:
        # Desired stretch ratio (>1 speeds up, <1 slows down).
        desired_ratio = natural / target_seconds
        # Clamp slowdown only; speed-up is uncapped.
        if desired_ratio < MIN_SLOW_ATEMPO:
            effective_target = natural / MIN_SLOW_ATEMPO
            stretch_clamped = True
        else:
            effective_target = target_seconds

        tmp = audio_dir / f"{seg_id}.stretched.mp3"
        ratio = stretch_audio(mp3_path, tmp, effective_target)
        tmp.replace(mp3_path)
        align = json.loads(ts_path.read_text())
        for key in ("character_start_times_seconds", "character_end_times_seconds"):
            if key in align:
                align[key] = [round(t / ratio, 4) for t in align[key]]
        ts_path.write_text(json.dumps(align))
        stretched = True
        final_seconds = effective_target

    _write_cache(cache_path, input_hash)
    return TTSSegmentResult(
        seg_id=seg_id,
        mp3_path=mp3_path,
        timestamps_path=ts_path,
        provider=provider_name,
        voice=voice_id,
        target_seconds=target_seconds,
        natural_seconds=natural,
        stretched=stretched,
        stretch_clamped=stretch_clamped,
        final_seconds=final_seconds,
        cached=False,
        input_hash=input_hash,
    )


# ---------------------------------------------------------------------------
# Resolution helpers
# ---------------------------------------------------------------------------


def _resolve_clip(project_dir: Path, video_id: str, seg: Segment) -> dict:
    """Find the per-video `voiceover/scripts/<video>.json` clip linked to this segment.

    Lookup order matches `agent/prompt.py#_find_script_clip`:
      1. Clip whose `id` equals `seg.voiceover.script_clip_id`.
      2. Clip whose `segment_id` references this segment.
    """
    script_path = schema_paths.video_script_path(project_dir, video_id)
    rel_path = f"voiceover/scripts/{video_id}.json"
    if not script_path.exists():
        raise TTSSegmentError(
            f"{rel_path} not found in {project_dir}",
            fix=f"Create {rel_path} with a clip for this segment.",
        )
    try:
        payload = json.loads(script_path.read_text())
    except json.JSONDecodeError as e:
        raise TTSSegmentError(
            f"{rel_path}: invalid JSON: {e}",
            fix=f"Validate with `python -m json.tool {rel_path}`.",
        ) from e

    clips = payload.get("clips") or []
    needle_id = seg.voiceover.script_clip_id
    for clip in clips:
        if needle_id and clip.get("id") == needle_id:
            return clip
    for clip in clips:
        if clip.get("segment_id") == seg.id:
            return clip
    raise TTSSegmentError(
        f"no script clip linked to segment {seg.id!r}",
        fix=(
            f"Add a clip to {rel_path} with id={seg.voiceover.script_clip_id!r} "
            f"or segment_id={seg.id!r}."
        ),
    )


def resolve_voice_config(project: Project, video: Video, clip: dict):
    """Resolve the full voice settings for one segment.

    Precedence (highest first):
      1. Clip-level voice block in the script (per-segment override).
      2. Per-video override in `video.recap_overrides` — keys
         `voice_provider` / `voice_id`, written by the desktop's
         per-video panel.
      3. The project's **persona**, if one is bound. A persona *is* a
         narrator, so its voice travels with it across projects; this is
         also the only layer that carries speed, pitch and the
         provider-specific knobs.
      4. Project-level defaults (`project.tts_provider` / `voice_id`).

    Returns a `VoiceConfig`, so callers get the tone controls and not
    just provider+voice. The persona supplies the baseline and the
    narrower layers override provider/voice on top of it — a per-segment
    voice swap shouldn't silently discard the persona's pitch and speed.
    """
    from .persona import PersonaError, VoiceConfig, load_persona

    voice_block = clip.get("voice") or {}
    overrides = video.recap_overrides or {}

    # Start from the persona's voice when there is one — it carries the
    # tone controls no other layer has.
    cfg = VoiceConfig()
    persona_id = str(
        overrides.get("persona_id") or getattr(project, "persona_id", "") or ""
    )
    if persona_id:
        try:
            cfg = load_persona(persona_id).voice
        except PersonaError:
            # A dangling persona reference must not stop a render. The
            # project's own defaults below still produce audio.
            cfg = VoiceConfig()

    provider = str(
        voice_block.get("provider")
        or overrides.get("voice_provider")
        or (cfg.provider if persona_id else "")
        or project.tts_provider
    )
    voice_id = str(
        voice_block.get("voice_id")
        or clip.get("voice_id")
        or overrides.get("voice_id")
        or (cfg.voice_id if persona_id else "")
        or project.voice_id
        or ""
    )
    cfg.provider = provider
    cfg.voice_id = voice_id
    return cfg


def _resolve_provider_and_voice(
    project: Project, video: Video, clip: dict
) -> tuple[str, str]:
    """Back-compat shim — provider + voice only.

    Kept because tests and older callers use it; `resolve_voice_config`
    is the full answer.
    """
    cfg = resolve_voice_config(project, video, clip)
    return cfg.provider, cfg.voice_id


# ---------------------------------------------------------------------------
# Cache (sidecar pattern, SRS §5.8)
# ---------------------------------------------------------------------------


def _compute_input_hash(
    *,
    text: str,
    provider: str,
    voice: str,
    target_seconds: float,
    speed: float = 1.0,
    tone: dict | None = None,
) -> str:
    payload = {
        "tool_version": __version__,
        "provider": provider,
        "voice": voice,
        "target_seconds": round(target_seconds, 4),
        "speed": round(speed, 3),
        "text": text,
    }
    # Every persona tone control that changes the audio has to be in the
    # key. Leaving pitch out meant re-rendering after a tweak returned
    # the cached mp3 and looked like the control did nothing.
    if tone:
        payload["tone"] = tone
    blob = json.dumps(payload, sort_keys=True).encode()
    return "sha256:" + hashlib.sha256(blob).hexdigest()


# Cache sidecar I/O lives in `.cache` — imported above as `_read_cache_hash`
# / `_write_cache` to keep the rest of this module unchanged.
