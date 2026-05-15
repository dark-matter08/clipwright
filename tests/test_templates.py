"""Tests for the project-template registry and Project.template_id wiring.

Three concerns covered:
  - Registry: shipped templates load + look up by id; missing id raises.
  - Schema:  Project.template_id round-trips through to_dict / from_dict
             and is omitted from JSON when empty (forward-compat).
  - Prompt:  build_project_prompt appends a `## Template guidance`
             section when a template is bound; omits it when not.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.agent.prompt import build_project_prompt
from clipwright.schema.v2.project import Project
from clipwright.templates import (
    TemplateError,
    get_template,
    list_templates,
    load_template_for_project,
)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_list_templates_includes_shipped_templates() -> None:
    ids = {m.template_id for m in list_templates()}
    assert "manhwa-recap-single" in ids
    assert "manhwa-recap-multi" in ids
    assert "product-demo" in ids


def test_get_template_returns_full_payload() -> None:
    t = get_template("manhwa-recap-single")
    assert t.name == "Manhwa Recap — Single Chapter"
    assert t.category == "recap"
    # Structural marker — the rewritten prompt requires a panel-level
    # workflow. If this string vanishes the prompt has been gutted.
    assert "Ken Burns" in t.system_prompt
    assert t.defaults.get("aspect") == "9:16"


def test_get_template_unknown_id_raises() -> None:
    with pytest.raises(TemplateError):
        get_template("does-not-exist")


def test_load_template_for_project_none_when_unbound(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    assert load_template_for_project(tmp_path) is None


def test_load_template_for_project_returns_bound_template(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": "product-demo",
    }))
    t = load_template_for_project(tmp_path)
    assert t is not None
    assert t.template_id == "product-demo"


def test_load_template_for_project_missing_id_returns_none(tmp_path: Path) -> None:
    """A stale `template_id` shouldn't break project load."""
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": "this-template-was-deleted",
    }))
    assert load_template_for_project(tmp_path) is None


# ---------------------------------------------------------------------------
# Schema round-trip
# ---------------------------------------------------------------------------


def test_project_template_id_round_trips() -> None:
    p = Project(title="t", template_id="manhwa-recap-multi")
    d = p.to_dict()
    assert d["template_id"] == "manhwa-recap-multi"
    p2 = Project.from_dict(d)
    assert p2.template_id == "manhwa-recap-multi"


def test_project_omits_template_id_when_empty() -> None:
    """Forward-compat: clean project.json files for untemplated projects."""
    p = Project(title="t")
    d = p.to_dict()
    assert "template_id" not in d


def test_project_loads_with_template_id_absent() -> None:
    """Older project.json files that predate the field still load."""
    d = {
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "voice_id": "", "base_url": "", "created_at": "",
    }
    p = Project.from_dict(d)
    assert p.template_id == ""


# ---------------------------------------------------------------------------
# Agent prompt injection
# ---------------------------------------------------------------------------


def _seed_v2_project(d: Path, template_id: str = "") -> None:
    project_payload = {
        "schema_version": 2, "title": "Recap", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }
    if template_id:
        project_payload["template_id"] = template_id
    (d / "project.json").write_text(json.dumps(project_payload))
    (d / "videos").mkdir()
    (d / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "", "segments": [],
    }))


def test_prompt_includes_template_section_when_bound(tmp_path: Path) -> None:
    _seed_v2_project(tmp_path, template_id="manhwa-recap-single")
    out = build_project_prompt(tmp_path)
    assert "## Template guidance" in out
    assert "Manhwa Recap — Single Chapter" in out


def test_prompt_omits_template_section_when_unbound(tmp_path: Path) -> None:
    _seed_v2_project(tmp_path)
    out = build_project_prompt(tmp_path)
    assert "## Template guidance" not in out


# ---------------------------------------------------------------------------
# `clipwright templates apply` — defaults propagation
# ---------------------------------------------------------------------------


