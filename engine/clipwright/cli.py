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
from .errors import ClipwrightError
from .import_video import import_video as import_video_impl
from .record_project import RecordError
from .record_project import record_project as record_project_impl
from .render_final import RenderFinalError
from .render_final import render_final as render_final_impl
from .render_segment import RenderSegmentError
from .render_segment import render_segment as render_segment_impl
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
    from .schema import Project, create_video, save_project

    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)

    # Write the v2 manifest FIRST — it's what makes the directory a
    # project. `init` used to emit only `.clipwright.json` +
    # `browse-plan.json`, which the v1 pipeline understood and nothing
    # else did: `status`, `video doctor`, the agent prompt and the
    # desktop app all key off `project.json`, so an init-ed directory
    # couldn't be opened by any of them.
    save_project(
        directory,
        Project(title=directory.name, aspect=aspect, base_url=url),
    )
    # One empty video so the project is immediately openable rather than
    # being a manifest with nowhere to put segments.
    create_video(directory, "main", title=directory.name)

    # The v1 sidecar stays for now: `doctor` still reads it for the
    # tts_provider check, and `record-project` resolves paths through it.
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
                "wait": 1.5,
            },
            {
                "type": "scroll",
                "label": "Browse what's on offer",
                "chapter": "intro",
                "fields": {"by_y": 600},
                "wait": 1.2,
            },
        ],
    }
    (directory / "browse-plan.json").write_text(json.dumps(browse_plan, indent=2) + "\n")
    rprint(f"[green]Initialized[/green] {directory} [dim](project.json + videos/main.json)[/dim]")
    rprint("[dim]Next: open it in Clipwright Studio, or edit browse-plan.json[/dim]")
    rprint("[dim]      and run `clipwright record-project .`[/dim]")


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
    rprint("[dim]Next: open in Clipwright Studio, or run `clipwright render-final`[/dim]")


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
    rprint("[dim]Next: open in Clipwright Studio, or run `clipwright render-final`[/dim]")


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
























from .persona.cli import persona_app  # noqa: E402

app.add_typer(persona_app, name="persona")


@app.command("tts-sample")
def tts_sample_cmd(
    provider: str = typer.Option(..., "--provider", help="kokoro | piper | openai | elevenlabs."),
    voice: str = typer.Option("", "--voice", help="Provider-specific voice id."),
    text: str = typer.Option("", "--text", help="Override the sample line."),
    force: bool = typer.Option(False, "--force", help="Re-synthesize even if cached."),
) -> None:
    """Synthesize a short sample of one voice and print the mp3 path.

    Used by the desktop's voice picker to audition a voice before it's
    committed to a project. Cached per (provider, voice, text), so
    re-auditioning doesn't re-bill a paid API.
    """
    from .tts_sample import DEFAULT_SAMPLE_TEXT, synthesize_sample

    path = synthesize_sample(
        provider,
        voice,
        text=text or DEFAULT_SAMPLE_TEXT,
        force=force,
    )
    # Bare path on stdout so the desktop can read it without parsing.
    print(path)


@app.command()
def status(
    project: Path = typer.Option(None, "--project"),
) -> None:
    """Show per-video artifact state for the current project.

    A v2 project is a collection of videos, so "status" is per video:
    for each one, how many segments have voiceover, captions, and a
    cached render, and whether the final concat exists. Reuses the
    same diagnosis `clipwright video doctor` runs, minus the issue
    reporting — this answers "what's built?", doctor answers "what's
    wrong?".
    """
    from .schema import list_videos, load_project
    from .video_doctor import diagnose_video

    root = _root(project)
    try:
        proj = load_project(root)
    except Exception as e:  # noqa: BLE001 - surfaced as a CLI error below
        raise ClipwrightError(
            f"not a clipwright project: {root}",
            # NOT `init` — that scaffolds a browse-plan, and only
            # `import` / `record-project` write the project.json that
            # makes a directory a v2 project.
            fix="Run `clipwright import <video.mp4>` or `record-project`, or pass --project.",
        ) from e

    rprint(f"[bold]Project:[/bold] {proj.title or root.name} [dim]{root}[/dim]")
    video_ids = list_videos(root)
    if not video_ids:
        rprint("  [dim]no videos yet — `clipwright video new <id>`[/dim]")
        return

    for vid in video_ids:
        report = diagnose_video(root, vid)
        n = len(report.segments)
        vo = sum(1 for s in report.segments if s.has_voiceover_mp3)
        caps = sum(1 for s in report.segments if s.has_captions)
        rendered = sum(1 for s in report.segments if s.has_segment_render)
        if report.has_final_render:
            final = (
                "[yellow]final (stale)[/yellow]"
                if report.final_is_stale
                else "[green]final[/green]"
            )
        else:
            final = "[dim]no final[/dim]"
        rprint(
            f"  [bold]{vid}[/bold]  {n} segments · "
            f"vo {vo}/{n} · captions {caps}/{n} · rendered {rendered}/{n} · {final}"
        )


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
    rprint("[bold]Skill ↔ CLI sync[/bold]")
    # Parse the repo's SKILL.md for `clipwright <subcommand>` references and
    # verify each one resolves to a registered Typer command. Catches drift
    # like the `edit-plan` → `review` rename that left SKILL.md stale on main.
    skill_path = Path(__file__).resolve().parent.parent.parent / "SKILL.md"
    if not skill_path.exists():
        rprint(f"  [dim]–[/dim] SKILL.md not found at {skill_path} (skipping)")
    else:
        missing = _skill_md_unknown_commands(skill_path)
        if not missing:
            check("SKILL.md commands all resolve to a CLI subcommand", True)
        else:
            ok = False
            unique = sorted(set(missing))
            rprint(
                f"  [red]✗[/red] SKILL.md references commands the CLI doesn't expose: "
                f"{', '.join(repr(c) for c in unique)}"
            )
            rprint(
                "    [yellow]Fix:[/yellow] update SKILL.md, or add the missing "
                "subcommand. The skill is what agents read — drift here breaks them silently."
            )

    rprint("")
    if ok:
        rprint("[green]All checks passed.[/green]")
    else:
        rprint("[yellow]Some checks failed — fix the issues above and re-run `clipwright doctor`.[/yellow]")
        raise typer.Exit(1)


