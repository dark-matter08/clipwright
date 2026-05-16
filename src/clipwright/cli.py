"""Typer entrypoint. One subcommand per pipeline stage."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import typer
from rich import print as rprint

from . import __version__, config
from .agent import PromptError, build_project_prompt, build_segment_prompt
from .caption_segment import CaptionSegmentError
from .caption_segment import caption_segment as caption_segment_impl
from .captions.chunker import chars_to_words, chunk_words
from .captions.png_renderer import CaptionStyle, render_all
from .edit import annotations as annotations_mod
from .edit import keyframes as keyframes_mod
from .edit import segments as segments_mod
from .edit.trim import trim as trim_impl
from .errors import ClipwrightError
from .ffmpeg import probe_duration, require, stretch_audio
from .import_video import import_video as import_video_impl
from .outro.brand import BrandConfig
from .outro.render import render_outro
from .pipeline import Pipeline
from .plan import script_skeleton
from .record.playwright_recorder import record as record_impl
from .record_project import RecordError
from .record_project import record_project as record_project_impl
from .render import remotion_backend
from .render.composer import Segment, SubtitleChunk, render
from .render_final import RenderFinalError
from .render_final import render_final as render_final_impl
from .render_segment import RenderSegmentError
from .render_segment import render_segment as render_segment_impl
from .tts import get_provider
from .tts_segment import TTSSegmentError
from .tts_segment import tts_segment as tts_segment_impl

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


@app.command(name="import")
def import_(
    video: Path = typer.Argument(..., help="Path to MP4/MOV/WebM to import."),
    into: Path = typer.Option(
        None, "--into",
        help="Project directory (created if missing; defaults to <video-stem> in CWD).",
    ),
    add: bool = typer.Option(
        False, "--add",
        help="Append the video as an additional source to an existing video. "
             "Without --add, the target directory must be empty.",
    ),
    video_id: str = typer.Option(
        "main", "--video",
        help="Which video inside the project to write to. Default 'main'. "
             "With --add, points segments at this video; without --add, names "
             "the first video the project creates.",
    ),
    video_title: str = typer.Option(
        "", "--video-title",
        help="Human title for the video. Ignored if the video already exists.",
    ),
    title: str = typer.Option("", help="Project title (defaults to project dir name). Ignored with --add."),
    aspect: str = typer.Option("9:16", help="9:16, 16:9, or 1:1. Ignored with --add."),
    auto_segment: bool = typer.Option(
        True, "--auto-segment/--no-auto-segment",
        help="Run silence + scene detection. With --no-auto-segment, one segment covers the whole source.",
    ),
    scene_detection: bool = typer.Option(
        True, "--scene-detection/--no-scene-detection",
        help="Include scene-change detection (slower on long files).",
    ),
    tts_provider: str = typer.Option(
        "kokoro", "--tts-provider",
        help="Project-default TTS provider (kokoro | openai | elevenlabs | piper). "
             "Per-video overrides live in videos/<id>.json#recap_overrides.",
    ),
    voice_id: str = typer.Option(
        "", "--voice-id",
        help="Project-default voice id (e.g. 'af_sky' for Kokoro, 'onyx' for OpenAI). "
             "Empty = let the provider pick its default.",
    ),
) -> None:
    """Import a video as a new project, or add another video to an existing one.

    Default: create a new project. Copies the video into
    <project>/sources/main.mp4, runs auto-segmentation, writes project.json +
    timeline.json. Refuses if the target dir is non-empty.

    With --add: append to an existing project. Picks a unique
    <project>/sources/<stem>.mp4 filename and appends new segments to
    timeline.json with stable IDs. The project.json is left unchanged.
    Use for B-roll, intercut footage, etc.
    """
    video = video.resolve()
    if not video.exists():
        raise ClipwrightError(
            f"video not found: {video}",
            fix="Check the path; supported formats: MP4, MOV, WebM.",
        )
    project_dir = (into or (Path.cwd() / video.stem)).resolve()

    if add:
        if not (project_dir / "project.json").exists():
            raise ClipwrightError(
                f"--add requires an existing project at {project_dir}",
                fix="Drop --add to create a new project, or point --into at one.",
            )
    else:
        if project_dir.exists() and any(project_dir.iterdir()):
            raise ClipwrightError(
                f"target directory is not empty: {project_dir}",
                fix="Pick a new path with --into, pass --add to append, or remove existing contents.",
            )

    verb = "Adding to" if add else "Importing"
    rprint(f"[dim]{verb} {project_dir} ← {video.name}[/dim]")
    result = import_video_impl(
        video,
        project_dir,
        title=title,
        aspect=aspect,
        auto_segment=auto_segment,
        use_scene_detection=scene_detection,
        append=add,
        video_id=video_id,
        video_title=video_title,
        tts_provider=tts_provider,
        voice_id=voice_id,
    )
    label = "Added" if add else "Imported"
    rprint(
        f"[green]{label}[/green] · {result.n_segments} segment"
        f"{'' if result.n_segments == 1 else 's'} total · {project_dir}"
    )
    rprint("[dim]Next: open in Clipwright Studio, or run `clipwright build`[/dim]")


@app.command(name="record-project")
def record_project_cmd(
    project_dir: Path = typer.Argument(..., help="Project directory (will be created if missing)."),
    plan: Path = typer.Option(
        None, "--plan",
        help="Path to browse-plan.json. Copies into the project if outside it. Defaults to <project>/browse-plan.json.",
    ),
    title: str = typer.Option("", help="Project title (defaults to project dir name)."),
    aspect: str = typer.Option("9:16", help="9:16, 16:9, or 1:1."),
    mobile: bool = typer.Option(False, "--mobile/--desktop", help="Emulate a mobile viewport."),
    video_id: str = typer.Option(
        "main", "--video", help="Which video inside the project (default 'main').",
    ),
    video_title: str = typer.Option(
        "", "--video-title", help="Human title for the video.",
    ),
    tts_provider: str = typer.Option(
        "kokoro", "--tts-provider",
        help="Project-default TTS provider (kokoro | openai | elevenlabs | piper).",
    ),
    voice_id: str = typer.Option(
        "", "--voice-id",
        help="Project-default voice id. Empty = provider default.",
    ),
) -> None:
    """Create or update a video by recording a Playwright session (Record mode).

    Runs `browse-plan.json` via Playwright, captures the video, and seeds
    a v2 project with one segment per chapter under `videos/<video>.json`.
    """
    try:
        result = record_project_impl(
            project_dir,
            plan_path=plan,
            title=title,
            aspect=aspect,
            mobile=mobile,
            video_id=video_id,
            video_title=video_title,
            tts_provider=tts_provider,
            voice_id=voice_id,
        )
    except RecordError as e:
        raise ClipwrightError(e.message, fix=e.fix) from e

    rprint(
        f"[green]Recorded[/green] · {result.n_segments} segment"
        f"{'' if result.n_segments == 1 else 's'} · {result.project_dir}"
    )
    rprint("[dim]Next: open in Clipwright Studio, or run `clipwright build`[/dim]")


_VIDEO_OPTION = typer.Option(
    "main", "--video", help="Which video in the project (default 'main').",
)


@app.command(name="render-segment")
def render_segment_cmd(
    seg_id: str = typer.Argument(..., help="Segment id, e.g. seg_001."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    video_id: str = _VIDEO_OPTION,
    force: bool = typer.Option(False, "--force", help="Bypass cache."),
) -> None:
    """Render one segment, writing out/segments/<video>/<seg_id>.mp4.

    Cached by content hash — unchanged inputs are a no-op.
    """
    root = (project_dir or Path.cwd()).resolve()
    try:
        result = render_segment_impl(root, seg_id, video_id=video_id, force=force)
    except RenderSegmentError as e:
        raise ClipwrightError(str(e), fix=e.fix) from e

    state = "[dim]cached[/dim]" if result.cached else "[green]rendered[/green]"
    rprint(f"{state} {result.out_path}")


@app.command(name="render-final")
def render_final_cmd(
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    video_id: str = _VIDEO_OPTION,
    force: bool = typer.Option(False, "--force", help="Bypass per-segment caches."),
) -> None:
    """Render every segment of one video and concat to out/final/<video>.mp4."""
    root = (project_dir or Path.cwd()).resolve()
    try:
        result = render_final_impl(root, video_id=video_id, force=force)
    except RenderFinalError as e:
        raise ClipwrightError(str(e), fix=e.fix) from e
    rprint(
        f"[green]Final[/green] {result.out_path} · "
        f"{result.rendered} rendered, {result.cached} cached"
    )


@app.command(name="caption-segment")
def caption_segment_cmd(
    seg_id: str = typer.Argument(..., help="Segment id, e.g. seg_001."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    video_id: str = _VIDEO_OPTION,
    force: bool = typer.Option(False, "--force", help="Bypass cache."),
) -> None:
    """Generate caption PNGs + index.json for one segment.

    Reads voiceover/audio/<video>/<seg_id>.timestamps.json and writes
    captions/<video>/<seg_id>/. Cached by content hash.
    """
    root = (project_dir or Path.cwd()).resolve()
    try:
        result = caption_segment_impl(root, seg_id, video_id=video_id, force=force)
    except CaptionSegmentError as e:
        raise ClipwrightError(str(e), fix=e.fix) from e

    state = "[dim]cached[/dim]" if result.cached else "[green]captioned[/green]"
    rprint(f"{state} {result.n_chunks} chunks · {result.out_dir}")


@app.command(name="tts-segment")
def tts_segment_cmd(
    seg_id: str = typer.Argument(..., help="Segment id, e.g. seg_001."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    video_id: str = _VIDEO_OPTION,
    force: bool = typer.Option(False, "--force", help="Bypass cache."),
) -> None:
    """Synthesize voiceover for one segment.

    Reads voiceover/scripts/<video>.json, picks the configured provider/voice,
    writes voiceover/audio/<video>/<seg_id>.mp3 + .timestamps.json. Cached
    by content hash. Stretches to target_seconds when audio is too long.
    """
    root = (project_dir or Path.cwd()).resolve()
    try:
        result = tts_segment_impl(root, seg_id, video_id=video_id, force=force)
    except TTSSegmentError as e:
        raise ClipwrightError(str(e), fix=e.fix) from e

    state = "[dim]cached[/dim]" if result.cached else "[green]synthesized[/green]"
    detail = f"{result.provider}"
    if result.voice:
        detail += f" · {result.voice}"
    if result.stretched and not result.cached:
        detail += f" · {result.natural_seconds:.1f}s → {result.target_seconds:.1f}s"
    rprint(f"{state} {detail} · {result.mp3_path}")


# Sub-app: `clipwright agent <subcommand>`
agent_app = typer.Typer(
    no_args_is_help=True,
    help="Claude Code agent helpers (prompt building, future Mode A/B spawners).",
)
app.add_typer(agent_app, name="agent")


@agent_app.command("prompt")
def agent_prompt_cmd(
    seg_id: str = typer.Argument(
        None,
        help="Optional segment id (e.g. seg_001). Omit for a video-scoped prompt.",
    ),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    video_id: str = _VIDEO_OPTION,
) -> None:
    """Print the system prompt Claude Code would receive (SRS §9.2).

    With no seg_id, builds the Mode A persistent-chat prompt scoped to
    the named video. With a seg_id, builds the Mode B segment-scoped prompt.
    """
    root = (project_dir or Path.cwd()).resolve()
    try:
        if seg_id:
            text = build_segment_prompt(root, seg_id, video_id=video_id)
        else:
            text = build_project_prompt(root, video_id=video_id)
    except PromptError as e:
        raise ClipwrightError(str(e), fix=e.fix) from e
    # Plain stdout so the output can be piped into `claude --append-system-prompt`.
    print(text, end="")


# Sub-app: `clipwright video <subcommand>` — manage videos in a project.
video_app = typer.Typer(
    no_args_is_help=True,
    help="Manage the videos inside a v2 project (list / create).",
)
app.add_typer(video_app, name="video")


@video_app.command("list")
def video_list_cmd(
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
) -> None:
    """List every video in the project."""
    from .schema import list_videos, load_video
    root = (project_dir or Path.cwd()).resolve()
    ids = list_videos(root)
    if not ids:
        rprint("[dim](no videos in this project — run `clipwright import`)[/dim]")
        return
    for vid in ids:
        v = load_video(root, vid)
        n = len(v.segments)
        rprint(f"  [cyan]{vid}[/cyan] · \"{v.title}\" · {n} segment{'' if n == 1 else 's'}")


@video_app.command("doctor")
def video_doctor_cmd(
    video_id: str = typer.Argument(..., help="Video id to audit."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    as_json: bool = typer.Option(False, "--json", help="Emit JSON for desktop consumption."),
) -> None:
    """Audit a video's pipeline completeness.

    Reports, per segment, whether voiceover audio / captions /
    per-segment render exist, AND whether the source video is long
    enough to honor the declared source ranges. Catches "recording too
    short for the script" in 1 second instead of letting Claude churn
    on a 10-minute timeout.

    `--json` emits a structured payload the desktop can render.
    """
    import json as _json

    from .video_doctor import diagnose_video

    root = (project_dir or Path.cwd()).resolve()
    try:
        report = diagnose_video(root, video_id)
    except ValueError as e:
        raise ClipwrightError(str(e), fix="Run `clipwright video list`.") from e

    if as_json:
        typer.echo(_json.dumps(report.to_dict()))
        return

    color = "green" if report.ok else "red"
    rprint(f"[{color}]video {video_id}[/{color}] · source={report.source_path}")
    if report.source_duration is not None:
        rprint(f"  source duration: {report.source_duration:.2f}s")
    else:
        rprint("  source duration: [yellow](could not probe — ffprobe missing or source unreadable)[/yellow]")
    for issue in report.issues:
        rprint(f"  [red]✗ {issue}[/red]")
    for s in report.segments:
        mark = "[green]✓[/green]" if s.ok else "[red]✗[/red]"
        rprint(
            f"  {mark} {s.seg_id}  src=[{s.source_range[0]:.2f}, {s.source_range[1]:.2f}]  "
            f"tgt={s.target_duration:.2f}s  "
            f"vo={'✓' if s.has_voiceover_mp3 else '✗'} "
            f"cap={s.captions_frame_count if s.has_captions else '✗'} "
            f"render={'✓' if s.has_segment_render else '✗'}"
        )
        for issue in s.issues:
            rprint(f"      [red]✗ {issue}[/red]")
    if not report.has_final_render:
        rprint("  [yellow]✗ no final render at out/final/<id>.mp4 — run `clipwright render-final`[/yellow]")
    elif report.final_is_stale:
        rprint(
            "  [yellow]⚠ final render is older than the newest per-segment render "
            "— re-run `clipwright render-final`[/yellow]"
        )
    else:
        rprint("  [green]✓ final render present[/green]")


@video_app.command("adopt")
def video_adopt_cmd(
    video_id: str = typer.Argument(..., help="Video id to adopt artifacts into."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
) -> None:
    """Pull flat v1-style artifacts into a video's v2 per-video layout.

    Use this when an earlier `clipwright record/render-final` run wrote
    files to the legacy root layout (`script.json`, `out/final.mp4`,
    `out/segments/*.mp4`) but the project is now v2 and the video's
    manifest is empty. We:

      1. Relocate the flat artifacts into `voiceover/scripts/<id>.json`,
         `out/final/<id>.mp4`, `out/segments/<id>/`, etc.
      2. Rebuild the video manifest's `segments[]` from `script.json` +
         `edl.json` so the timeline has navigable rows.

    Idempotent — a second run after success is a no-op.
    """
    from .schema import adopt_v1_artifacts, list_videos
    root = (project_dir or Path.cwd()).resolve()
    if video_id not in list_videos(root):
        raise ClipwrightError(
            f"no video {video_id!r} in this project",
            fix="Run `clipwright video list` for the available ids.",
        )
    report = adopt_v1_artifacts(root, video_id)
    rprint(
        f"[green]Adopted[/green] {len(report.moved)} path(s) into {video_id} · "
        f"[cyan]{report.segments_added}[/cyan] segments rebuilt"
    )
    for old, new in report.moved:
        rprint(f"  [dim]{old.name} → {new.relative_to(root)}[/dim]")
    for w in report.warnings:
        rprint(f"  [yellow]warn:[/yellow] {w}")


@video_app.command("delete")
def video_delete_cmd(
    video_id: str = typer.Argument(..., help="Video id to delete (e.g. chapter-1-recap)."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    yes: bool = typer.Option(
        False, "--yes", "-y", help="Skip confirmation. The desktop always passes this.",
    ),
) -> None:
    """Delete a video and every per-video artifact it owns.

    Wipes the manifest, voiceover audio/scripts, captions, rendered
    segments, final mp4, and Claude chat state for `<video_id>`.
    Shared project files (sources/, project.json, other videos) are
    untouched. The project's last video can't be deleted — create a
    replacement first or close the project.
    """
    from .schema import SchemaError, delete_video, list_videos
    root = (project_dir or Path.cwd()).resolve()
    ids = list_videos(root)
    if video_id not in ids:
        raise ClipwrightError(
            f"no video {video_id!r} in this project",
            fix="Run `clipwright video list` for the available ids.",
        )
    if not yes:
        # Show the artifact count we're about to nuke so the user can
        # cancel before anything is touched.
        rprint(
            f"[yellow]Will delete video[/yellow] [cyan]{video_id}[/cyan] "
            f"and every per-video artifact (TTS, captions, renders, chat log)."
        )
        rprint("[dim]Pass --yes to confirm.[/dim]")
        return
    try:
        removed = delete_video(root, video_id)
    except SchemaError as e:
        raise ClipwrightError(str(e), fix="Create another video first, then re-run.") from e
    rprint(f"[green]Deleted[/green] {video_id} · removed {len(removed)} path(s)")


@video_app.command("new")
def video_new_cmd(
    video_id: str = typer.Argument(..., help="New video id (e.g. chapter-1-recap)."),
    title: str = typer.Option("", "--title", help="Human title (defaults to video id)."),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
) -> None:
    """Create an empty video inside the project, ready for `clipwright import --video <id> --add`."""
    from .schema import SchemaError, create_video
    root = (project_dir or Path.cwd()).resolve()
    try:
        video = create_video(root, video_id, title)
    except SchemaError as e:
        raise ClipwrightError(str(e), fix="Pick a different id or use `clipwright video list` to see existing.") from e
    rprint(
        f"[green]Created video[/green] {video.video_id} · \"{video.title}\" · "
        f"add segments with `clipwright import <video.mp4> --video {video.video_id} --add`"
    )


# Sub-app: `clipwright templates <subcommand>` — list and bind project templates.
templates_app = typer.Typer(
    no_args_is_help=True,
    help="Project templates: list shipped templates, bind one to a project.",
)
app.add_typer(templates_app, name="templates")


@templates_app.command("list")
def templates_list_cmd(
    as_json: bool = typer.Option(False, "--json", help="Emit JSON for desktop consumption."),
) -> None:
    """List every shipped template.

    Default output is human-readable; `--json` returns the catalog as an
    array of {template_id, name, category, summary, render_preset}
    objects suitable for the desktop's template picker.
    """
    import json as _json

    from .templates import list_templates as _list

    metas = _list()
    if as_json:
        typer.echo(_json.dumps([m.to_dict() for m in metas]))
        return
    if not metas:
        rprint("[dim](no templates installed)[/dim]")
        return
    for m in metas:
        rprint(
            f"  [cyan]{m.template_id}[/cyan] · {m.name} "
            f"[dim]({m.category})[/dim]\n    [dim]{m.summary}[/dim]"
        )


@templates_app.command("show")
def templates_show_cmd(
    template_id: str = typer.Argument(..., help="Template id (e.g. manhwa-recap-single)."),
    as_json: bool = typer.Option(False, "--json", help="Emit the full template JSON."),
) -> None:
    """Print one template's full payload, including the system prompt."""
    import json as _json

    from .templates import TemplateError, get_template

    try:
        t = get_template(template_id)
    except TemplateError as e:
        raise ClipwrightError(str(e), fix="Run `clipwright templates list` for the available ids.") from e
    if as_json:
        typer.echo(_json.dumps(t.to_dict()))
        return
    rprint(f"[cyan]{t.template_id}[/cyan] · {t.name}")
    rprint(f"[dim]{t.summary}[/dim]")
    rprint("")
    rprint(t.system_prompt)