def _apply_via_typer(args: list[str], cwd: Path) -> int:
    """Invoke the typer app in-process so we don't shell out per test."""
    import os

    from typer.testing import CliRunner

    from clipwright.cli import app
    prev = Path.cwd()
    os.chdir(cwd)
    try:
        runner = CliRunner()
        result = runner.invoke(app, ["templates", "apply", *args])
    finally:
        os.chdir(prev)
    if result.exit_code != 0:
        # Surface the rich-formatted traceback so failures debug cleanly.
        raise AssertionError(f"templates apply failed: {result.output}\n{result.stderr if result.stderr_bytes else ''}")
    return result.exit_code


def test_apply_propagates_defaults_into_blank_fields(tmp_path: Path) -> None:
    """Fresh project missing voice_id: template fills it in.

    `product-demo`'s defaults include aspect=16:9 and tts_provider=kokoro.
    A project with aspect="9:16" should KEEP its aspect (user-set) but
    pick up voice_id from the template (blank field).
    """
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t",
        "aspect": "9:16",            # user-set, must survive
        "fps": 30,
        "render_backend": "remotion",
        "tts_provider": "kokoro",
        "voice_id": "",              # blank, template should fill
    }))
    _apply_via_typer(["product-demo"], tmp_path)
    after = json.loads((tmp_path / "project.json").read_text())
    assert after["template_id"] == "product-demo"
    assert after["aspect"] == "9:16"  # user-set, untouched
    # voice_id in the shipped product-demo is "" — so we just verify the
    # binding stuck without overwriting an explicit value.


def test_apply_with_overwrite_flag_replaces_user_values(tmp_path: Path) -> None:
    """`--overwrite-defaults` is the New-Project-flow's escape hatch."""
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t",
        "aspect": "9:16",
        "fps": 30,
        "render_backend": "remotion",
        "tts_provider": "kokoro",
        "voice_id": "",
    }))
    _apply_via_typer(["product-demo", "--overwrite-defaults"], tmp_path)
    after = json.loads((tmp_path / "project.json").read_text())
    # product-demo recommends 16:9; with --overwrite-defaults the user's
    # 9:16 gets replaced.
    assert after["aspect"] == "16:9"


def test_apply_clear_drops_template_id(tmp_path: Path) -> None:
    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": "manhwa-recap-single",
    }))
    _apply_via_typer(["-"], tmp_path)
    after = json.loads((tmp_path / "project.json").read_text())
    assert "template_id" not in after


def test_template_meta_includes_defaults() -> None:
    """The desktop picker pulls `defaults` off `TemplateMeta`."""
    metas = list_templates()
    by_id = {m.template_id: m for m in metas}
    assert by_id["product-demo"].defaults.get("aspect") == "16:9"
    assert by_id["manhwa-recap-single"].defaults.get("aspect") == "9:16"


# ---------------------------------------------------------------------------
# User templates dir — merged catalog, user wins on collision
# ---------------------------------------------------------------------------


