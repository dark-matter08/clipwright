"""Adopt flat v1-style artifacts into a v2 video's per-video layout.

The v2 schema scopes every artifact under `<video_id>/`:
  - `voiceover/scripts/<video_id>.json`
  - `voiceover/audio/<video_id>/<seg>.mp3`
  - `captions/<video_id>/<seg>/*.png`
  - `out/segments/<video_id>/<seg>.mp4`
  - `out/final/<video_id>.mp4`

A project that was migrated v1→v2 on the manifest side but had Claude
(or the user) drive the legacy CLI commands ends up in a hybrid state:
v2 `project.json` + `videos/<id>.json`, but flat artifacts at the v1
root (`script.json`, `out/final.mp4`, `out/segments/*.mp4`). The v2
manifest's `segments[]` is empty because nothing populated it, so the
desktop has zero rows to show.

`adopt_v1_artifacts` is the recovery path:
  1. Move flat artifacts into per-video subdirs (or `<id>.json` files).
  2. Rebuild `segments[]` from `script.json` + `edl.json` so the
     timeline has navigable rows referencing the right source ranges.

Idempotent: a second call after a successful adoption is a no-op
(files already in the v2 paths, segments already in the manifest).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .. import paths
from .video import Video


@dataclass
class AdoptionReport:
    """What happened during one `adopt_v1_artifacts` call."""

    video_id: str
    moved: list[tuple[Path, Path]]
    """`(from, to)` for every file/dir relocated."""
    segments_added: int
    """Count of segments synthesized into the manifest."""
    warnings: list[str]
    """Soft issues — files we couldn't find, ambiguous mappings, etc."""


def adopt_v1_artifacts(project_dir: Path, video_id: str) -> AdoptionReport:
    project_dir = Path(project_dir).resolve()
    moved: list[tuple[Path, Path]] = []
    warnings: list[str] = []

    # ---- 1. Relocate per-video files into the v2 layout. ----

    # script.json (flat) → voiceover/scripts/<id>.json
    flat_script = project_dir / "script.json"
    v2_script = paths.video_script_path(project_dir, video_id)
    if flat_script.exists() and not v2_script.exists():
        v2_script.parent.mkdir(parents=True, exist_ok=True)
        flat_script.rename(v2_script)
        moved.append((flat_script, v2_script))
    elif flat_script.exists() and v2_script.exists():
        warnings.append(
            f"both flat ({flat_script.name}) and v2 ({v2_script}) script files exist; "
            "left them alone — caller should resolve."
        )

    # out/final.mp4 (flat) → out/final/<id>.mp4
    flat_final = project_dir / "out" / "final.mp4"
    v2_final = paths.video_final_path(project_dir, video_id)
    if flat_final.exists() and not v2_final.exists():
        v2_final.parent.mkdir(parents=True, exist_ok=True)
        flat_final.rename(v2_final)
        moved.append((flat_final, v2_final))

    # out/segments/*.mp4 (flat, ignoring `_work/`) → out/segments/<id>/
    flat_segments_dir = project_dir / "out" / "segments"
    v2_segments_dir = paths.video_render_dir(project_dir, video_id)
    if flat_segments_dir.exists():
        for child in flat_segments_dir.iterdir():
            if child.is_dir():
                # Skip directories — `_work/` is intermediates we leave,
                # and an existing `<video_id>/` is what we're writing into.
                continue
            if child.suffix not in {".mp4", ".json"}:
                continue
            target = v2_segments_dir / child.name
            if target.exists():
                continue
            v2_segments_dir.mkdir(parents=True, exist_ok=True)
            child.rename(target)
            moved.append((child, target))

    # voiceover/audio/*.mp3 (flat — older v1 layout) → voiceover/audio/<id>/
    flat_audio_dir = project_dir / "voiceover" / "audio"
    v2_audio_dir = paths.video_audio_dir(project_dir, video_id)
    if flat_audio_dir.exists():
        for child in flat_audio_dir.iterdir():
            if child.is_dir():
                continue
            if child.suffix not in {".mp3", ".json"}:
                continue
            target = v2_audio_dir / child.name
            if target.exists():
                continue
            v2_audio_dir.mkdir(parents=True, exist_ok=True)
            child.rename(target)
            moved.append((child, target))

    # captions/<seg>/ (flat) → captions/<id>/<seg>/
    flat_captions_dir = project_dir / "captions"
    v2_captions_dir = project_dir / "captions" / video_id
    if flat_captions_dir.exists() and not v2_captions_dir.exists():
        # Move every child *except* `style.json` (project-level, shared)
        # and any directory named like the video_id itself.
        candidates = [
            c for c in flat_captions_dir.iterdir()
            if c.is_dir() and c.name != video_id
        ]
        if candidates:
            v2_captions_dir.mkdir(parents=True, exist_ok=True)
            for child in candidates:
                target = v2_captions_dir / child.name
                if target.exists():
                    continue
                child.rename(target)
                moved.append((child, target))

    # ---- 2. Rebuild segments[] from script.json + edl.json. ----

    manifest_path = paths.video_manifest_path(project_dir, video_id)
    if not manifest_path.exists():
        warnings.append(f"no video manifest at {manifest_path}; can't rebuild segments")
        return AdoptionReport(video_id, moved, 0, warnings)

    payload = json.loads(manifest_path.read_text())
    existing_segments = payload.get("segments") or []
    if existing_segments:
        # Manifest already populated — nothing to rebuild. Idempotency
        # only kicks in for the *segment-rebuild* step; relocations
        # above are still no-ops on a re-run because of the `exists()`
        # guards.
        return AdoptionReport(video_id, moved, 0, warnings)

    segments = _rebuild_segments(project_dir, video_id, warnings)
    if not segments:
        warnings.append(
            "couldn't synthesize segments — no script.json clips found. "
            "Manifest left empty; timeline will be blank."
        )
        return AdoptionReport(video_id, moved, 0, warnings)

    payload["segments"] = segments
    payload["schema_version"] = 2
    payload.setdefault("video_id", video_id)
    payload.setdefault("title", video_id)
    payload.setdefault("chat_session_id", "")
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n")
    return AdoptionReport(video_id, moved, len(segments), warnings)


