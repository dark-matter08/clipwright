"""Tests for per-project recap preferences + agent-prompt injection.

These knobs sit between the template's defaults and the user's
intent — most importantly the target duration, which lets a user say
"I want a 3-minute recap" without the template's "aim for 60–90s"
ceiling silently compressing the script.
"""
from __future__ import annotations

import json
from pathlib import Path

from clipwright.agent.prompt import build_project_prompt
from clipwright.recap_config import (
    OutroSpec,
    RecapConfig,
    config_path,
    load_recap_config,
    save_recap_config,
)


def _seed_v2(d: Path, *, template_id: str = "manhwa-recap-single") -> None:
    payload = {
        "schema_version": 2, "title": "Recap", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": template_id,
    }
    (d / "project.json").write_text(json.dumps(payload))
    (d / "videos").mkdir()
    (d / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "", "segments": [],
    }))


def test_load_returns_defaults_when_missing(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    cfg = load_recap_config(tmp_path)
    # Default target is now 1:30 (90s) — not unset. So a fresh project
    # already carries an explicit duration into the agent prompt.
    assert cfg.target_duration_seconds == 90
    assert cfg.outro.duration_seconds == 3.0
    assert cfg.narration_style == ""
    assert cfg.outro.description == ""
    # has_overrides returns True because the duration defaults are
    # non-zero — the prompt section is always emitted now.
    assert cfg.has_overrides()


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    cfg = RecapConfig(
        target_duration_seconds=180,
        narration_style="deep male, dramatic",
        additional_notes="Always keep the protagonist's full name.",
        outro=OutroSpec(
            description="Like + follow, link in bio.",
            duration_seconds=4.0,
        ),
    )
    save_recap_config(tmp_path, cfg)
    assert config_path(tmp_path).exists()
    loaded = load_recap_config(tmp_path)
    assert loaded.target_duration_seconds == 180
    assert loaded.narration_style == "deep male, dramatic"
    assert loaded.outro.duration_seconds == 4.0
    assert loaded.has_overrides()


def test_load_tolerates_malformed_json(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    cfg_path = config_path(tmp_path)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text("{ not valid json ")
    cfg = load_recap_config(tmp_path)
    # Soft-fail to defaults rather than raise — the settings dialog
    # should always open to *something* the user can edit. Defaults
    # are 90s target + 3s outro.
    assert cfg.target_duration_seconds == 90
    assert cfg.outro.duration_seconds == 3.0


def test_has_overrides_flags_each_field(tmp_path: Path) -> None:
    # Default config has non-zero target + outro durations, so it
    # always reports overrides — the prompt section is always emitted.
    assert RecapConfig().has_overrides() is True
    assert RecapConfig(target_duration_seconds=120).has_overrides() is True
    assert RecapConfig(narration_style="x").has_overrides() is True
    assert RecapConfig(additional_notes="x").has_overrides() is True
    assert RecapConfig(outro=OutroSpec(description="x")).has_overrides() is True
    # The only way to disable injection is to construct an explicitly-
    # empty config (zero out the defaults).
    empty = RecapConfig(
        target_duration_seconds=0,
        outro=OutroSpec(description="", duration_seconds=0.0),
    )
    assert empty.has_overrides() is False


def test_effective_outro_falls_back_to_cyberpunk_title() -> None:
    """An empty description triggers the cyberpunk-title default."""
    cfg = RecapConfig()  # default description=""
    desc = cfg.effective_outro_description("Leveling With The Gods")
    assert "Cyberpunk" in desc
    assert "Leveling With The Gods" in desc
    # User-typed description short-circuits the fallback.
    cfg.outro.description = "Plain black card, no audio."
    assert cfg.effective_outro_description("ignored") == "Plain black card, no audio."


def test_effective_outro_handles_empty_title() -> None:
    """No project title → fallback uses 'Clipwright' as a placeholder
    rather than rendering an awkward empty-quote string."""
    cfg = RecapConfig()
    desc = cfg.effective_outro_description("")
    assert "Clipwright" in desc


def test_prompt_omits_preferences_section_when_explicitly_empty(tmp_path: Path) -> None:
    """Save a deliberately empty config — verify the section is omitted.
    Default-constructed configs always emit the section because the
    duration defaults are non-zero (1:30 target, 3s outro)."""
    _seed_v2(tmp_path)
    save_recap_config(tmp_path, RecapConfig(
        target_duration_seconds=0,
        outro=OutroSpec(description="", duration_seconds=0.0),
    ))
    out = build_project_prompt(tmp_path)
    assert "## Project preferences" not in out


def test_prompt_includes_default_target_for_fresh_project(tmp_path: Path) -> None:
    """A new project with no .clipwright/recap-config.json still gets
    the 90s default injected — that's the user's stated preference."""
    _seed_v2(tmp_path)
    out = build_project_prompt(tmp_path)
    assert "Target duration: 90 seconds" in out


def test_prompt_includes_default_outro_with_project_title(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    # Override the project title so we can verify it's threaded in.
    payload = json.loads((tmp_path / "project.json").read_text())
    payload["title"] = "Leveling With The Gods"
    (tmp_path / "project.json").write_text(json.dumps(payload))
    out = build_project_prompt(tmp_path)
    # Even with no user-typed outro, the cyberpunk-title fallback
    # makes it into the prompt.
    assert "Cyberpunk" in out
    assert "Leveling With The Gods" in out
    assert "~3.0s" in out


def test_prompt_includes_target_duration_when_set(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    save_recap_config(tmp_path, RecapConfig(target_duration_seconds=180))
    out = build_project_prompt(tmp_path)
    assert "## Project preferences" in out
    assert "Target duration: 180 seconds" in out
    # Critical phrasing — Claude must not compress when user says 180.
    assert "Do not compress" in out


def test_prompt_includes_outro_spec_when_set(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    save_recap_config(tmp_path, RecapConfig(
        outro=OutroSpec(
            description="Black bg, channel logo, voiceover: like + follow.",
            duration_seconds=5.0,
        ),
    ))
    out = build_project_prompt(tmp_path)
    assert "Outro spec" in out
    assert "Black bg, channel logo" in out
    # Tells Claude how to mark the final segment so the renderer
    # treats it specially.
    assert 'scene_type' in out and 'outro' in out


def test_prompt_uses_per_video_duration_override(tmp_path: Path) -> None:
    """A Video with `target_duration_seconds_override > 0` should beat
    the project-level default in the agent prompt."""
    _seed_v2(tmp_path)
    # Project default = 90 (the new default); video override = 240.
    (tmp_path / "videos" / "main.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "main", "title": "Main",
        "chat_session_id": "", "segments": [],
        "target_duration_seconds_override": 240,
    }))
    out = build_project_prompt(tmp_path)
    assert "Target duration: 240 seconds" in out
    assert "per-video override" in out
    assert "project default is 90s" in out


def test_prompt_omits_per_video_label_when_no_override(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    out = build_project_prompt(tmp_path)
    assert "every video in this project" in out
    assert "per-video override" not in out


def test_prompt_includes_narration_and_notes(tmp_path: Path) -> None:
    _seed_v2(tmp_path)
    save_recap_config(tmp_path, RecapConfig(
        narration_style="deep male, slight rasp",
        additional_notes="Audience is shounen fans. No spoilers past chapter being recapped.",
    ))
    out = build_project_prompt(tmp_path)
    assert "Narration style:** deep male, slight rasp" in out
    assert "Audience is shounen fans" in out


def test_prompt_tolerates_string_outro_legacy_shape(tmp_path: Path) -> None:
    """An older recap-config that wrote outro as a bare string instead
    of an object shouldn't crash loading. We coerce to OutroSpec."""
    _seed_v2(tmp_path)
    cfg_path = config_path(tmp_path)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps({"outro": "subscribe and like"}))
    cfg = load_recap_config(tmp_path)
    assert cfg.outro.description == "subscribe and like"
    assert cfg.outro.duration_seconds == 3.0  # new default