@pytest.fixture
def isolated_user_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect `~/.clipwright/...` to a tmp_path so tests don't touch
    real user state. Returns the user templates data dir."""
    monkeypatch.setenv("CLIPWRIGHT_HOME", str(tmp_path / "home"))
    udir = tmp_path / "home" / "templates" / "data"
    udir.mkdir(parents=True)
    return udir


def _write_user_template(udir: Path, template_id: str, **overrides: object) -> None:
    payload: dict[str, object] = {
        "template_id": template_id,
        "name": f"User {template_id}",
        "category": "custom",
        "summary": "custom template summary",
        "system_prompt": "# Custom\n\nDo what the user says.",
        "defaults": {"aspect": "1:1"},
    }
    payload.update(overrides)
    (udir / f"{template_id}.json").write_text(json.dumps(payload))


def test_user_templates_show_up_in_catalog(isolated_user_dir: Path) -> None:
    _write_user_template(isolated_user_dir, "my-custom")
    ids = {m.template_id for m in list_templates()}
    assert "my-custom" in ids
    # Shipped ones still present.
    assert "manhwa-recap-single" in ids


def test_user_template_overrides_shipped_id(isolated_user_dir: Path) -> None:
    """Dropping a same-id user template wins lookup — no fork needed."""
    _write_user_template(
        isolated_user_dir,
        "manhwa-recap-single",
        name="My Override",
        category="recap",
        system_prompt="# My override\n",
    )
    t = get_template("manhwa-recap-single")
    assert t.name == "My Override"
    assert t.source == "user"
    assert "My override" in t.system_prompt


def test_user_template_carries_source_badge(isolated_user_dir: Path) -> None:
    _write_user_template(isolated_user_dir, "my-custom")
    metas = {m.template_id: m for m in list_templates()}
    assert metas["my-custom"].source == "user"
    assert metas["manhwa-recap-single"].source == "shipped"


def test_cli_templates_new_scaffolds_blank(isolated_user_dir: Path) -> None:
    """`templates new` writes a starter file under the user dir."""
    from typer.testing import CliRunner
    from clipwright.cli import app

    result = CliRunner().invoke(app, ["templates", "new", "my-new"])
    assert result.exit_code == 0, result.output
    target = isolated_user_dir / "my-new.json"
    assert target.exists()
    payload = json.loads(target.read_text())
    assert payload["template_id"] == "my-new"
    assert payload["category"] == "custom"
    assert "TODO" in payload["summary"]


def test_cli_templates_new_from_existing_clones_fields(isolated_user_dir: Path) -> None:
    from typer.testing import CliRunner
    from clipwright.cli import app

    result = CliRunner().invoke(
        app,
        ["templates", "new", "my-fork", "--from", "manhwa-recap-single"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads((isolated_user_dir / "my-fork.json").read_text())
    assert payload["template_id"] == "my-fork"
    # Inherited from the base.
    assert payload["category"] == "recap"
    assert "Ken Burns" in payload["system_prompt"]


def test_cli_templates_new_refuses_overwrite_without_force(isolated_user_dir: Path) -> None:
    from typer.testing import CliRunner
    from clipwright.cli import app

    runner = CliRunner()
    first = runner.invoke(app, ["templates", "new", "dup"])
    assert first.exit_code == 0
    second = runner.invoke(app, ["templates", "new", "dup"])
    assert second.exit_code != 0
    third = runner.invoke(app, ["templates", "new", "dup", "--force"])
    assert third.exit_code == 0


def test_cli_templates_path_returns_dir(isolated_user_dir: Path) -> None:
    from typer.testing import CliRunner
    from clipwright.cli import app

    result = CliRunner().invoke(app, ["templates", "path"])
    assert result.exit_code == 0
    assert str(isolated_user_dir) in result.output


def test_cli_templates_path_for_one_template(isolated_user_dir: Path) -> None:
    from typer.testing import CliRunner
    from clipwright.cli import app

    _write_user_template(isolated_user_dir, "my-custom")
    result = CliRunner().invoke(app, ["templates", "path", "my-custom"])
    assert result.exit_code == 0
    assert (isolated_user_dir / "my-custom.json").as_posix() in result.output.replace("\\", "/")


# ---------------------------------------------------------------------------
# Multi-template binding
# ---------------------------------------------------------------------------


def test_project_persists_template_ids(tmp_path: Path) -> None:
    """Round-trip a multi-template binding through the v2 Project."""
    from clipwright.schema.v2.project import Project

    project_path = tmp_path / "project.json"
    project_path.write_text(json.dumps({
        "schema_version": 2, "title": "Recap+demo", "aspect": "9:16",
        "fps": 30, "render_backend": "remotion", "tts_provider": "kokoro",
        "template_ids": ["manhwa-recap-single", "product-demo"],
    }))
    project = Project.from_dict(json.loads(project_path.read_text()))
    assert project.template_ids == ["manhwa-recap-single", "product-demo"]
    # Legacy single field mirrors the primary so older readers still
    # see a meaningful binding.
    assert project.template_id == "manhwa-recap-single"

    # And the round-trip serializes both shapes.
    payload = project.to_dict()
    assert payload["template_ids"] == ["manhwa-recap-single", "product-demo"]
    assert payload["template_id"] == "manhwa-recap-single"


def test_project_loads_legacy_template_id(tmp_path: Path) -> None:
    """A project bound before multi-template landed (single
    `template_id` field, no `template_ids`) loads with the legacy id
    promoted into the new list."""
    from clipwright.schema.v2.project import Project

    project = Project.from_dict({
        "schema_version": 2, "title": "Old", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": "manhwa-recap-single",
    })
    assert project.template_ids == ["manhwa-recap-single"]


def test_prompt_concats_multiple_templates(tmp_path: Path) -> None:
    """Binding two templates should produce two `## Template
    guidance` sections in the agent prompt — one per template,
    each clearly labeled primary/secondary."""
    _seed_v2_project(tmp_path, template_id="manhwa-recap-single")
    # Override project.json to add the secondary binding.
    payload = json.loads((tmp_path / "project.json").read_text())
    payload["template_ids"] = ["manhwa-recap-single", "product-demo"]
    payload["template_id"] = "manhwa-recap-single"
    (tmp_path / "project.json").write_text(json.dumps(payload))

    out = build_project_prompt(tmp_path)
    assert "Manhwa Recap — Single Chapter (primary)" in out
    assert "Product Demo (secondary)" in out
    # Combined-lens prelude explains how Claude should reason about
    # overlapping templates.
    assert "Combined template lens" in out
    assert "Apply ALL of them" in out


def test_prompt_tolerates_missing_template_binding(tmp_path: Path) -> None:
    """A stale id (template was deleted from disk between binding
    and load) shouldn't break the prompt — emit a degraded note for
    that binding, keep the others."""
    _seed_v2_project(tmp_path, template_id="manhwa-recap-single")
    payload = json.loads((tmp_path / "project.json").read_text())
    payload["template_ids"] = ["manhwa-recap-single", "made-up-id"]
    (tmp_path / "project.json").write_text(json.dumps(payload))

    out = build_project_prompt(tmp_path)
    assert "Manhwa Recap" in out
    assert "missing: made-up-id" in out


def test_cli_templates_apply_multiple(tmp_path: Path) -> None:
    """`clipwright templates apply A B` binds A as primary and B
    as secondary."""
    from typer.testing import CliRunner
    from clipwright.cli import app

    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
    }))
    result = CliRunner().invoke(
        app,
        ["templates", "apply", "manhwa-recap-single", "product-demo",
         "--project", str(tmp_path)],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads((tmp_path / "project.json").read_text())
    assert payload["template_ids"] == ["manhwa-recap-single", "product-demo"]
    assert payload["template_id"] == "manhwa-recap-single"


def test_cli_templates_apply_clear_with_dash(tmp_path: Path) -> None:
    """The `-` sentinel clears every binding."""
    from typer.testing import CliRunner
    from clipwright.cli import app

    (tmp_path / "project.json").write_text(json.dumps({
        "schema_version": 2, "title": "t", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_ids": ["manhwa-recap-single", "product-demo"],
        "template_id": "manhwa-recap-single",
    }))
    result = CliRunner().invoke(
        app, ["templates", "apply", "-", "--project", str(tmp_path)],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads((tmp_path / "project.json").read_text())
    assert "template_ids" not in payload
    assert "template_id" not in payload


def test_render_dispatch_uses_primary_template(tmp_path: Path) -> None:
    """`_should_use_manhwa_preset` should be evaluated against the
    PRIMARY template — secondaries don't drive the renderer."""
    from clipwright import render_final as rf

    # Primary = manhwa → manhwa render path picks up.
    assert rf._should_use_manhwa_preset("manhwa-recap-single") is True
    # Primary = product-demo → falls through to the legacy concat.
    assert rf._should_use_manhwa_preset("product-demo") is False
