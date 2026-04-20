"""Typer entrypoint. One subcommand per pipeline stage."""
from __future__ import annotations

import json
import os
from pathlib import Path

import typer
from rich import print as rprint

from . import __version__, config
from .captions.chunker import chars_to_words, chunk_words
from .captions.png_renderer import CaptionStyle, render_all
from .edit.trim import trim as trim_impl
from .ffmpeg import probe_duration, require
from .outro.brand import BrandConfig
from .outro.render import render_outro
from .record.playwright_recorder import record as record_impl
from .render.composer import Segment, SubtitleChunk, render
from .tts.elevenlabs import synthesize

app = typer.Typer(add_completion=False, no_args_is_help=True, help="Clipwright: short-form how-to video pipeline.")


def _root(path: Path | None) -> Path:
    return (path or Path.cwd()).resolve()


def _load_cfg(root: Path) -> config.ProjectConfig:
    return config.load(root)


@app.callback()
def main_cb(version: bool = typer.Option(False, "--version", help="Show version and exit.")) -> None:
    if version:
        rprint(f"clipwright {__version__}")
        raise typer.Exit()


@app.command()
def init(
    directory: Path = typer.Argument(..., help="Project directory to scaffold."),
    url: str = typer.Option("https://example.com", help="Initial URL for the demo."),
    aspect: str = typer.Option("9:16", help="9:16, 16:9, or 1:1."),
) -> None:
    """Scaffold a new Clipwright project."""
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    cfg = config.ProjectConfig(
        name=directory.name,
        aspect=aspect,
        url=url,
    )
    config.write(directory, cfg)

    (directory / "demo.py").write_text(
        '"""Playwright user script. Clipwright calls `run(page, mark)`.\n\n'
        'Call `await mark("action", **data)` to record timestamped moments that\n'
        'drive dead-time trimming and camera keyframes.\n"""\n\n\n'
        "async def run(page, mark):\n"
        '    await page.wait_for_load_state("networkidle")\n'
        "    await page.wait_for_timeout(800)\n"
        '    await mark("settle")\n'
    )
    (directory / "script.json").write_text(
        json.dumps(
            {
                "clips": [
                    {"id": "01_intro", "text": "Hello world. This is a Clipwright demo."}
                ]
            },
            indent=2,
        )
        + "\n"
    )
    rprint(f"[green]Initialized[/green] {directory}")


@app.command()
def record(
    script_path: Path = typer.Argument(None, help="Playwright script (defaults to config.demo_script)."),
    project: Path = typer.Option(None, "--project", help="Project root (defaults to cwd)."),
) -> None:
    """Record the browser session -> video.mp4 + moments.json."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    script = (script_path or root / cfg.demo_script).resolve()
    out_dir = cfg.resolve_out(root)
    video, moments = record_impl(cfg.url, script, out_dir, size=cfg.resolution)
    rprint(f"[green]Recorded[/green] {video} + {moments}")


@app.command()
def trim(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Compute kept ranges from moments.json -> edl.json."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    ranges = trim_impl(
        out_dir / "video.mp4",
        out_dir / "moments.json",
        out_dir / "edl.json",
        pre_roll=cfg.pre_roll,
        post_roll=cfg.post_roll,
        merge_gap=cfg.merge_gap,
        split_gap=cfg.split_gap,
    )
    rprint(f"[green]Trim[/green] {len(ranges)} ranges -> {out_dir / 'edl.json'}")


@app.command()
def tts(
    script_path: Path = typer.Argument(None, help="Voiceover script JSON (defaults to config.voice_script)."),
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Synthesize voiceover per beat with ElevenLabs /with-timestamps."""
    root = _root(project)
    cfg = _load_cfg(root)
    script = (script_path or root / cfg.voice_script).resolve()
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise typer.BadParameter("ELEVENLABS_API_KEY not set")
    out_dir = cfg.resolve_out(root)
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    data = json.loads(script.read_text())
    for clip in data["clips"]:
        cid = clip["id"]
        synthesize(
            clip["text"],
            voice_id=clip.get("voice_id", cfg.voice_id),
            api_key=api_key,
            out_mp3=audio_dir / f"{cid}.mp3",
            out_timestamps=audio_dir / f"{cid}.timestamps.json",
            model_id=cfg.tts_model,
        )
        rprint(f"[green]TTS[/green] {cid}")


@app.command()
def caption(
    project: Path = typer.Option(None, "--project"),
    style_path: Path = typer.Option(None, "--style", help="CaptionStyle JSON override."),
) -> None:
    """Chunk timestamps into 2-word UPPERCASE frames and render caption PNGs."""
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    audio_dir = out_dir / "audio"
    subs_dir = out_dir / "subs"
    subs_dir.mkdir(exist_ok=True)
    style = CaptionStyle.from_json(style_path) if style_path else CaptionStyle(width=cfg.resolution[0], height=cfg.resolution[1])
    for ts_path in sorted(audio_dir.glob("*.timestamps.json")):
        cid = ts_path.name.removesuffix(".timestamps.json")
        align = json.loads(ts_path.read_text())
        words = chars_to_words(align)
        chunks = chunk_words(words, n=2, upper=True)
        render_all(chunks, style, subs_dir / cid)
        rprint(f"[green]Caption[/green] {cid}: {len(chunks)} chunks")


