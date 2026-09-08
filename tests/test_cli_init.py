"""`clipwright init` must produce a project the rest of the app can open.

It used to write only `.clipwright.json` + `browse-plan.json` — the v1
shape. Everything current (`status`, `video doctor`, the agent prompt,
the desktop app) keys off `project.json`, so an init-ed directory could
not be opened by any of them.
"""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from clipwright.cli import app
from clipwright.schema import list_videos, load_project, load_video


def test_init_writes_a_v2_project(tmp_path: Path) -> None:
    result = CliRunner().invoke(app, ["init", str(tmp_path / "demo")])
    assert result.exit_code == 0, result.output

    root = tmp_path / "demo"
    assert (root / "project.json").exists(), "no v2 manifest — nothing can open this"
    project = load_project(root)
    assert project.title == "demo"
    assert project.aspect == "9:16"


def test_init_seeds_one_empty_video(tmp_path: Path) -> None:
    """A manifest with nowhere to put segments isn't openable."""
    CliRunner().invoke(app, ["init", str(tmp_path / "demo")])
    root = tmp_path / "demo"
    assert list_videos(root) == ["main"]
    assert load_video(root, "main").segments == []


def test_init_still_writes_the_browse_plan(tmp_path: Path) -> None:
    """`record-project` consumes it — dropping it would break Record mode."""
    CliRunner().invoke(app, ["init", str(tmp_path / "demo"), "--url", "https://x.test"])
    plan = json.loads((tmp_path / "demo" / "browse-plan.json").read_text())
    assert plan["base_url"] == "https://x.test"
    assert plan["actions"], "an empty plan gives the user nothing to edit"


def test_init_project_is_readable_by_status(tmp_path: Path) -> None:
    """The end-to-end symptom that started this: status refused an
    init-ed directory because there was no project.json."""
    root = tmp_path / "demo"
    CliRunner().invoke(app, ["init", str(root)])
    result = CliRunner().invoke(app, ["status", "--project", str(root)])
    assert result.exit_code == 0, result.output
    assert "main" in result.output


def test_init_honors_aspect(tmp_path: Path) -> None:
    CliRunner().invoke(app, ["init", str(tmp_path / "wide"), "--aspect", "16:9"])
    assert load_project(tmp_path / "wide").aspect == "16:9"
