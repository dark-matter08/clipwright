"""`clipwright persona …` — library and memory from the command line.

Two audiences, and they want different output:

  * **The agent.** The system prompt tells it to search memory before
    writing, so `memory search` has to be greppable and terse. It prints
    one entry per block, plain text, no tables.
  * **You.** `list`, `show`, `clone` are read at a terminal, so those
    get rich formatting.

Everything here also backs a Tauri command, so the desktop and the agent
see exactly the same library — there's no second code path to drift.
"""
from __future__ import annotations

import json

import typer
from rich import print as rprint

from ..errors import ClipwrightError
from .library import (
    Persona,
    PersonaDraft,
    PersonaError,
    VoiceConfig,
    clone_persona,
    compose_prose,
    delete_persona,
    list_personas,
    load_persona,
    new_persona_id,
    save_persona,
)
from .memory import (
    KINDS,
    add_memory,
    delete_memory,
    graph_data,
    list_memory,
    memory_overview,
    search_memory,
)

persona_app = typer.Typer(
    no_args_is_help=True,
    help="Reusable writing personas: library, voice, and memory.",
)
memory_app = typer.Typer(
    no_args_is_help=True,
    help="What a persona has learned and what it has worked on.",
)
persona_app.add_typer(memory_app, name="memory")


def _wrap(e: PersonaError) -> ClipwrightError:
    return ClipwrightError(str(e), fix=e.fix)


@persona_app.command("list")
def persona_list_cmd(
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output."),
) -> None:
    """List every persona in the library."""
    personas = list_personas()
    if as_json:
        print(json.dumps([p.to_dict() for p in personas], indent=2))
        return
    if not personas:
        rprint("[dim]No personas yet — `clipwright persona new \"Name\"`.[/dim]")
        return
    for p in personas:
        v = p.voice
        rprint(
            f"[bold]{p.persona_id}[/bold]  {p.name}\n"
            f"  [dim]{v.provider} · {v.voice_id or '(default)'}"
            + (f" · cloned from {p.cloned_from}" if p.cloned_from else "")
            + "[/dim]"
        )


@persona_app.command("show")
def persona_show_cmd(
    persona_id: str = typer.Argument(..., help="Persona id."),
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output."),
) -> None:
    """Print one persona's definition, voice, and memory summary."""
    try:
        p = load_persona(persona_id)
    except PersonaError as e:
        raise _wrap(e) from e
    if as_json:
        payload = p.to_dict()
        payload["memory"] = memory_overview(persona_id)
        print(json.dumps(payload, indent=2))
        return
    rprint(f"[bold]{p.name}[/bold] [dim]({p.persona_id})[/dim]\n")
    rprint(p.effective_prose() or "[dim](no prose)[/dim]")
    v = p.voice
    rprint(
        f"\n[bold]Voice[/bold] {v.provider} · {v.voice_id or '(default)'} · "
        f"speed {v.speed:g}× · pitch {v.pitch_semitones:+g}st"
    )
    if v.instructions:
        rprint(f"[dim]instructions: {v.instructions}[/dim]")
    ov = memory_overview(persona_id)
    rprint(f"\n[bold]Memory[/bold] {ov['total']} entries {ov['counts']}")


@persona_app.command("new")
def persona_new_cmd(
    name: str = typer.Argument(..., help="Human name, e.g. \"Manhwa recapper\"."),
    role: str = typer.Option("", "--role", help="Completes 'You are…'."),
    provider: str = typer.Option("kokoro", "--provider", help="TTS provider."),
    voice: str = typer.Option("", "--voice", help="Voice id."),
) -> None:
    """Create a persona."""
    p = Persona(
        persona_id=new_persona_id(name),
        name=name,
        draft=PersonaDraft(role=role),
        voice=VoiceConfig(provider=provider, voice_id=voice),
    )
    p.prose = compose_prose(p.draft)
    try:
        save_persona(p)
    except PersonaError as e:
        raise _wrap(e) from e
    rprint(f"[green]Created[/green] {p.persona_id}")


