"""Typer entrypoint. One subcommand per pipeline stage.

Every pipeline stage takes `--video <slug>` to pick one video inside a
multi-video project. When the project has exactly one video the flag is
optional; with zero or many it's required.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import typer
from rich import print as rprint

from . import __version__, config, migrate as migrate_mod
from .captions.chunker import chars_to_words, chunk_words
from .captions.png_renderer import CaptionStyle, render_all
from .edit import keyframes as keyframes_mod
from .edit import segments as segments_mod
from .edit.trim import trim as trim_impl
from .ffmpeg import probe_duration, require, stretch_audio
from .outro.brand import BrandConfig
from .outro.render import render_outro
from .plan import script_skeleton
from .record.playwright_recorder import record as record_impl
from .render import remotion_backend
from .render.composer import Segment, SubtitleChunk, render
from .tts import get_provider

app = typer.Typer(add_completion=False, no_args_is_help=True, help="Clipwright: short-form how-to video pipeline.")


def _root(path: Path | None) -> Path:
    return (path or Path.cwd()).resolve()


def _progress(enabled: bool, stage: str, *, clip: str | None = None, pct: float | None = None, message: str | None = None) -> None:
    if not enabled:
        return
    payload: dict = {"stage": stage}
    if clip is not None:
        payload["clip"] = clip
    if pct is not None:
        payload["pct"] = pct
    if message is not None:
        payload["message"] = message
    print(json.dumps(payload), flush=True)


def _resolve(project: Path | None, video: str | None) -> config.Resolved:
    """Common entry point: resolve project + video slug, auto-migrating legacy."""
    root = _root(project)
    if migrate_mod.ensure_migrated(root):
        rprint(f"[yellow]Migrated legacy project layout at {root} → videos/main/[/yellow]")
    try:
        return config.resolve(root, video)
    except (FileNotFoundError, ValueError) as exc:
        raise typer.BadParameter(str(exc)) from exc


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
    video: str = typer.Option("main", "--video", help="Slug for the first video in the project."),
) -> None:
    """Scaffold a new Clipwright project with one starter video."""
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    pcfg = config.ProjectConfig(
        name=directory.name,
        aspect=aspect,
        url=url,
    )
    config.write(directory, pcfg)
    _scaffold_video(directory, video, url=url, title=video)
    _install_remotion_skill(directory)
    rprint(f"[green]Initialized[/green] {directory} (video={video})")


def _scaffold_video(project_root: Path, slug: str, *, url: str, title: str) -> Path:
    """Create videos/<slug>/ with a starter browse-plan.json + demo.py + video.json."""
    if not config.SLUG_RE.match(slug):
        raise typer.BadParameter(
            f"slug {slug!r} must be lowercase alphanumeric + hyphens (1-63 chars)."
        )
    vroot = config.video_root(project_root, slug)
    if vroot.exists():
        raise typer.BadParameter(f"video {slug!r} already exists at {vroot}")
    vroot.mkdir(parents=True)
    (vroot / "out").mkdir()
    config.write_video(project_root, config.VideoConfig(slug=slug, title=title or slug))
    (vroot / "browse-plan.json").write_text(
        json.dumps(
            {
                "viewport": {"width": 540, "height": 960, "mobile": True},
                "base_url": url,
                "actions": [
                    {
                        "type": "navigate",
                        "label": "Open the landing page",
                        "fields": {"url": "/"},
                        "wait": 1.5,
                    },
                    {
                        "type": "scroll",
                        "label": "Browse what's on offer",
                        "fields": {"by_y": 600},
                        "wait": 1.2,
                    },
                ],
            },
            indent=2,
        )
        + "\n"
    )
    (vroot / "demo.py").write_text(
        '"""Legacy Playwright user script. Prefer browse-plan.json.\n\n'
        'Run: clipwright record   (reads demo.py)\n'
        'Or:  clipwright record --plan browse-plan.json\n"""\n\n\n'
        "async def run(page, mark):\n"
        '    await page.wait_for_load_state("networkidle")\n'
        "    await page.wait_for_timeout(800)\n"
        '    await mark("settle")\n'
    )
    return vroot


