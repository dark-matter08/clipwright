"""Persona library, memory, and their reach into prompts and voice.

Every test points `CLIPWRIGHT_HOME` at a tmp dir, so nothing here reads
or writes the developer's real persona library.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.persona import (
    Persona,
    PersonaDraft,
    PersonaError,
    VoiceConfig,
    add_memory,
    clone_persona,
    compose_prose,
    delete_persona,
    graph_data,
    list_memory,
    list_personas,
    load_persona,
    memory_overview,
    new_persona_id,
    save_persona,
    search_memory,
)


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CLIPWRIGHT_HOME", str(tmp_path / "home"))


def _make(name: str = "Manhwa recapper", **kw) -> Persona:
    p = Persona(
        persona_id=new_persona_id(name),
        name=name,
        draft=PersonaDraft(
            role="You are an elite manhwa recap scriptwriter",
            voice="Casual, fast, present tense",
            avoid="Resolve the cliffhanger",
        ),
        **kw,
    )
    p.prose = compose_prose(p.draft)
    save_persona(p)
    return p


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------


def test_save_and_load_roundtrip() -> None:
    p = _make(voice=VoiceConfig(provider="openai", voice_id="marin", pitch_semitones=-1.5))
    got = load_persona(p.persona_id)
    assert got.name == "Manhwa recapper"
    assert got.voice.provider == "openai"
    assert got.voice.voice_id == "marin"
    assert got.voice.pitch_semitones == -1.5
    assert "elite manhwa recap scriptwriter" in got.effective_prose()


def test_ids_are_slugged_and_deduped() -> None:
    a = _make("Manhwa recapper")
    b = _make("Manhwa recapper")
    assert a.persona_id == "manhwa-recapper"
    assert b.persona_id == "manhwa-recapper-2", "a second persona must not overwrite the first"


def test_invalid_id_is_refused() -> None:
    with pytest.raises(PersonaError, match="invalid persona id"):
        save_persona(Persona(persona_id="Not A Slug"))


def test_clone_copies_definition_under_a_new_id() -> None:
    src = _make(voice=VoiceConfig(provider="openai", voice_id="onyx", speed=1.2))
    c = clone_persona(src.persona_id, "Manhwa recapper (dark)")

    assert c.persona_id != src.persona_id
    assert c.cloned_from == src.persona_id
    assert c.voice.voice_id == "onyx" and c.voice.speed == 1.2
    assert c.effective_prose() == src.effective_prose()


def test_clone_is_independent_of_the_original() -> None:
    """The reason clone exists: diverge without disturbing the source."""
    src = _make()
    c = clone_persona(src.persona_id, "Variant")
    c.draft.avoid = "Use exclamation marks"
    c.prose = compose_prose(c.draft)
    save_persona(c)

    assert "exclamation" not in load_persona(src.persona_id).effective_prose()
    assert "exclamation" in load_persona(c.persona_id).effective_prose()


def test_clone_does_not_inherit_memory() -> None:
    """A clone hasn't done the original's work — inheriting its lessons
    would be a false claim about provenance."""
    src = _make()
    add_memory(src.persona_id, "note", "Never open on a wide establishing shot.")
    c = clone_persona(src.persona_id, "Variant")
    assert list_memory(c.persona_id) == []
    assert len(list_memory(src.persona_id)) == 1


def test_malformed_persona_file_does_not_break_the_library() -> None:
    """One bad hand-edit shouldn't make the whole picker unopenable."""
    good = _make()
    bad = Path(load_persona(good.persona_id).persona_id)  # any path in the dir
    from clipwright.persona.paths import personas_dir

    (personas_dir() / "broken.json").write_text("{not json")
    ids = [p.persona_id for p in list_personas()]
    assert good.persona_id in ids
    assert "broken" not in ids
    assert bad is not None  # keep the reference meaningful


def test_delete_removes_from_library() -> None:
    p = _make()
    delete_persona(p.persona_id)
    assert list_personas() == []
    with pytest.raises(PersonaError, match="not found"):
        load_persona(p.persona_id)


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------


def test_memory_search_finds_by_text() -> None:
    p = _make()
    add_memory(p.persona_id, "note", "Never open on a wide establishing shot.")
    add_memory(p.persona_id, "note", "Cut every adverb in the climax beat.")
    hits = [e.body for e in search_memory(p.persona_id, "establishing")]
    assert any("establishing" in h for h in hits)


def test_memory_search_is_scoped_to_one_persona() -> None:
    a = _make("Alpha")
    b = _make("Beta")
    add_memory(a.persona_id, "note", "Alpha rule about pacing.")
    add_memory(b.persona_id, "note", "Beta rule about pacing.")
    hits = [e.body for e in search_memory(a.persona_id, "pacing")]
    assert hits == ["Alpha rule about pacing."]


def test_memory_search_survives_punctuation() -> None:
    """Called mid-turn by the agent — a stray apostrophe or question
    mark is FTS5 syntax and would otherwise fail the whole turn."""
    p = _make()
    add_memory(p.persona_id, "note", "Don't resolve the cliffhanger.")
    for q in ["don't", "cliffhanger?", '"', "AND OR NOT", ""]:
        assert isinstance(search_memory(p.persona_id, q), list)


def test_memory_search_ranks_notes_above_provenance() -> None:
    """A rule you typed should beat a render log that matches equally."""
    p = _make()
    add_memory(p.persona_id, "video", "Produced a recap about dungeons.", source="/x#main")
    add_memory(p.persona_id, "note", "Dungeons: always name the floor number.")
    top = search_memory(p.persona_id, "dungeons")[0]
    assert top.kind == "note"


