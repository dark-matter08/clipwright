"""Manhwa-recap Remotion backend.

Builds the `ManhwaInputs` props shape (see `remotion/src/schema.ts`) from
a v2 project's video manifest + per-video artifacts:

  - panels at `<project>/sources/panels/.../pNN.webp` (or any path the
    segment's `source` field points at)
  - voiceover TTS at `voiceover/audio/<video>/<seg>.mp3`
  - per-segment camera keyframes at `camera/<seg>.json`
  - captions parsed from voiceover timestamps if present

Distinct from `remotion_backend.py` (the legacy single-recording flow)
because every segment is its own image with its own Ken Burns motion —
there's no shared `source_video` or `gradient`.

Asset staging: every absolute path on disk gets copied into
`remotion/public/_manhwa/<video_id>/` and the inputs JSON references
the relative key so Remotion's `staticFile()` can resolve it.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ..schema import Segment, Video, load_project, load_video, paths

REMOTION_DIR = Path(__file__).resolve().parents[3] / "remotion"
COMPOSITION_ID = "ManhwaRecap"


class ManhwaRenderError(RuntimeError):
    pass


@dataclass
class _StagingArea:
    """Paths under `remotion/public/_manhwa/<video_id>/` for one render."""

    root: Path
    video_id: str

    @property
    def panels_dir(self) -> Path:
        return self.root / "panels"

    @property
    def audio_dir(self) -> Path:
        return self.root / "audio"

    def relative(self, path: Path) -> str:
        """Return the path relative to `remotion/public/` for staticFile()."""
        rel = path.resolve().relative_to((REMOTION_DIR / "public").resolve())
        return str(rel)


def _require_node_deps() -> None:
    if shutil.which("npx") is None:
        raise ManhwaRenderError("npx not found on PATH — install Node.js >=18")
    if not (REMOTION_DIR / "node_modules").exists():
        raise ManhwaRenderError(
            f"remotion dependencies missing: run `cd {REMOTION_DIR} && npm install`"
        )


def _stage_for_video(video_id: str) -> _StagingArea:
    root = REMOTION_DIR / "public" / "_manhwa" / video_id
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    return _StagingArea(root=root, video_id=video_id)


def _stage_file(src: Path, dst_dir: Path, name: str | None = None) -> Path:
    """Copy `src` into `dst_dir`, returning the resolved destination path.

    `name` defaults to `src.name`. The caller is responsible for picking
    a unique name when multiple sources collide. We use the segment id
    (`seg_NNN`) as a prefix for clarity in the staged tree.
    """
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / (name or src.name)
    shutil.copyfile(src, dst)
    return dst


def _load_camera(project_dir: Path, video_id: str, seg_id: str) -> list[dict]:
    """Read `camera/<seg>.json` produced by the agent.

    Two shapes are tolerated:
      - new manhwa shape: `{ "keyframes": [{t, zoom, pan_x, pan_y}, …] }`
      - legacy shape from `clipwright.outro.camera`: `{ "keyframes":
        [{t, zoom, focus: [x,y]}, …] }` — we translate `focus` →
        `pan_x/pan_y` deltas (focus is in [0..1], pan is [-1..+1]).

    Missing file → empty list; `PanelSegment` then applies a default
    1.0→1.08 gentle zoom so the panel still has motion.
    """
    cam_path = project_dir / "camera" / f"{seg_id}.json"
    if not cam_path.exists():
        return []
    try:
        payload = json.loads(cam_path.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    raw = payload.get("keyframes") or []
    out: list[dict] = []
    for kf in raw:
        if not isinstance(kf, dict):
            continue
        t = float(kf.get("t", 0.0))
        zoom = float(kf.get("zoom", 1.0))
        if "pan_x" in kf or "pan_y" in kf:
            pan_x = float(kf.get("pan_x", 0.0))
            pan_y = float(kf.get("pan_y", 0.0))
        elif "focus" in kf and isinstance(kf["focus"], (list, tuple)) and len(kf["focus"]) == 2:
            # Legacy `focus` is a [0..1] anchor point. Translate to a
            # pan offset centered on (0.5, 0.5) so a focus of (0.5, 0.8)
            # pans the image up so that focus point lands on screen
            # center — pan_y is negative (move image up).
            fx, fy = float(kf["focus"][0]), float(kf["focus"][1])
            pan_x = (0.5 - fx) * 0.5  # 0.5 scale-down so the translation isn't extreme
            pan_y = (0.5 - fy) * 0.5
        else:
            pan_x = 0.0
            pan_y = 0.0
        out.append({"t": t, "zoom": zoom, "pan_x": pan_x, "pan_y": pan_y})
    return out


def _load_captions(project_dir: Path, video_id: str, seg: Segment, script_text: str) -> list[dict]:
    """Build caption events for one segment from voiceover timestamps.

    Each TTS mp3 has a sibling `<seg>.timestamps.json` with word-level
    `[{word, start, end}, …]` written by `clipwright tts-segment`. We
    coalesce groups of ~5 words into sentence-ish caption blocks so the
    output reads like Reels-style captions, not word-by-word strobing.
    """
    audio_dir = paths.video_audio_dir(project_dir, video_id)
    ts_path = audio_dir / f"{seg.id}.timestamps.json"
    if not ts_path.exists():
        # Fallback: one block covering the whole segment with the
        # script's full text.
        if not script_text:
            return []
        return [{"text": script_text, "start": 0.0, "end": seg.target_duration}]
    try:
        payload = json.loads(ts_path.read_text())
    except (json.JSONDecodeError, OSError):
        return []
    words = payload.get("words") or payload.get("segments") or []
    # Tolerate both whisper-style flat shape and our own shape.
    flat: list[dict] = []
    for w in words:
        if "words" in w and isinstance(w["words"], list):
            flat.extend(w["words"])
        else:
            flat.append(w)
    if not flat:
        return []
    chunks: list[dict] = []
    WORDS_PER_CHUNK = 5
    for i in range(0, len(flat), WORDS_PER_CHUNK):
        group = flat[i : i + WORDS_PER_CHUNK]
        text = " ".join((w.get("word") or w.get("text") or "").strip() for w in group).strip()
        if not text:
            continue
        start = float(group[0].get("start", group[0].get("t", 0.0)))
        end = float(group[-1].get("end", start + 1.0))
        chunks.append({"text": text, "start": start, "end": end})
    return chunks


def _theme_for_project(template_id: str, override: str | None) -> str:
    """Pick a theme name. Explicit override wins; otherwise default per
    template (manhwa-recap-* → dark-fantasy, product-demo → minimal-dark)."""
    if override:
        return override
    if template_id.startswith("manhwa-recap"):
        return "dark-fantasy"
    if template_id == "product-demo":
        return "minimal-dark"
    return "dark-fantasy"


def build_inputs(
    *,
    project_dir: Path,
    video_id: str,
    fps: int,
    width: int,
    height: int,
    theme_override: str | None = None,
) -> dict:
    """Return the JSON props for the ManhwaRecap composition.

    Stages every panel + audio file into `remotion/public/_manhwa/<id>/`
    so Remotion's `staticFile()` can find them. Reads camera keyframes
    and caption timestamps from the project's per-video tree.
    """
    project_dir = Path(project_dir).resolve()
    project = load_project(project_dir)
    video = load_video(project_dir, video_id)

    if not video.segments:
        raise ManhwaRenderError(
            f"video {video_id} has zero segments — run "
            f"`clipwright video doctor {video_id}` for diagnostics"
        )

    stage = _stage_for_video(video_id)

    # Script clip lookup so captions can fall back to plain text when
    # word-level timestamps are missing.
    script_path = paths.video_script_path(project_dir, video_id)
    script_clips: dict[str, str] = {}
    if script_path.exists():
        try:
            payload = json.loads(script_path.read_text())
            for c in payload.get("clips") or []:
                if isinstance(c, dict) and c.get("id"):
                    script_clips[str(c["id"])] = str(c.get("text") or "")
        except (json.JSONDecodeError, OSError):
            pass

    audio_dir = paths.video_audio_dir(project_dir, video_id)

    seg_inputs: list[dict] = []
    for seg in video.segments:
        if not seg.source:
            raise ManhwaRenderError(
                f"segment {seg.id} has empty `source` — run "
                f"`clipwright video doctor {video_id}` for diagnostics"
            )
        panel_src = project_dir / seg.source
        if not panel_src.exists():
            raise ManhwaRenderError(
                f"segment {seg.id} source `{seg.source}` doesn't exist on disk"
            )
        # Stage the panel under a seg-id-prefixed name so multiple
        # segments using the same panel path don't collide.
        suffix = panel_src.suffix or ".png"
        staged_panel = _stage_file(panel_src, stage.panels_dir, f"{seg.id}{suffix}")
        rel_panel = stage.relative(staged_panel)

        # Audio (optional).
        audio_src = audio_dir / f"{seg.id}.mp3"
        rel_audio: str | None = None
        if seg.voiceover.enabled and audio_src.exists():
            staged_audio = _stage_file(audio_src, stage.audio_dir, f"{seg.id}.mp3")
            rel_audio = stage.relative(staged_audio)

        # Camera + captions.
        camera = _load_camera(project_dir, video_id, seg.id)
        script_text = script_clips.get(seg.voiceover.script_clip_id, "")
        captions = _load_captions(project_dir, video_id, seg, script_text)

        seg_inputs.append({
            "id": seg.id,
            "source": rel_panel,
            "duration": float(seg.target_duration),
            "audio_path": rel_audio,
            "camera": camera,
            "captions": captions,
            "chapter": seg.chapter or "",
            "label": seg.label or "",
        })

    theme = _theme_for_project(project.template_id, theme_override)
    return {
        "fps": fps,
        "width": width,
        "height": height,
        "theme": theme,
        "show_chapter_chips": True,
        "segments": seg_inputs,
    }


def render(
    *,
    project_dir: Path,
    video_id: str,
    out: Path,
    fps: int = 30,
    width: int = 1080,
    height: int = 1920,
    theme_override: str | None = None,
) -> Path:
    """Render the manhwa-recap composition to `out`. Returns `out` on success."""
    _require_node_deps()
    inputs = build_inputs(
        project_dir=Path(project_dir),
        video_id=video_id,
        fps=fps,
        width=width,
        height=height,
        theme_override=theme_override,
    )

    project_dir = Path(project_dir).resolve()
    props_path = project_dir / "out" / "manhwa_inputs.json"
    props_path.parent.mkdir(parents=True, exist_ok=True)
    props_path.write_text(json.dumps(inputs, indent=2))

    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "npx", "remotion", "render",
        "src/index.ts", COMPOSITION_ID,
        str(out.resolve()),
        "--props", str(props_path.resolve()),
        "--log", "info",
    ]
    r = subprocess.run(cmd, cwd=str(REMOTION_DIR))
    if r.returncode != 0:
        raise ManhwaRenderError(f"remotion render failed (exit {r.returncode})")
    return out


# Suppress unused-import warning (Video is referenced via type hints
# through load_video — keep it imported so future signature changes
# don't quietly break).
_ = Video
