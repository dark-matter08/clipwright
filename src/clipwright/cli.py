"""Typer entrypoint. One subcommand per pipeline stage."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import typer
from rich import print as rprint

from . import __version__, config
from .captions.chunker import chars_to_words, chunk_words
from .captions.png_renderer import CaptionStyle, render_all
from .edit import annotations as annotations_mod
from .edit import keyframes as keyframes_mod
from .edit import segments as segments_mod
from .edit.trim import trim as trim_impl
from .errors import ClipwrightError
from .ffmpeg import probe_duration, require, stretch_audio
from .outro.brand import BrandConfig
from .outro.render import render_outro
from .pipeline import Pipeline
from .plan import script_skeleton
from .record.playwright_recorder import record as record_impl
from .render import remotion_backend
from .render.composer import Segment, SubtitleChunk, render
from .tts import get_provider

app = typer.Typer(add_completion=False, no_args_is_help=True, help="Clipwright: short-form how-to video pipeline.")


def _root(path: Path | None) -> Path:
    return (path or Path.cwd()).resolve()


def _load_cfg(root: Path) -> config.ProjectConfig:
    return config.load(root)


def _cache_hash(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


def _read_cache(path: Path) -> str | None:
    try:
        return json.loads(path.read_text()).get("hash")
    except Exception:
        return None


def _write_cache(path: Path, h: str) -> None:
    path.write_text(json.dumps({"hash": h}))


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

    browse_plan = {
        "viewport": {"width": 540, "height": 960, "mobile": True},
        "base_url": url,
        "actions": [
            {
                "type": "navigate",
                "label": "Open the landing page",
                "chapter": "intro",
                "fields": {"url": "/"},
                "wait": 2.5,
            },
            {
                "type": "scroll",
                "label": "Browse what's on offer",
                "chapter": "intro",
                "fields": {"by_y": 600},
                "wait": 2.5,
            },
        ],
    }
    (directory / "browse-plan.json").write_text(json.dumps(browse_plan, indent=2) + "\n")
    rprint(f"[green]Initialized[/green] {directory}")
    rprint("[dim]Next: edit browse-plan.json, then run `clipwright build`[/dim]")


@app.command()
def record(
    script_path: Path = typer.Argument(None, help="Playwright script (defaults to config.demo_script)."),
    project: Path = typer.Option(None, "--project", help="Project root (defaults to cwd)."),
    plan: Path = typer.Option(None, "--plan", help="browse-plan.json to execute instead of a Python script."),
) -> None:
    """Record the browser session -> video.mp4 + moments.json."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    if plan is not None:
        plan_path = plan.resolve()
        video, moments = record_impl(
            cfg.url, None, out_dir,
            size=cfg.resolution,
            mobile=cfg.mobile,
            user_agent=cfg.user_agent,
            plan_path=plan_path,
        )
    else:
        script = (script_path or root / cfg.demo_script).resolve()
        video, moments = record_impl(
            cfg.url, script, out_dir,
            size=cfg.resolution,
            mobile=cfg.mobile,
            user_agent=cfg.user_agent,
        )
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
def segments(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Build segments.json from moments.json (replacement for `trim`)."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    segs = segments_mod.run(
        out_dir / "video.mp4",
        out_dir / "moments.json",
        out_dir / "segments.json",
        lead=cfg.pre_roll,
        trail=cfg.post_roll,
        merge_gap=cfg.merge_gap,
        split_gap=cfg.split_gap,
    )
    rprint(f"[green]Segments[/green] {len(segs)} -> {out_dir / 'segments.json'}")