@persona_app.command("clone")
def persona_clone_cmd(
    persona_id: str = typer.Argument(..., help="Persona to copy."),
    name: str = typer.Option("", "--name", help="Name for the copy."),
) -> None:
    """Copy a persona under a new id.

    The copy carries the definition and voice but not the memory — it
    hasn't done the work the original did.
    """
    try:
        c = clone_persona(persona_id, name)
    except PersonaError as e:
        raise _wrap(e) from e
    rprint(f"[green]Cloned[/green] {persona_id} → {c.persona_id}")


@persona_app.command("delete")
def persona_delete_cmd(
    persona_id: str = typer.Argument(..., help="Persona to delete."),
    yes: bool = typer.Option(False, "--yes", help="Skip confirmation."),
) -> None:
    """Delete a persona. Its memory rows are left in place."""
    if not yes:
        rprint(f"[yellow]Pass --yes to delete {persona_id}.[/yellow]")
        raise typer.Exit(1)
    try:
        delete_persona(persona_id)
    except PersonaError as e:
        raise _wrap(e) from e
    rprint(f"[green]Deleted[/green] {persona_id}")


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------


@memory_app.command("add")
def memory_add_cmd(
    persona_id: str = typer.Argument(..., help="Persona id."),
    body: str = typer.Option(..., "--body", help="What to remember."),
    kind: str = typer.Option("note", "--kind", help=f"One of: {', '.join(KINDS)}."),
    title: str = typer.Option("", "--title", help="Short label."),
    source: str = typer.Option("", "--source", help="Where it came from."),
) -> None:
    """Teach a persona something."""
    try:
        e = add_memory(persona_id, kind, body, title=title, source=source)
    except Exception as exc:
        raise ClipwrightError(
            str(exc),
            fix=getattr(exc, "fix", "") or f"Valid kinds: {', '.join(KINDS)}.",
        ) from exc
    rprint(f"[green]Remembered[/green] #{e.id} ({e.kind}) for {persona_id}")


@memory_app.command("search")
def memory_search_cmd(
    persona_id: str = typer.Argument(..., help="Persona id."),
    query: str = typer.Argument("", help="What you're about to write about."),
    limit: int = typer.Option(8, "--limit"),
    as_json: bool = typer.Option(False, "--json", help="Machine-readable output."),
) -> None:
    """Search a persona's memory.

    This is the command the agent prompt instructs Claude to run before
    writing, so the default output is plain and terse — one entry per
    block, easy to quote back to the user.
    """
    entries = search_memory(persona_id, query, limit=limit)
    if as_json:
        print(json.dumps([e.to_dict() for e in entries], indent=2))
        return
    if not entries:
        print(f"(no memory matches for {query!r})")
        return
    for e in entries:
        head = f"[{e.kind}]" + (f" {e.title}" if e.title else "")
        print(head)
        print(f"  {e.body}")
        if e.source:
            print(f"  source: {e.source}")
        print()


@memory_app.command("list")
def memory_list_cmd(
    persona_id: str = typer.Argument(..., help="Persona id."),
    kind: str = typer.Option("", "--kind", help=f"Filter: {', '.join(KINDS)}."),
    limit: int = typer.Option(50, "--limit"),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """List a persona's memory, newest first."""
    entries = list_memory(persona_id, kind=kind, limit=limit)
    if as_json:
        print(json.dumps([e.to_dict() for e in entries], indent=2))
        return
    for e in entries:
        print(f"#{e.id} [{e.kind}] {e.title or e.body[:70]}")


@memory_app.command("forget")
def memory_forget_cmd(
    entry_id: int = typer.Argument(..., help="Memory entry id (from `memory list`)."),
) -> None:
    """Delete one memory entry."""
    delete_memory(entry_id)
    rprint(f"[green]Forgot[/green] #{entry_id}")


@memory_app.command("graph")
def memory_graph_cmd(
    persona_id: str = typer.Argument(..., help="Persona id."),
) -> None:
    """Print the knowledge graph as JSON (nodes + edges).

    Backs the desktop's graph panel; also useful piped into any graph
    tool that reads node/edge JSON.
    """
    print(json.dumps(graph_data(persona_id), indent=2))
