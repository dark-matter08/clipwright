"""SKILL.md ↔ CLI sync — the doctor's regression test.

If SKILL.md mentions `clipwright foo` but `foo` isn't a registered Typer
command, agents reading the skill will hit a "command not found" they
can't debug. The doctor surfaces this; this test pins SKILL.md to the
current command list.
"""
from __future__ import annotations

from pathlib import Path

from clipwright.cli import _registered_cli_commands, _skill_md_unknown_commands

SKILL_PATH = Path(__file__).resolve().parent.parent / "SKILL.md"


def test_skill_md_commands_resolve():
    """Every `clipwright <cmd>` mention in SKILL.md must be a real command."""
    assert SKILL_PATH.exists(), f"SKILL.md missing at {SKILL_PATH}"
    missing = _skill_md_unknown_commands(SKILL_PATH)
    assert missing == [], (
        f"SKILL.md references CLI commands the CLI doesn't expose: {sorted(set(missing))}.\n"
        "Either update SKILL.md or add the missing subcommand."
    )


def test_known_commands_include_v2_surface():
    """Sanity: the v2 commands SKILL.md teaches actually exist."""
    cmds = _registered_cli_commands()
    for required in [
        "init", "record-project", "import",
        "render-segment", "render-final",
        "tts-segment", "caption-segment",
        "doctor", "status",
    ]:
        assert required in cmds, f"v2 command {required!r} missing from CLI"


def test_doctor_detects_stale_skill(tmp_path):
    """A SKILL.md with a fictitious command must be flagged."""
    fake_skill = tmp_path / "SKILL.md"
    fake_skill.write_text(
        "Use `clipwright init` to start.\n"
        "Then run `clipwright nonexistent-command` to break things.\n"
    )
    missing = _skill_md_unknown_commands(fake_skill)
    assert "nonexistent-command" in missing
    # `init` is real, must NOT be in missing.
    assert "init" not in missing


def test_doctor_tolerates_flags_in_skill_text(tmp_path):
    """A SKILL.md mention like `clipwright render-final --video main` must
    only check `render-final`, not flag the flag as an unknown command."""
    fake_skill = tmp_path / "SKILL.md"
    fake_skill.write_text("`clipwright render-final --video main`\n")
    missing = _skill_md_unknown_commands(fake_skill)
    assert missing == []