def _install_remotion_skill(project_dir: Path) -> None:
    """Install Remotion's agent skill into <project>/.claude/skills/remotion-best-practices.

    Idempotent; re-running on an up-to-date target is a no-op. Non-fatal.
    """
    script = Path(__file__).resolve().parents[2] / "scripts" / "install-remotion-skill.sh"
    if not script.is_file():
        return
    try:
        subprocess.run(
            [str(script), "--project", str(project_dir), "--quiet"],
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        rprint(f"[yellow]warn[/yellow] remotion skill install skipped: {exc}")


# ---------- migrate ----------

@app.command()
def migrate(
    project: Path = typer.Option(None, "--project"),
    slug: str = typer.Option("main", "--slug", help="Slug for the legacy video."),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    """Migrate a legacy single-video project to the multi-video layout."""
    root = _root(project)
    if not migrate_mod.is_legacy(root):
        rprint(f"[green]Nothing to do[/green] — {root} is already on the multi-video layout.")
        return
    moves = migrate_mod.run(root, slug=slug, dry_run=dry_run)
    verb = "Would move" if dry_run else "Moved"
    for src, dst in moves:
        rprint(f"  {verb}: {src.relative_to(root)} → {dst.relative_to(root)}")
    if not dry_run:
        rprint(f"[green]Migrated[/green] {root} → videos/{slug}/")


# ---------- video group ----------

video_app = typer.Typer(no_args_is_help=True, help="Manage videos inside a project.")
app.add_typer(video_app, name="video")


@video_app.command("list")
def video_list(project: Path = typer.Option(None, "--project")) -> None:
    """List videos in this project with their current phase."""
    root = _root(project)
    migrate_mod.ensure_migrated(root)
    videos = config.list_videos(root)
    if not videos:
        rprint("[yellow]No videos[/yellow] — run `clipwright video new <slug>`.")
        return
    for v in videos:
        out = config.resolve_video_out(root, v.slug)
        phase = _derive_phase(out)
        rprint(f"  [bold]{v.slug}[/bold]  {v.title or '':<28}  phase: {phase}")


@video_app.command("new")
def video_new(
    slug: str = typer.Argument(..., help="Slug (lowercase, hyphens)."),
    project: Path = typer.Option(None, "--project"),
    title: str = typer.Option("", "--title"),
    from_slug: str = typer.Option(None, "--from", help="Clone browse-plan.json from an existing video."),
) -> None:
    """Create a new video inside an existing project."""
    root = _root(project)
    migrate_mod.ensure_migrated(root)
    pcfg = config.load(root)
    vroot = _scaffold_video(root, slug, url=pcfg.url, title=title or slug)
    if from_slug:
        src_plan = config.video_root(root, from_slug) / "browse-plan.json"
        if src_plan.exists():
            shutil.copy(src_plan, vroot / "browse-plan.json")
            rprint(f"[green]Copied[/green] plan from {from_slug}")
    rprint(f"[green]Created video[/green] {vroot}")


@video_app.command("rm")
def video_rm(
    slug: str = typer.Argument(...),
    project: Path = typer.Option(None, "--project"),
    force: bool = typer.Option(False, "--force"),
) -> None:
    """Delete videos/<slug>/. Refuses if final.mp4 exists unless --force."""
    root = _root(project)
    vroot = config.video_root(root, slug)
    if not vroot.exists():
        raise typer.BadParameter(f"no such video: {slug}")
    if (vroot / "out" / "final.mp4").exists() and not force:
        raise typer.BadParameter(f"{slug}/out/final.mp4 exists — pass --force to delete anyway.")
    shutil.rmtree(vroot)
    rprint(f"[green]Deleted[/green] {vroot}")


@video_app.command("rename")
def video_rename(
    old: str = typer.Argument(...),
    new: str = typer.Argument(...),
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Rename a video slug (directory mv + video.json update)."""
    root = _root(project)
    if not config.SLUG_RE.match(new):
        raise typer.BadParameter(f"slug {new!r} must be lowercase alphanumeric + hyphens.")
    src = config.video_root(root, old)
    dst = config.video_root(root, new)
    if not src.exists():
        raise typer.BadParameter(f"no such video: {old}")
    if dst.exists():
        raise typer.BadParameter(f"target slug already exists: {new}")
    src.rename(dst)
    vcfg = config.load_video(root, new)
    vcfg.slug = new
    config.write_video(root, vcfg)
    rprint(f"[green]Renamed[/green] {old} → {new}")


def _derive_phase(out_dir: Path) -> str:
    if (out_dir / "final.mp4").exists():
        return "ready"
    if (out_dir.parent / "script.json").exists():
        try:
            d = json.loads((out_dir.parent / "script.json").read_text())
            if any(c.get("text") for c in d.get("clips", [])):
                return "audio → render"
        except Exception:  # noqa: BLE001
            pass
        return "script"
    if (out_dir / "segments.json").exists():
        return "segments"
    if (out_dir / "video.mp4").exists():
        return "plan"
    return "record"


# ---------- pipeline stages ----------

@app.command()
def record(
    script_path: Path = typer.Argument(None, help="Playwright script (defaults to <video>/demo.py)."),
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video", help="Video slug inside the project."),
    plan: Path = typer.Option(None, "--plan", help="browse-plan.json to execute (defaults to <video>/browse-plan.json)."),
) -> None:
    """Record the browser session -> video.mp4 + moments.json."""
    require()
    r = _resolve(project, video)
    cfg = r.project_cfg
    out_dir = r.out_dir
    if plan is None and r.browse_plan.exists():
        plan = r.browse_plan
    if plan is not None:
        plan_path = plan.resolve()
        vid, moments = record_impl(
            cfg.url, None, out_dir,
            size=cfg.resolution,
            mobile=cfg.mobile,
            user_agent=cfg.user_agent,
            plan_path=plan_path,
        )
    else:
        script = (script_path or r.video_root / cfg.demo_script).resolve()
        vid, moments = record_impl(
            cfg.url, script, out_dir,
            size=cfg.resolution,
            mobile=cfg.mobile,
            user_agent=cfg.user_agent,
        )
    rprint(f"[green]Recorded[/green] {vid} + {moments}")


@app.command()
def trim(
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video"),
) -> None:
    """Compute kept ranges from moments.json -> edl.json."""
    require()
    r = _resolve(project, video)
    cfg = r.project_cfg
    out_dir = r.out_dir
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
    video: str = typer.Option(None, "--video"),
) -> None:
    """Build segments.json from moments.json."""
    require()
    r = _resolve(project, video)
    cfg = r.project_cfg
    out_dir = r.out_dir
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
    video: str = typer.Option(None, "--video"),
) -> None:
    """Build camera.json (output-timeline keyframes) from segments.json."""
    r = _resolve(project, video)
    cfg = r.project_cfg
    out_dir = r.out_dir
    plan = keyframes_mod.run(
        out_dir / "segments.json",
        out_dir / "camera.json",
        fps=cfg.fps,
    )
    rprint(
        f"[green]Keyframes[/green] {len(plan.keyframes)} over "
        f"{plan.total_duration:.2f}s -> {out_dir / 'camera.json'}"
    )


script_app = typer.Typer(no_args_is_help=True, help="Voiceover script utilities.")
app.add_typer(script_app, name="script")


@script_app.command("init")
def script_init(
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video"),
    overwrite: bool = typer.Option(False, "--overwrite", help="Discard any existing text."),
) -> None:
    """Generate a script.json skeleton from segments.json."""
    r = _resolve(project, video)
    segments_path = r.out_dir / "segments.json"
    if not segments_path.exists():
        raise typer.BadParameter(f"missing {segments_path} — run `clipwright segments` first")
    skeleton = script_skeleton.run(segments_path, r.script, overwrite=overwrite)
    clips = skeleton.get("clips") or []
    missing = [c["id"] for c in clips if not c.get("text")]
    rprint(
        f"[green]Script skeleton[/green] {len(clips)} clips -> {r.script}"
        + (f"\n[yellow]Fill text for:[/yellow] {', '.join(missing)}" if missing else "")
    )


@app.command("edit-plan")
def edit_plan(
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video"),
) -> None:
    """Print segments + keyframes + total output duration for review."""
    r = _resolve(project, video)
    out_dir = r.out_dir
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


@app.command()
def tts(
    script_path: Path = typer.Argument(None, help="Voiceover script JSON (defaults to <video>/script.json)."),
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video"),
    provider: str = typer.Option(None, "--provider", help="Override tts_provider."),
    clip_id: str = typer.Option(None, "--clip-id", help="Only synthesize this clip id."),
    progress_json: bool = typer.Option(False, "--progress-json"),
) -> None:
    """Synthesize voiceover per beat, emitting audio + char-level timestamps."""
    r = _resolve(project, video)
    cfg = r.project_cfg
    script = (script_path or r.script).resolve()
    provider_name = provider or cfg.tts_provider
    tts_provider = get_provider(provider_name)
    audio_dir = r.out_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    data = json.loads(script.read_text())
    clips_to_process = [c for c in data["clips"] if clip_id is None or c["id"] == clip_id]
    if clip_id and not clips_to_process:
        raise typer.BadParameter(f"clip id {clip_id!r} not in script")
    total = len(clips_to_process)
    _progress(progress_json, "tts", pct=0.0)
    for idx, clip in enumerate(clips_to_process):
        cid = clip["id"]
        _progress(progress_json, "tts", clip=cid, pct=idx / max(total, 1))
        if not clip.get("text"):
            rprint(f"[yellow]Skip[/yellow] {cid}: empty text")
            continue
        voice = clip.get("voice") or clip.get("voice_id") or (cfg.voice_id or None)
        mp3 = audio_dir / f"{cid}.mp3"
        ts = audio_dir / f"{cid}.timestamps.json"
        tts_provider.synthesize(clip["text"], out_mp3=mp3, out_timestamps=ts, voice=voice)

        target = clip.get("target_seconds")
        if target:
            cur = probe_duration(mp3)
            if cur > float(target) * 1.03:
                stretched = audio_dir / f"{cid}.stretched.mp3"
                ratio = stretch_audio(mp3, stretched, float(target))
                stretched.replace(mp3)
                align = json.loads(ts.read_text())
                for key in ("character_start_times_seconds", "character_end_times_seconds"):
                    if key in align:
                        align[key] = [round(t / ratio, 4) for t in align[key]]
                ts.write_text(json.dumps(align))
                rprint(
                    f"[green]TTS[/green] ({provider_name}) {cid}: "
                    f"{cur:.2f}s → {float(target):.2f}s (ratio {ratio:.3f})"
                )
                continue
        rprint(f"[green]TTS[/green] ({provider_name}) {cid}")
    _progress(progress_json, "tts", pct=1.0, message="done")


@app.command()
def caption(
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video"),
    style_path: Path = typer.Option(None, "--style"),
    clip_id: str = typer.Option(None, "--clip-id"),
    progress_json: bool = typer.Option(False, "--progress-json"),
) -> None:
    """Chunk timestamps into 2-word UPPERCASE frames and render caption PNGs."""
    r = _resolve(project, video)
    cfg = r.project_cfg
    audio_dir = r.out_dir / "audio"
    subs_dir = r.out_dir / "subs"
    subs_dir.mkdir(exist_ok=True)
    style = (
        CaptionStyle.from_json(style_path)
        if style_path
        else CaptionStyle(width=cfg.resolution[0], height=cfg.resolution[1])
    )
    ts_paths = sorted(audio_dir.glob("*.timestamps.json"))
    if clip_id is not None:
        ts_paths = [p for p in ts_paths if p.name.removesuffix(".timestamps.json") == clip_id]
        if not ts_paths:
            raise typer.BadParameter(f"no timestamps for clip id {clip_id!r}")
    total = len(ts_paths)
    _progress(progress_json, "caption", pct=0.0)
    for idx, ts_path in enumerate(ts_paths):
        cid = ts_path.name.removesuffix(".timestamps.json")
        _progress(progress_json, "caption", clip=cid, pct=idx / max(total, 1))
        align = json.loads(ts_path.read_text())
        words = chars_to_words(align)
        chunks = chunk_words(words, n=2, upper=True)
        render_all(chunks, style, subs_dir / cid)
        rprint(f"[green]Caption[/green] {cid}: {len(chunks)} chunks")
    _progress(progress_json, "caption", pct=1.0, message="done")


@app.command()
def outro(
    project: Path = typer.Option(None, "--project"),
    video: str = typer.Option(None, "--video"),
    preset: str = typer.Option("cyberpunk", "--preset"),
    brand_path: Path = typer.Option(None, "--brand"),
) -> None:
    """Render the branded outro card."""
    require()
    r = _resolve(project, video)
    cfg = r.project_cfg
    if brand_path:
        brand = BrandConfig.from_json(brand_path)
    else:
        tmpl = Path(__file__).resolve().parent.parent.parent / "templates" / "outros" / f"{preset}.json"
        brand = BrandConfig.from_json(tmpl) if tmpl.exists() else BrandConfig()
    brand.width, brand.height = cfg.resolution
    brand.fps = cfg.fps
    out_path = r.out_dir / "outro.mp4"
    render_outro(brand, out_path)
    rprint(f"[green]Outro[/green] -> {out_path}")


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
    video: str = typer.Option(None, "--video"),
    backend: str = typer.Option("ffmpeg", "--backend", help="ffmpeg | remotion"),
    no_captions: bool = typer.Option(False, "--no-captions"),
    no_outro: bool = typer.Option(False, "--no-outro"),
    beat_map: Path = typer.Option(None, "--beat-map"),
    clip_id: str = typer.Option(None, "--clip-id"),
    progress_json: bool = typer.Option(False, "--progress-json"),
) -> None:
    """Compose vertical, mix audio, overlay captions LAST, concat outro."""
    del clip_id  # per-clip splice is a later optimization
    require()
    r = _resolve(project, video)
    cfg = r.project_cfg
    out_dir = r.out_dir
    _progress(progress_json, "render", pct=0.0)
    if backend == "remotion":
        _render_remotion(r, no_outro=no_outro)
        _progress(progress_json, "render", pct=1.0, message="done")
        return
    if backend != "ffmpeg":
        raise typer.BadParameter(f"unknown backend {backend!r} (ffmpeg | remotion)")
    edl = json.loads((out_dir / "edl.json").read_text())
    source = Path(edl["video"])

    audio_dir = out_dir / "audio"
    subs_dir = out_dir / "subs"

    per_clip_audio = sorted(audio_dir.glob("*.mp3"))
    ranges = edl["ranges"]

    beat_map_path = beat_map or (r.video_root / "beat_map.json")
    beat_to_range: dict[str, int] = {}
    if beat_map_path.exists():
        beat_to_range = json.loads(beat_map_path.read_text())
    elif len(per_clip_audio) != len(ranges) and per_clip_audio:
        raise typer.BadParameter(
            f"{len(per_clip_audio)} audio clips vs {len(ranges)} ranges — counts differ; "
            f"create beat_map.json mapping clip_id -> range index, or pass --beat-map."
        )

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
    _progress(progress_json, "render", pct=1.0, message="done")


def _render_remotion(r: config.Resolved, *, no_outro: bool) -> None:
    cfg = r.project_cfg
    out_dir = r.out_dir
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


if __name__ == "__main__":
    app()