def _rebuild_segments(
    project_dir: Path,
    video_id: str,
    warnings: list[str],
) -> list[dict]:
    """Synthesize a `segments` list from the on-disk artifacts.

    Source of truth: `voiceover/scripts/<id>.json` (script clips with
    `id`, `text`, `target_seconds`, `chapter`, optional `hint`).
    Source-range hint: `out/edl.json` (the recorder's chosen ranges per
    chapter). When clip count matches range count we pair them
    1-to-1; otherwise we leave source_start/end at zero and let the
    user fix later — better than guessing wrong.
    """
    script_path = paths.video_script_path(project_dir, video_id)
    if not script_path.exists():
        return []
    script = json.loads(script_path.read_text())
    clips = script.get("clips") or []
    if not clips:
        return []

    # Try to read EDL for source ranges. The legacy EDL is at out/edl.json
    # (project-root scope, not per-video — there's only ever one
    # recording per video anyway).
    edl_path = project_dir / "out" / "edl.json"
    edl_video_rel = "out/video.mp4"
    ranges: list[tuple[float, float]] = []
    if edl_path.exists():
        try:
            edl = json.loads(edl_path.read_text())
            raw_ranges = edl.get("ranges") or []
            for r in raw_ranges:
                if (
                    isinstance(r, list)
                    and len(r) == 2
                    and all(isinstance(x, (int, float)) for x in r)
                ):
                    ranges.append((float(r[0]), float(r[1])))
            # Also pull the recording path from EDL if present.
            video_field = edl.get("video")
            if isinstance(video_field, str) and video_field:
                p = Path(video_field)
                try:
                    edl_video_rel = str(p.relative_to(project_dir))
                except ValueError:
                    # Absolute path outside project (legacy bug); keep
                    # the default and warn.
                    warnings.append(
                        f"EDL `video` path {video_field!r} is outside the project; "
                        f"using {edl_video_rel} as the source."
                    )
        except (json.JSONDecodeError, OSError) as e:
            warnings.append(f"couldn't read EDL ({edl_path}): {e}")

    pair_with_ranges = len(ranges) == len(clips)
    if not pair_with_ranges and ranges:
        warnings.append(
            f"EDL has {len(ranges)} ranges but script has {len(clips)} clips; "
            "leaving source_start/end at 0 (timeline rows will need manual edit)."
        )

    out: list[dict] = []
    for i, clip in enumerate(clips):
        seg_id = f"seg_{i + 1:03d}"
        chapter = str(clip.get("chapter", "") or "")
        label = chapter or str(clip.get("hint", "") or "").split("→")[0].strip()
        target = float(clip.get("target_seconds", 0) or 0)
        if pair_with_ranges:
            s_start, s_end = ranges[i]
        else:
            s_start, s_end = 0.0, target
        clip_id = str(clip.get("id", "") or "")
        out.append({
            "id": seg_id,
            "source": edl_video_rel,
            "source_start": s_start,
            "source_end": s_end,
            "target_duration": target,
            "kind": "recording",
            "scene_type": None,
            "label": label,
            "chapter": chapter,
            "voiceover": {
                "enabled": True,
                "script_clip_id": clip_id,
            },
            "captions": {
                "enabled": True,
                "ref": f"captions/index.json#{seg_id}" if clip_id else "",
            },
            "camera": {"enabled": False, "ref": ""},
            "annotations": {"enabled": False, "ref": ""},
        })
    # Validate via the Video dataclass so we catch shape mismatches before
    # they hit the desktop's loader.
    try:
        Video.from_dict({
            "schema_version": 2,
            "video_id": video_id,
            "title": video_id,
            "chat_session_id": "",
            "segments": out,
        })
    except (ValueError, KeyError) as e:
        warnings.append(f"synthesized segments failed v2 validation: {e}")
        return []
    return out