# Subcommands that don't appear in `app.registered_commands` because they're
# attached via sub-typer (script_app, generate_app). Listed here so the doctor
# check accepts them as valid.
_KNOWN_SUBCOMMAND_GROUPS = {
    # `generate` and `script init` were removed with the v1 pipeline;
    # `video`/`templates`/`agent` predate this map and resolve as flat
    # commands. Listed here are the groups whose *leaves* get referenced
    # by name in SKILL.md or the agent prompt.
    "persona": {"list", "show", "new", "clone", "delete", "memory"},
}


def _registered_cli_commands() -> set[str]:
    """Return every Typer command name the CLI exposes.

    Includes the flat commands on `app` and the sub-typer commands
    (e.g. `script init`, `generate hero`). Names use single-space form
    so they match the strings SKILL.md uses ("clipwright script init").
    """
    names: set[str] = set()
    for cmd in app.registered_commands:
        if cmd.name:
            names.add(cmd.name)
        elif cmd.callback is not None:
            names.add(cmd.callback.__name__.replace("_", "-"))
    for group, leaves in _KNOWN_SUBCOMMAND_GROUPS.items():
        for leaf in leaves:
            names.add(f"{group} {leaf}")
    return names


def _skill_md_unknown_commands(skill_path: Path) -> list[str]:
    """Extract `clipwright <cmd>` mentions from SKILL.md and return any
    that aren't registered Typer commands.

    Tolerates:
      - flag noise after the subcommand ("clipwright tts --provider …")
      - sub-typer commands ("clipwright script init")
      - quoting / punctuation around the name in prose
    """
    import re

    text = skill_path.read_text()
    known = _registered_cli_commands()
    # Match `clipwright <word>` and optionally one trailing space-separated word
    # so we catch sub-typer leaves like `script init`. Stop at flags / pipes.
    # Use `[ \t]+` not `\s+` so newlines aren't crossed — otherwise the
    # frontmatter pattern `name: clipwright\ndescription: …` would match
    # `clipwright description` and flag a fake "command."
    pattern = re.compile(r"clipwright[ \t]+([a-zA-Z][\w-]*)(?:[ \t]+([a-zA-Z][\w-]*))?")
    missing: list[str] = []
    for match in pattern.finditer(text):
        head = match.group(1)
        tail = match.group(2)
        # Two-word form: only valid if it's a known sub-typer group + leaf.
        if tail and head in _KNOWN_SUBCOMMAND_GROUPS:
            full = f"{head} {tail}"
            if full not in known:
                missing.append(full)
            continue
        # Otherwise the head is the command name; ignore tail (it's args/flags).
        if head not in known:
            missing.append(head)
    return missing


def main() -> None:
    """Console-script entry point.

    Wraps the Typer app so a `ClipwrightError` prints its "Error / Fix"
    form rather than a rich traceback. Commands raise it for problems
    the *user* can fix — a missing project, an unknown segment id — and
    a traceback both buries the fix hint and reads like a crash.
    """
    try:
        app()
    except ClipwrightError as e:
        rprint(e.rich_message())
        raise SystemExit(1) from e


if __name__ == "__main__":
    main()
