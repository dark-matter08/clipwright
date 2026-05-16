"""`clipwright generate ...` must refuse to run without --experimental.

The providers (Veo / Runway / DALL·E) are unverified against the live APIs.
This gate keeps users from spending real money / time on a broken path
unless they've explicitly opted in.
"""
from __future__ import annotations

from typer.testing import CliRunner

from clipwright.cli import app

runner = CliRunner()


def test_generate_intro_refused_without_experimental(tmp_path):
    """Running `clipwright generate intro` without --experimental must exit 2."""
    # We don't even need a real project — the gate must fire before any
    # filesystem / network work happens.
    result = runner.invoke(
        app,
        ["generate", "intro", "--project", str(tmp_path)],
    )
    assert result.exit_code == 2, f"expected exit 2 (refusal), got {result.exit_code}\n{result.output}"
    assert "experimental" in result.output.lower()
    assert "refused" in result.output.lower()


def test_generate_hero_refused_without_experimental(tmp_path):
    result = runner.invoke(
        app,
        ["generate", "hero", "--project", str(tmp_path)],
    )
    assert result.exit_code == 2
    assert "experimental" in result.output.lower()


def test_generate_broll_refused_without_experimental(tmp_path):
    result = runner.invoke(
        app,
        ["generate", "broll", "intro", "--project", str(tmp_path)],
    )
    assert result.exit_code == 2
    assert "experimental" in result.output.lower()


def test_generate_outro_refused_without_experimental(tmp_path):
    result = runner.invoke(
        app,
        ["generate", "outro", "--project", str(tmp_path)],
    )
    assert result.exit_code == 2
    assert "experimental" in result.output.lower()