@app.command()
def outro(
    project: Path = typer.Option(None, "--project"),
    preset: str = typer.Option("cyberpunk", "--preset", help="Template name under templates/outros/."),
    brand_path: Path = typer.Option(None, "--brand", help="BrandConfig JSON override."),
) -> None:
    """Render the branded outro card."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    if brand_path:
        brand = BrandConfig.from_json(brand_path)
    else:
        tmpl = Path(__file__).resolve().parent.parent.parent / "templates" / "outros" / f"{preset}.json"
        brand = BrandConfig.from_json(tmpl) if tmpl.exists() else BrandConfig()
    brand.width, brand.height = cfg.resolution
    brand.fps = cfg.fps
    out_path = out_dir / "outro.mp4"
    render_outro(brand, out_path)
    rprint(f"[green]Outro[/green] -> {out_path}")


@app.command("render")
def render_cmd(
    project: Path = typer.Option(None, "--project"),
    no_captions: bool = typer.Option(False, "--no-captions"),
    no_outro: bool = typer.Option(False, "--no-outro"),
    beat_map: Path = typer.Option(
        None,
        "--beat-map",
        help='Explicit clip_id -> range_index JSON, e.g. {"01_intro": 0, "02_reader": 2}. '
        "Defaults to beat_map.json in the project root; falls back to index pairing.",
    ),
) -> None:
    """Compose vertical, mix audio, overlay captions LAST, concat outro."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    edl = json.loads((out_dir / "edl.json").read_text())
    source = Path(edl["video"])

    audio_dir = out_dir / "audio"
    subs_dir = out_dir / "subs"

    per_clip_audio = sorted(audio_dir.glob("*.mp3"))
    ranges = edl["ranges"]

    # Explicit beat_map: clip_id (audio stem) -> range index. Required when len differs.
    beat_map_path = beat_map or (root / "beat_map.json")
    beat_to_range: dict[str, int] = {}
    if beat_map_path.exists():
        beat_to_range = json.loads(beat_map_path.read_text())
    elif len(per_clip_audio) != len(ranges) and per_clip_audio:
        raise typer.BadParameter(
            f"{len(per_clip_audio)} audio clips vs {len(ranges)} ranges — counts differ; "
            f"create beat_map.json mapping clip_id -> range index, or pass --beat-map."
        )

    # Build range_index -> audio lookup.
    audio_by_range: dict[int, Path] = {}
    if beat_to_range:
        stem_to_audio = {a.stem: a for a in per_clip_audio}
        for cid, ri in beat_to_range.items():
            if cid not in stem_to_audio:
                raise typer.BadParameter(f"beat_map references unknown clip {cid!r}")
            if not (0 <= ri < len(ranges)):
                raise typer.BadParameter(f"beat_map range index {ri} out of bounds for {cid!r}")
            audio_by_range[ri] = stem_to_audio[cid]
    else:
        for i, a in enumerate(per_clip_audio):
            if i < len(ranges):
                audio_by_range[i] = a

    segments: list[Segment] = []
    subtitles: list[list[SubtitleChunk]] = []
    for i, (s, e) in enumerate(ranges):
        audio = audio_by_range.get(i)
        if audio is not None:
            dur = probe_duration(audio)
            lead, tail = cfg.lead, cfg.tail
        else:
            dur = float(e) - float(s)
            lead = tail = 0.0
        segments.append(Segment(start=float(s), duration=dur, audio=audio, lead=lead, tail=tail))

        chunks_here: list[SubtitleChunk] = []
        if not no_captions and audio is not None:
            cid = audio.stem
            index_json = subs_dir / f"{cid}.json"
            png_dir = subs_dir / cid
            if index_json.exists() and png_dir.exists():
                for j, ch in enumerate(json.loads(index_json.read_text())):
                    png = png_dir / f"{j:03d}.png"
                    chunks_here.append(
                        SubtitleChunk(
                            start=ch["start"] + lead,
                            end=ch["end"] + lead,
                            png=png,
                        )
                    )
        subtitles.append(chunks_here)

    outro_path = out_dir / "outro.mp4"
    outro_final = outro_path if (not no_outro and outro_path.exists()) else None
    work = out_dir / "work"
    render(
        source=source,
        segments=segments,
        work_dir=work,
        out=out_dir / "final.mp4",
        resolution=cfg.resolution,
        fps=cfg.fps,
        subtitles_per_segment=subtitles,
        outro=outro_final,
    )
    rprint(f"[green]Rendered[/green] {out_dir / 'final.mp4'}")


if __name__ == "__main__":
    app()