@templates_app.command("path")
def templates_path_cmd(
    template_id: str = typer.Argument(None, help="Optional: show one template's file path."),
) -> None:
    """Print the on-disk path of the user templates directory, or one template.

    No arg → prints `~/.clipwright/templates/data/` (the directory you'd
    drop new JSON files into). With a template id, prints that
    template's source file so you can edit it directly:

      $ "$EDITOR" "$(clipwright templates path manhwa-recap-single)"
    """
    from .templates import user_templates_dir
    from .templates.registry import _iter_all_templates  # noqa: SLF001

    if not template_id:
        typer.echo(str(user_templates_dir()))
        return
    for t in _iter_all_templates():
        if t.template_id == template_id and t.source_path is not None:
            typer.echo(str(t.source_path))
            return
    raise ClipwrightError(
        f"no template with id {template_id!r}",
        fix="Run `clipwright templates list` for the available ids.",
    )


@templates_app.command("new")
def templates_new_cmd(
    template_id: str = typer.Argument(..., help="New template id, e.g. tutorial-onepager."),
    from_id: str = typer.Option(
        "",
        "--from",
        help="Seed the new template from an existing one (copies all fields). "
             "Defaults to a minimal blank skeleton.",
    ),
    name: str = typer.Option("", "--name", help="Human-readable name (defaults to id)."),
    category: str = typer.Option(
        "",
        "--category",
        help="Catalog category (recap / demo / tutorial / …). Defaults to "
             "the --from template's category, or 'custom' for a blank seed.",
    ),
    force: bool = typer.Option(False, "--force", help="Overwrite an existing user template with the same id."),
) -> None:
    """Scaffold a new user template at `~/.clipwright/templates/data/<id>.json`.

    Two paths:

    - **Blank seed.** No `--from` → writes a skeleton with TODO markers
      for `name`, `summary`, and `system_prompt`. Edit it before
      shipping.

    - **Copy from existing.** `--from manhwa-recap-single` → clones the
      shipped template's fields verbatim into your user dir under the
      new id. Edit to taste; the user copy wins on lookup.

    The created file's path is printed at the end so you can pipe it
    to your editor.
    """
    import json as _json

    from .templates import TemplateError, get_template, user_templates_dir

    udir = user_templates_dir()
    udir.mkdir(parents=True, exist_ok=True)
    target = udir / f"{template_id}.json"
    if target.exists() and not force:
        raise ClipwrightError(
            f"{target} already exists",
            fix="Pass --force to overwrite, pick a different id, or edit the existing file.",
        )

    if from_id:
        try:
            base = get_template(from_id)
        except TemplateError as e:
            raise ClipwrightError(str(e), fix="Run `clipwright templates list`.") from e
        payload = base.to_dict()
        payload["template_id"] = template_id
        if name:
            payload["name"] = name
        if category:
            payload["category"] = category
        payload.pop("source", None)
    else:
        payload = {
            "template_id": template_id,
            "name": name or template_id,
            "category": category or "custom",
            "summary": "TODO: one-line summary shown in the template picker.",
            "render_preset": "",
            "defaults": {
                "aspect": "9:16",
                "fps": 30,
                "tts_provider": "kokoro",
                "voice_id": "",
            },
            "system_prompt": (
                f"# Template: {name or template_id}\n\n"
                "TODO: write the behavioral system prompt for this template. "
                "Describe the genre, the structure, the pacing rules, visual "
                "identity, editorial constraints, and which questions Claude "
                "should ask when the user says \"build it\". See the shipped "
                "templates (`clipwright templates show manhwa-recap-single`) "
                "for a working example.\n"
            ),
        }

    target.write_text(_json.dumps(payload, indent=2) + "\n")
    rprint(f"[green]Created[/green] {target}")
    rprint(f"[dim]Edit it: $EDITOR {target}[/dim]")