@app.command()
def keyframes(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Build camera.json (output-timeline keyframes) from segments.json."""
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    plan = keyframes_mod.run(
        out_dir / "segments.json",
        out_dir / "camera.json",
        fps=cfg.fps,
    )
    rprint(
        f"[green]Keyframes[/green] {len(plan.keyframes)} over "
        f"{plan.total_duration:.2f}s -> {out_dir / 'camera.json'}"
    )


@app.command()
def annotations(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Build annotations.json — motion-graphic overlay events — from segments.json."""
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    segs_path = out_dir / "segments.json"
    if not segs_path.exists():
        raise ClipwrightError(
            f"missing {segs_path} — run `clipwright segments` first",
            fix="clipwright segments",
        )
    result = annotations_mod.run(segs_path, out_dir / "annotations.json")
    n = len(result.get("events", []))
    rprint(f"[green]Annotations[/green] {n} event(s) -> {out_dir / 'annotations.json'}")


script_app = typer.Typer(no_args_is_help=True, help="Voiceover script utilities.")
app.add_typer(script_app, name="script")


@script_app.command("init")
def script_init(
    project: Path = typer.Option(None, "--project"),
    overwrite: bool = typer.Option(False, "--overwrite", help="Discard any existing text."),
    draft: bool = typer.Option(
        False,
        "--draft",
        help="Auto-fill text fields with heuristic copy derived from action hints. "
        "Good starting point for non-Claude-Code users; refine before TTS.",
    ),
) -> None:
    """Generate a script.json skeleton from segments.json.

    Writes one clip per segment with `target_seconds` + `hint` (from moment
    labels). Claude Code fills each clip's `text` field next — the CLI
    never calls an LLM. Pass --draft to pre-fill copy from action hints.
    """
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    segments_path = out_dir / "segments.json"
    if not segments_path.exists():
        raise typer.BadParameter(f"missing {segments_path} — run `clipwright segments` first")
    script_path = (root / cfg.voice_script).resolve()
    skeleton = script_skeleton.run(segments_path, script_path, overwrite=overwrite, draft=draft)
    clips = skeleton.get("clips") or []
    missing = [c["id"] for c in clips if not c.get("text")]
    rprint(
        f"[green]Script skeleton[/green] {len(clips)} clips -> {script_path}"
        + (f"\n[yellow]Fill text for:[/yellow] {', '.join(missing)}" if missing else "")
    )


@app.command("review")
def edit_plan(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Print segments + keyframes + total output duration for review."""
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    segs_path = out_dir / "segments.json"
    cam_path = out_dir / "camera.json"
    if not segs_path.exists():
        raise typer.BadParameter(f"missing {segs_path} — run `clipwright segments` first")
    segs = json.loads(segs_path.read_text())
    rprint(f"[bold]Video:[/bold] {segs['video']} ({segs['duration']:.2f}s)")
    rprint(f"[bold]{len(segs['segments'])} segments[/bold]")
    total = 0.0
    for i, s in enumerate(segs["segments"]):
        mtypes = ", ".join(m["type"] for m in s.get("moments") or []) or "—"
        total += float(s["duration"])
        rprint(
            f"  [{i:02d}] src [{s['source_start']:6.2f} → {s['source_end']:6.2f}] "
            f"dur {s['duration']:5.2f}s  actions: {mtypes}"
        )
    rprint(f"[bold]Total output duration:[/bold] {total:.2f}s")
    if cam_path.exists():
        cam = json.loads(cam_path.read_text())
        rprint(f"[bold]Camera keyframes:[/bold] {len(cam['keyframes'])} (fps={cam['fps']})")
    else:
        rprint("[yellow]No camera.json — run `clipwright keyframes`.[/yellow]")


@app.command("edit-plan", hidden=True)
def edit_plan_deprecated(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Deprecated alias for `clipwright review`."""
    rprint("[yellow]`edit-plan` is deprecated — use `clipwright review` instead.[/yellow]")
    edit_plan(project=project)


@app.command()
def tts(
    script_path: Path = typer.Argument(None, help="Voiceover script JSON (defaults to config.voice_script)."),
    project: Path = typer.Option(None, "--project"),
    provider: str = typer.Option(None, "--provider", help="Override tts_provider (kokoro | piper | elevenlabs)."),
    force: bool = typer.Option(False, "--force", help="Re-synthesize even when cache is valid."),
) -> None:
    """Synthesize voiceover per beat, emitting audio + char-level timestamps."""
    root = _root(project)
    cfg = _load_cfg(root)
    script = (script_path or root / cfg.voice_script).resolve()
    provider_name = provider or cfg.tts_provider
    tts_provider = get_provider(provider_name)
    out_dir = cfg.resolve_out(root)
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    data = json.loads(script.read_text())
    for clip in data["clips"]:
        cid = clip["id"]
        if not clip.get("text"):
            rprint(f"[yellow]Skip[/yellow] {cid}: empty text")
            continue
        voice = clip.get("voice") or clip.get("voice_id") or (cfg.voice_id or None)
        target = clip.get("target_seconds")
        mp3 = audio_dir / f"{cid}.mp3"
        ts = audio_dir / f"{cid}.timestamps.json"
        cache_file = audio_dir / f"{cid}.cache.json"

        clip_hash = _cache_hash(
            clip["text"],
            voice or "",
            provider_name,
            str(target or ""),
        )
        if not force and mp3.exists() and ts.exists() and _read_cache(cache_file) == clip_hash:
            rprint(f"[dim]TTS[/dim] ({provider_name}) {cid}: [dim]cached[/dim]")
            continue

        tts_provider.synthesize(clip["text"], out_mp3=mp3, out_timestamps=ts, voice=voice)

        if target:
            cur = probe_duration(mp3)
            # Only speed up if audio is longer than the segment — never slow
            # it down. Stretching a fast TTS to fit a long segment makes the
            # narration sound drawn-out and robotic; trailing silence is fine.
            if cur > float(target) * 1.03:
                stretched = audio_dir / f"{cid}.stretched.mp3"
                ratio = stretch_audio(mp3, stretched, float(target))
                stretched.replace(mp3)
                # Rescale timestamps to match the stretched audio.
                align = json.loads(ts.read_text())
                for key in ("character_start_times_seconds", "character_end_times_seconds"):
                    if key in align:
                        align[key] = [round(t / ratio, 4) for t in align[key]]
                ts.write_text(json.dumps(align))
                _write_cache(cache_file, clip_hash)
                rprint(
                    f"[green]TTS[/green] ({provider_name}) {cid}: "
                    f"{cur:.2f}s → {float(target):.2f}s (ratio {ratio:.3f})"
                )
                continue
        _write_cache(cache_file, clip_hash)
        rprint(f"[green]TTS[/green] ({provider_name}) {cid}")


@app.command()
def caption(
    project: Path = typer.Option(None, "--project"),
    style_path: Path = typer.Option(None, "--style", help="CaptionStyle JSON override."),
    force: bool = typer.Option(False, "--force", help="Re-render PNGs even when cache is valid."),
) -> None:
    """Chunk timestamps into 2-word UPPERCASE frames and render caption PNGs."""
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    audio_dir = out_dir / "audio"
    subs_dir = out_dir / "subs"
    subs_dir.mkdir(exist_ok=True)
    style = (
        CaptionStyle.from_json(style_path)
        if style_path
        else CaptionStyle(width=cfg.resolution[0], height=cfg.resolution[1])
    )
    style_key = style_path.read_text() if style_path else f"{cfg.resolution[0]}x{cfg.resolution[1]}"
    for ts_path in sorted(audio_dir.glob("*.timestamps.json")):
        cid = ts_path.name.removesuffix(".timestamps.json")
        ts_content = ts_path.read_text()
        cap_hash = _cache_hash(ts_content, style_key)
        cache_file = subs_dir / f"{cid}.cache.json"
        png_dir = subs_dir / cid
        if not force and png_dir.exists() and _read_cache(cache_file) == cap_hash:
            align = json.loads(ts_content)
            chunks = chunk_words(chars_to_words(align), n=2, upper=True)
            rprint(f"[dim]Caption[/dim] {cid}: [dim]cached ({len(chunks)} chunks)[/dim]")
            continue
        align = json.loads(ts_content)
        words = chars_to_words(align)
        chunks = chunk_words(words, n=2, upper=True)
        render_all(chunks, style, png_dir)
        _write_cache(cache_file, cap_hash)
        rprint(f"[green]Caption[/green] {cid}: {len(chunks)} chunks")


@app.command()
def inspire(
    url: str = typer.Argument(..., help="URL to extract brand assets from."),
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Extract brand assets (color, logo, hero, copy) from a URL into out/brand/.

    Writes:
      out/brand/copy.json        — {title, description, h1}
      out/brand/primary_color    — hex color string
      out/brand/hero.png         — OG image or full-page screenshot
      out/brand/logo.png         — largest favicon (if found)

    Re-running is safe — assets are regenerated deterministically from the URL.
    Run this before `clipwright render --backend remotion` to activate branded
    TitleCard and Outro scene components.
    """
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    brand_dir = out_dir / "brand"
    rprint(f"[cyan]Fetching[/cyan] {url} …")
    try:
        from .inspire.extractor import extract
        result = extract(url, brand_dir)
    except Exception as exc:
        raise ClipwrightError(
            f"inspire failed: {exc}",
            fix="Check the URL is reachable and Playwright is installed",
            docs="docs/troubleshooting.md#inspire-failures",
        ) from exc
    rprint(f"[green]Brand color[/green]  {result['primary_color']}")
    rprint(f"[green]Title[/green]        {result['copy'].get('title', '')[:60]}")
    rprint(f"[green]Assets[/green]       {brand_dir}")


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


generate_app = typer.Typer(no_args_is_help=True, help="Generative scene utilities (BYOK, opt-in).")
app.add_typer(generate_app, name="generate")


def _generate_slot(
    slot: str,
    *,
    project: Path | None,
    provider: str,
    prompt: str,
    duration: float,
    fallback: bool,
    force: bool,
) -> None:
    """Shared implementation for all `generate <slot>` sub-commands."""
    require()
    root = _root(project)
    cfg = _load_cfg(root)
    out_dir = cfg.resolve_out(root)
    gen_dir = out_dir / "generated"
    gen_dir.mkdir(parents=True, exist_ok=True)

    suffix = ".mp4" if slot in ("intro", "broll", "outro") else ".png"
    out_path = gen_dir / f"{slot}{suffix}"

    # Collect brand image refs for image-to-video conditioning.
    brand_dir = out_dir / "brand"
    image_refs: list[Path] = []
    for name in ("hero.png", "logo.png"):
        p = brand_dir / name
        if p.exists():
            image_refs.append(p)

    if not image_refs and not fallback:
        rprint("[yellow]Warning:[/yellow] No brand assets found. "
               "Run `clipwright inspire <url>` first for brand-consistent output.")

    from .generate.base import GenerateRequest, get_provider

    try:
        prov = get_provider(provider)
        prov.validate_env()
    except ClipwrightError as exc:
        if fallback:
            rprint(f"[yellow]Fallback:[/yellow] {exc} — using static scene")
            return
        _handle_error(exc)
        return

    request = GenerateRequest(
        slot=slot,
        prompt=prompt,
        image_refs=image_refs,
        duration=duration,
        width=cfg.resolution[0],
        height=cfg.resolution[1],
    )

    try:
        result = prov.generate(request, out_path)
        status_str = "[dim]cached[/dim]" if result.cached else "[green]generated[/green]"
        rprint(f"{status_str} {out_path}")
    except ClipwrightError as exc:
        if fallback:
            rprint(f"[yellow]Fallback:[/yellow] {exc} — using static scene")
            return
        _handle_error(exc)


@generate_app.command("intro")
def generate_intro(
    project: Path = typer.Option(None, "--project"),
    provider: str = typer.Option("veo", "--provider", help="veo | runway | dalle"),
    prompt: str = typer.Option(
        "Cinematic product reveal, atmospheric, minimal, dark background, 9:16 vertical",
        "--prompt",
        help="Generation prompt",
    ),
    duration: float = typer.Option(3.0, "--duration", help="Clip duration in seconds"),
    fallback: bool = typer.Option(False, "--fallback", help="Fall back to static on failure"),
    force: bool = typer.Option(False, "--force", help="Ignore cache and regenerate"),
) -> None:
    """Generate a cinematic intro scene (uses brand image refs if available).

    Requires `clipwright inspire <url>` to have been run first for on-brand output.
    Writes out/generated/intro.mp4.
    """
    _generate_slot("intro", project=project, provider=provider, prompt=prompt,
                   duration=duration, fallback=fallback, force=force)


@generate_app.command("broll")
def generate_broll(
    chapter: str = typer.Argument(..., help="Chapter name to generate b-roll for"),
    project: Path = typer.Option(None, "--project"),
    provider: str = typer.Option("veo", "--provider", help="veo | runway | dalle"),
    prompt: str = typer.Option("", "--prompt", help="Generation prompt (auto-derived from chapter if empty)"),
    duration: float = typer.Option(2.5, "--duration", help="Clip duration in seconds"),
    fallback: bool = typer.Option(False, "--fallback", help="Fall back to static on failure"),
    force: bool = typer.Option(False, "--force", help="Ignore cache and regenerate"),
) -> None:
    """Generate atmospheric b-roll for a chapter divider.

    Writes out/generated/broll_<chapter>.mp4.
    """
    effective_prompt = prompt or f"Smooth atmospheric transition for {chapter!r} chapter, abstract motion"
    _generate_slot(f"broll_{chapter}", project=project, provider=provider, prompt=effective_prompt,
                   duration=duration, fallback=fallback, force=force)


@generate_app.command("outro")
def generate_outro_gen(
    project: Path = typer.Option(None, "--project"),
    provider: str = typer.Option("veo", "--provider", help="veo | runway | dalle"),
    prompt: str = typer.Option(
        "Branded outro reveal, elegant, minimal, dark background, vertical 9:16",
        "--prompt",
        help="Generation prompt",
    ),
    duration: float = typer.Option(3.0, "--duration", help="Clip duration in seconds"),
    fallback: bool = typer.Option(False, "--fallback", help="Fall back to BrandedOutro on failure"),
    force: bool = typer.Option(False, "--force", help="Ignore cache and regenerate"),
) -> None:
    """Generate a cinematic outro (replaces BrandedOutro scene).

    Writes out/generated/outro.mp4.
    """
    _generate_slot("outro", project=project, provider=provider, prompt=prompt,
                   duration=duration, fallback=fallback, force=force)


@generate_app.command("hero")
def generate_hero(
    project: Path = typer.Option(None, "--project"),
    provider: str = typer.Option("dalle", "--provider", help="dalle (image only)"),
    prompt: str = typer.Option(
        "Minimalist product hero illustration, dark mode, clean, professional",
        "--prompt",
        help="Generation prompt",
    ),
    fallback: bool = typer.Option(False, "--fallback", help="Fall back to OG image on failure"),
    force: bool = typer.Option(False, "--force", help="Ignore cache and regenerate"),
) -> None:
    """Generate a static hero illustration for the TitleCard background.

    Writes out/generated/hero.png and symlinks it as out/brand/hero.png.
    Requires OPENAI_API_KEY.
    """
    _generate_slot("hero", project=project, provider=provider, prompt=prompt,
                   duration=0.0, fallback=fallback, force=force)


@app.command()
def assets(
    gradient: str = typer.Option("dark", "--gradient", help="dark | light | <path to .jpg>"),
) -> None:
    """Copy the chosen gradient to remotion/public/gradient.jpg."""
    dst = remotion_backend.copy_gradient(gradient)
    rprint(f"[green]Gradient[/green] {gradient} -> {dst}")


@app.command("render")
def render_cmd(
    project: Path = typer.Option(None, "--project"),
    backend: str = typer.Option("ffmpeg", "--backend", help="ffmpeg | remotion"),
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
    if backend == "remotion":
        _render_remotion(root, cfg, out_dir, no_outro=no_outro)
        return
    if backend != "ffmpeg":
        raise typer.BadParameter(f"unknown backend {backend!r} (ffmpeg | remotion)")
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


def _render_remotion(
    root: Path,
    cfg: config.ProjectConfig,
    out_dir: Path,
    *,
    no_outro: bool,
) -> None:
    segs_path = out_dir / "segments.json"
    cam_path = out_dir / "camera.json"
    if not segs_path.exists() or not cam_path.exists():
        raise typer.BadParameter(
            "remotion backend requires segments.json and camera.json "
            "(run `clipwright segments && clipwright keyframes`)"
        )
    segs_doc = json.loads(segs_path.read_text())
    source = Path(segs_doc["video"])
    outro_path = out_dir / "outro.mp4"
    outro_final = outro_path if (not no_outro and outro_path.exists()) else None
    outro_dur = probe_duration(outro_final) if outro_final else 0.0
    out_final = out_dir / "final.mp4"
    remotion_backend.render(
        out_dir=out_dir,
        source_video=source,
        fps=cfg.fps,
        width=cfg.resolution[0],
        height=cfg.resolution[1],
        outro=outro_final,
        outro_duration=outro_dur,
        out=out_final,
    )
    rprint(f"[green]Rendered (remotion)[/green] {out_final}")


def _handle_error(exc: ClipwrightError) -> None:
    rprint(exc.rich_message())
    raise typer.Exit(1)


@app.command()
def build(
    project: Path = typer.Option(None, "--project"),
    backend: str = typer.Option("remotion", "--backend", help="ffmpeg | remotion"),
    provider: str = typer.Option(None, "--provider", help="Override tts_provider."),
    force: bool = typer.Option(False, "--force", help="Force re-run TTS and captions."),
    no_outro: bool = typer.Option(False, "--no-outro"),
    no_captions: bool = typer.Option(False, "--no-captions"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip TTS confirmation prompt."),
) -> None:
    """Run the full pipeline in one command (segments → render), skipping up-to-date stages."""
    import sys

    root = _root(project)

    def on_event(ev: object) -> None:
        from .pipeline import (
            ConfirmRequested,
            StageCompleted,
            StageFailed,
            StageSkipped,
            StageStarted,
        )
        if isinstance(ev, StageStarted):
            rprint(f"[bold cyan]→[/bold cyan] {ev.stage}")
        elif isinstance(ev, StageCompleted):
            detail = f" [dim]{ev.detail}[/dim]" if ev.detail else ""
            rprint(f"[green]✓[/green] {ev.stage}{detail}")
        elif isinstance(ev, StageSkipped):
            rprint(f"[dim]–[/dim] [dim]{ev.stage}: {ev.reason}[/dim]")
        elif isinstance(ev, StageFailed):
            rprint(ev.error.rich_message())
        elif isinstance(ev, ConfirmRequested):
            rprint(ev.prompt)

    def confirm_tts() -> bool:
        if yes:
            return True
        return typer.confirm("Proceed with TTS synthesis?", default=True)

    pipeline = Pipeline.from_dir(root, on_event=on_event)
    try:
        out = pipeline.build(
            provider=provider,
            backend=backend,
            force_tts=force,
            force_captions=force,
            no_outro=no_outro,
            no_captions=no_captions,
            confirm_tts=confirm_tts,
        )
        rprint(f"\n[bold green]Done[/bold green] → {out}")
    except ClipwrightError as exc:
        _handle_error(exc)
    except Exception as exc:
        rprint(f"[red]Error:[/red] {exc}")
        sys.exit(1)


@app.command()
def status(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Show which pipeline artifacts exist for the current project."""
    root = _root(project)
    pipeline = Pipeline.from_dir(root)
    state = pipeline.status()
    rprint(f"[bold]Project:[/bold] {root}")
    for a in state.artifacts:
        if a.exists:
            rprint(f"  [green]✓[/green] {a.name:<12} {a.path}")
        else:
            rprint(f"  [dim]–[/dim] [dim]{a.name:<12} (missing)[/dim]")


@app.command()
def doctor(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Preflight check: verify tools, Python version, API keys, and project config."""
    import shutil
    import sys

    ok = True

    def check(label: str, passed: bool, fix: str = "") -> None:
        nonlocal ok
        if passed:
            rprint(f"  [green]✓[/green] {label}")
        else:
            ok = False
            rprint(f"  [red]✗[/red] {label}" + (f"\n    [yellow]Fix:[/yellow] {fix}" if fix else ""))

    rprint("[bold]Clipwright doctor[/bold]")
    rprint("")

    rprint("[bold]Runtime[/bold]")
    v = sys.version_info
    check(
        f"Python {v.major}.{v.minor}.{v.micro}",
        v >= (3, 10) and v < (3, 13),
        "Use Python 3.10–3.12. Python 3.13+ is not yet supported by ML TTS backends.",
    )
    check("ffmpeg on PATH", shutil.which("ffmpeg") is not None, "Install ffmpeg: brew install ffmpeg")
    check("ffprobe on PATH", shutil.which("ffprobe") is not None, "Install ffmpeg (includes ffprobe)")
    node_ok = shutil.which("node") is not None
    check("node on PATH (optional, for remotion backend)", node_ok, "Install Node ≥ 18 to use --backend remotion")

    rprint("")
    root = _root(project)
    rprint(f"[bold]Project ({root})[/bold]")
    cfg_path = root / config.CONFIG_NAME
    check(
        ".clipwright.json found",
        cfg_path.exists(),
        "clipwright init <dir>",
    )
    if cfg_path.exists():
        cfg = _load_cfg(root)
        check(
            f"tts_provider={cfg.tts_provider!r} configured",
            cfg.tts_provider in ("kokoro", "piper", "elevenlabs"),
            "Set tts_provider to kokoro, piper, or elevenlabs in .clipwright.json",
        )
        if cfg.tts_provider == "elevenlabs":
            import os
            env_path = root / ".env"
            key_in_env = False
            if env_path.exists():
                key_in_env = "ELEVENLABS_API_KEY" in env_path.read_text()
            key_in_os = bool(os.environ.get("ELEVENLABS_API_KEY"))
            check(
                "ELEVENLABS_API_KEY set",
                key_in_env or key_in_os,
                "Add ELEVENLABS_API_KEY=... to .env in the project root",
            )

    rprint("")
    if ok:
        rprint("[green]All checks passed.[/green]")
    else:
        rprint("[yellow]Some checks failed — fix the issues above and re-run `clipwright doctor`.[/yellow]")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