def test_unknown_memory_kind_is_refused() -> None:
    p = _make()
    with pytest.raises(Exception, match="unknown memory kind"):
        add_memory(p.persona_id, "vibes", "something")


def test_memory_overview_shapes_the_prompt_digest() -> None:
    p = _make()
    add_memory(p.persona_id, "note", "A note.")
    add_memory(p.persona_id, "video", "A video.", source="/x#main")
    ov = memory_overview(p.persona_id)
    assert ov["total"] == 2
    assert ov["counts"] == {"note": 1, "video": 1}
    # Notes outrank provenance, so the digest leads with the note.
    assert ov["top"][0]["kind"] == "note"


def test_graph_links_entries_that_share_a_source() -> None:
    """Shared source is what makes clusters appear in the viewer."""
    p = _make()
    add_memory(p.persona_id, "note", "One.", source="/proj#main")
    add_memory(p.persona_id, "note", "Two.", source="/proj#main")
    add_memory(p.persona_id, "note", "Elsewhere.", source="/other#main")
    g = graph_data(p.persona_id)
    same = [e for e in g["edges"] if e["relation"] == "same-source"]
    assert len(same) == 1, "two entries from one source should be chained once"
    assert same[0]["label"] == "/proj#main"


# ---------------------------------------------------------------------------
# Reach: prompt + voice
# ---------------------------------------------------------------------------


def _seed_project(root: Path, persona_id: str = "") -> None:
    payload = {
        "schema_version": 2, "title": "Recap", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": "manhwa-recap-single",
    }
    if persona_id:
        payload["persona_id"] = persona_id
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.json").write_text(json.dumps(payload))
    (root / "videos").mkdir(exist_ok=True)
    (root / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "", "segments": [],
    }))


def test_prompt_uses_the_library_persona(tmp_path: Path) -> None:
    from clipwright.agent.prompt import build_project_prompt

    p = _make(voice=VoiceConfig(provider="openai", voice_id="marin"))
    root = tmp_path / "proj"
    _seed_project(root, p.persona_id)

    out = build_project_prompt(root)
    assert "## Persona" in out
    assert "Manhwa recapper" in out
    assert "> You are an elite manhwa recap scriptwriter." in out
    # The voice belongs to the persona, so the prompt states it.
    assert "provider `openai`" in out and "voice `marin`" in out


def test_prompt_mandates_a_memory_search(tmp_path: Path) -> None:
    """The retrieval contract: the agent is told to look, not handed
    a guess at what's relevant."""
    from clipwright.agent.prompt import build_project_prompt

    p = _make()
    add_memory(p.persona_id, "note", "Never open on a wide establishing shot.")
    root = tmp_path / "proj"
    _seed_project(root, p.persona_id)

    out = build_project_prompt(root)
    assert "CONSULT BEFORE WRITING" in out
    assert f"clipwright persona memory search {p.persona_id}" in out
    # The digest has to prove memory exists, or the instruction is a
    # search for nothing.
    assert "Never open on a wide establishing shot." in out
    assert "**1** remembered" in out


def test_prompt_handles_a_dangling_persona_reference(tmp_path: Path) -> None:
    """A deleted persona must not break the turn."""
    from clipwright.agent.prompt import build_project_prompt

    root = tmp_path / "proj"
    _seed_project(root, "deleted-persona")
    out = build_project_prompt(root)
    assert "## Persona" not in out
    assert "# Clipwright project context" in out


def test_persona_voice_feeds_synthesis(tmp_path: Path) -> None:
    from clipwright.schema import Project, Video
    from clipwright.tts_segment import resolve_voice_config

    p = _make(voice=VoiceConfig(
        provider="openai", voice_id="marin", speed=1.1,
        pitch_semitones=-2.0, instructions="gravelly, unhurried",
    ))
    project = Project(title="t", persona_id=p.persona_id)
    video = Video(video_id="main")

    cfg = resolve_voice_config(project, video, {})
    assert (cfg.provider, cfg.voice_id) == ("openai", "marin")
    assert cfg.speed == 1.1
    assert cfg.pitch_semitones == -2.0
    assert cfg.instructions == "gravelly, unhurried"


def test_clip_and_video_overrides_beat_the_persona(tmp_path: Path) -> None:
    """Narrower layers still win on provider/voice — but they must not
    silently discard the persona's tone controls."""
    from clipwright.schema import Project, Video
    from clipwright.tts_segment import resolve_voice_config

    p = _make(voice=VoiceConfig(provider="openai", voice_id="marin", pitch_semitones=-2.0))
    project = Project(title="t", persona_id=p.persona_id)

    video = Video(video_id="main", recap_overrides={"voice_id": "onyx"})
    cfg = resolve_voice_config(project, video, {})
    assert cfg.voice_id == "onyx"
    assert cfg.pitch_semitones == -2.0, "per-video voice swap kept the persona's pitch"

    cfg = resolve_voice_config(project, video, {"voice": {"voice_id": "nova"}})
    assert cfg.voice_id == "nova"


def test_dangling_persona_does_not_block_synthesis() -> None:
    from clipwright.schema import Project, Video
    from clipwright.tts_segment import resolve_voice_config

    project = Project(title="t", tts_provider="kokoro", voice_id="af_heart",
                      persona_id="deleted-persona")
    cfg = resolve_voice_config(project, Video(video_id="main"), {})
    assert (cfg.provider, cfg.voice_id) == ("kokoro", "af_heart")