@templates_app.command("apply")
def templates_apply_cmd(
    template_ids: list[str] = typer.Argument(
        ..., help="One or more template ids (first = primary). Pass '-' to clear all.",
    ),
    project_dir: Path = typer.Option(
        None, "--project", help="Project root (defaults to CWD).",
    ),
    overwrite_defaults: bool = typer.Option(
        False,
        "--overwrite-defaults",
        help="Also replace existing aspect/fps/tts_provider/voice_id with the primary template's defaults. "
             "Default: fill only blank/missing fields so user-set values survive.",
    ),
) -> None:
    """Bind one or more templates to an existing project.

    Pass `-` (a single dash) to clear all bindings. With multiple
    ids the FIRST is the primary — it drives the renderer's preset
    and supplies default project settings (aspect, fps, etc.).
    Additional templates contribute behavioral guidance only: their
    system prompts are concatenated into the agent prompt.

    Typical multi-template use: a manhwa-reader platform producing
    chapter recaps wants both `manhwa-recap-single` (primary,
    drives the panel-based render) AND `product-demo` (secondary,
    so Claude also frames the deliverable as product marketing):

        $ clipwright templates apply manhwa-recap-single product-demo

    The agent's next turn picks up the change with no restart.
    """
    import json as _json

    from .templates import TemplateError, get_template

    root = (project_dir or Path.cwd()).resolve()
    project_path = root / "project.json"
    if not project_path.exists():
        raise ClipwrightError(
            f"no project.json at {project_path}",
            fix="Run `clipwright init` first or pass --project pointing at a project root.",
        )
    payload = _json.loads(project_path.read_text())
    if template_ids == ["-"]:
        payload.pop("template_id", None)
        payload.pop("template_ids", None)
        project_path.write_text(_json.dumps(payload, indent=2) + "\n")
        rprint("[green]Cleared template bindings.[/green]")
        return

    # Resolve + validate every id before mutating disk so we don't
    # leave the project in a partial state on a typo.
    resolved = []
    for tid in template_ids:
        try:
            resolved.append(get_template(tid))
        except TemplateError as e:
            raise ClipwrightError(
                str(e),
                fix="Run `clipwright templates list` for the available ids.",
            ) from e

    primary = resolved[0]
    payload["template_ids"] = [t.template_id for t in resolved]
    # Mirror the primary into the legacy single field so older
    # readers still see a meaningful binding.
    payload["template_id"] = primary.template_id

    # Propagate template defaults from the PRIMARY only. Secondaries
    # contribute editorial guidance, not settings.
    DEFAULT_KEYS = ("aspect", "fps", "tts_provider", "voice_id")
    propagated: list[str] = []
    for key in DEFAULT_KEYS:
        if key not in primary.defaults:
            continue
        new_val = primary.defaults[key]
        existing = payload.get(key)
        if overwrite_defaults or _is_blank(existing):
            if existing != new_val:
                payload[key] = new_val
                propagated.append(f"{key}={new_val!r}")
    project_path.write_text(_json.dumps(payload, indent=2) + "\n")

    if len(resolved) == 1:
        msg = f"[green]Bound template[/green] {primary.template_id} · {primary.name}"
    else:
        secondaries = ", ".join(t.template_id for t in resolved[1:])
        msg = (
            f"[green]Bound {len(resolved)} templates[/green] · primary "
            f"[cyan]{primary.template_id}[/cyan] + [dim]{secondaries}[/dim]"
        )
    if propagated:
        msg += f" [dim](applied defaults: {', '.join(propagated)})[/dim]"
    rprint(msg)


def _is_blank(value: object) -> bool:
    """Treat empty string, 0, and missing as 'safe to overwrite'.

    `fps` is an int defaulting to 30 — but a fresh project may have come
    out of an early init flow with fps unset, so honor that path too.
    Strings are blank only when empty; we never overwrite a user-set
    string with a template value unless --overwrite-defaults is on.
    """
    if value is None:
        return True
    if isinstance(value, str) and value == "":
        return True
    return False


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
