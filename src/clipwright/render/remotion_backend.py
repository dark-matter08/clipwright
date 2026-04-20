"""Remotion render backend.

Assembles an inputs.json from segments + camera + audio + captions, then
shells out to `npx remotion render` inside the repo-level `remotion/` package.

Clipwright's Python side stays authoritative: it decides what plays, when,
and how long. Remotion is purely the renderer.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REMOTION_DIR = Path(__file__).resolve().parents[3] / "remotion"
COMPOSITION_ID = "ClipwrightVideo"


class RemotionError(RuntimeError):
    pass


def _require_node_deps() -> None:
    if shutil.which("npx") is None:
        raise RemotionError("npx not found on PATH — install Node.js >=18")
    if not (REMOTION_DIR / "node_modules").exists():
        raise RemotionError(
            f"remotion dependencies missing: run `cd {REMOTION_DIR} && npm install`"
        )


def _stage_asset(src: Path, rel_name: str) -> str:
    """Copy `src` into remotion/public/<STAGE_DIR>/ and return relative staticFile key."""
    stage = REMOTION_DIR / "public" / "_work"
    stage.mkdir(parents=True, exist_ok=True)
    dst = stage / rel_name
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    shutil.copyfile(src, dst)
    return f"_work/{rel_name}"


def clear_stage() -> None:
    stage = REMOTION_DIR / "public" / "_work"
    if stage.exists():
        for p in stage.iterdir():
            try:
                p.unlink()
            except IsADirectoryError:
                shutil.rmtree(p)


def build_inputs(
    *,
    out_dir: Path,
    source_video: Path,
    fps: int,
    width: int,
    height: int,
    outro: Path | None,
    outro_duration: float,
    brand_title: str = "Clipwright",
    gradient: str | None = "gradient.jpg",
) -> dict:
    segments_doc = json.loads((out_dir / "segments.json").read_text())
    camera_doc = json.loads((out_dir / "camera.json").read_text())
    audio_dir = out_dir / "audio"
    subs_dir = out_dir / "subs"

    # Pair audio to segments by index (script init emits one clip per segment).
    per_clip_audio = sorted(audio_dir.glob("*.mp3")) if audio_dir.exists() else []
    audio_by_idx: dict[int, Path] = {i: a for i, a in enumerate(per_clip_audio)}

    segments_out: list[dict] = []
    for i, seg in enumerate(segments_doc["segments"]):
        audio = audio_by_idx.get(i)
        captions: list[dict] = []
        if audio is not None:
            cid = audio.stem
            idx = subs_dir / f"{cid}.json"
            if idx.exists():
                captions = json.loads(idx.read_text())
        segments_out.append({
            "source_start": float(seg["source_start"]),
            "source_end": float(seg["source_end"]),
            "duration": float(seg["duration"]),
            "moments": [
                {"t": m["t"], "type": m["type"], "label": m.get("label", "")}
                for m in (seg.get("moments") or [])
            ],
            "audio_path": str(audio.resolve()) if audio is not None else None,
            "captions": captions,
        })

    # Remotion's dev server only serves paths under remotion/public/.
    # Stage every non-public asset as a symlink under public/_work/ and pass
    # the relative key so the composition can call staticFile() on it.
    clear_stage()
    source_key = _stage_asset(source_video, "source.mp4")

    segments_norm = []
    for i, s in enumerate(segments_out):
        s2 = dict(s)
        if s2.get("audio_path"):
            s2["audio_path"] = _stage_asset(Path(s2["audio_path"]), f"audio_{i:03d}.mp3")
        segments_norm.append(s2)

    outro_key: str | None = None
    if outro:
        outro_key = _stage_asset(outro, "outro.mp4")

    return {
        "fps": fps,
        "width": width,
        "height": height,
        "source_video": source_key,
        "gradient": gradient,
        "segments": segments_norm,
        "keyframes": camera_doc.get("keyframes", []),
        "outro": outro_key,
        "outro_duration": float(outro_duration) if outro else 0.0,
        "brand_title": brand_title,
    }


def render(
    *,
    out_dir: Path,
    source_video: Path,
    fps: int,
    width: int,
    height: int,
    outro: Path | None,
    outro_duration: float,
    out: Path,
    brand_title: str = "Clipwright",
) -> Path:
    _require_node_deps()
    inputs = build_inputs(
        out_dir=out_dir,
        source_video=source_video,
        fps=fps, width=width, height=height,
        outro=outro, outro_duration=outro_duration,
        brand_title=brand_title,
    )
    props_path = out_dir / "remotion_inputs.json"
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
        raise RemotionError(f"remotion render failed (exit {r.returncode})")
    return out


def copy_gradient(choice: str) -> Path:
    """Copy a named gradient (dark|light) or an explicit path into remotion/public/gradient.jpg."""
    public = REMOTION_DIR / "public"
    public.mkdir(parents=True, exist_ok=True)
    dst = public / "gradient.jpg"
    if choice in ("dark", "light"):
        src = public / f"gradient-{choice}.jpg"
        if not src.exists():
            raise RemotionError(
                f"{src} missing — run `python scripts/make_gradients.py`"
            )
    else:
        src = Path(choice).expanduser().resolve()
        if not src.exists():
            raise RemotionError(f"gradient file not found: {src}")
    shutil.copyfile(src, dst)
    return dst
