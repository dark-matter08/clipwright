"""Tests for the Claude Code system-prompt builder (SRS §9.2)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipwright.agent import (
    PromptError,
    build_project_prompt,
    build_segment_prompt,
)
from clipwright.agent.prompt import (
    NEIGHBOR_RADIUS,
    _find_script_clip,
    _flatten_transcript_words,
)
from clipwright.schema import (
    Project,
    Segment,
    SegmentRef,
    SegmentVoiceover,
    Timeline,
    save_project,
    save_timeline,
)

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------


def _seg(
    sid: str,
    *,
    label: str = "",
    chapter: str = "",
    start: float = 0.0,
    end: float = 10.0,
    vo_clip: str = "",
) -> Segment:
    return Segment(
        id=sid,
        source="sources/main.mp4",
        source_start=start,
        source_end=end,
        target_duration=end - start,
        kind="recording",
        label=label,
        chapter=chapter,
        voiceover=SegmentVoiceover(enabled=True, script_clip_id=vo_clip),
        captions=SegmentRef(enabled=True, ref=f"captions/index.json#{sid}"),
        camera=SegmentRef(enabled=False, ref=""),
        annotations=SegmentRef(enabled=False, ref=""),
    )


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """Five-segment project covering all the prompt's interesting cases."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    save_project(
        project_dir,
        Project(
            title="Launch Demo",
            aspect="9:16",
            fps=30,
            render_backend="remotion",
            tts_provider="kokoro",
            voice_id="af_sky",
            base_url="https://example.com",
        ),
    )
    save_timeline(
        project_dir,
        Timeline(segments=[
            _seg("seg_001", label="Intro",     chapter="intro",   start=0,  end=10, vo_clip="vo_001"),
            _seg("seg_002", label="Library",   chapter="library", start=10, end=22, vo_clip="vo_002"),
            _seg("seg_003", label="Reader",    chapter="reader",  start=22, end=34, vo_clip="vo_003"),
            _seg("seg_004", label="Share",     chapter="share",   start=34, end=44, vo_clip="vo_004"),
            _seg("seg_005", label="Outro",     chapter="outro",   start=44, end=52, vo_clip="vo_005"),
        ]),
    )
    # voiceover/script.json
    (project_dir / "voiceover").mkdir()
    (project_dir / "voiceover" / "script.json").write_text(json.dumps({
        "schema_version": 1,
        "clips": [
            {"id": "vo_003", "segment_id": "seg_003", "target_seconds": 12.0,
             "text": "Open the reader.", "hint": "shows reader settings panel"},
        ],
    }))
    return project_dir


# ---------------------------------------------------------------------------
# Mode A — project-scoped
# ---------------------------------------------------------------------------


def test_project_prompt_has_header_and_timeline(project: Path) -> None:
    text = build_project_prompt(project)

    assert "# Clipwright project context" in text
    assert "Launch Demo" in text
    assert "Aspect: 9:16" in text
    assert "TTS provider: kokoro" in text
    assert "Voice id: af_sky" in text
    assert "Base URL: https://example.com" in text
    # all five segments listed
    for sid in ["seg_001", "seg_002", "seg_003", "seg_004", "seg_005"]:
        assert sid in text


def test_project_prompt_no_focus_section(project: Path) -> None:
    """Mode A must NOT include the Focus, Neighbors, or Transcript sections."""
    text = build_project_prompt(project)
    assert "## Focus" not in text
    assert "## Neighbors" not in text
    assert "## Transcript" not in text


def test_project_prompt_includes_constraints(project: Path) -> None:
    text = build_project_prompt(project)
    assert "## Constraints" in text
    assert "schema_version" in text
    assert "network" in text.lower()
    # no segment-specific constraint without a focus
    assert "Stay scoped to segment" not in text


def test_project_prompt_includes_skill_pointer(project: Path) -> None:
    text = build_project_prompt(project)
    assert "~/.claude/skills/clipwright" in text
    assert "SKILL.md" in text


# ---------------------------------------------------------------------------
# Mode B — segment-scoped
# ---------------------------------------------------------------------------


def test_segment_prompt_marks_focus_in_timeline(project: Path) -> None:
    text = build_segment_prompt(project, "seg_003")
    # focused row carries the marker
    focus_line = next(
        line for line in text.splitlines() if "seg_003" in line and "← focus" in line
    )
    assert "Reader" in focus_line


def test_segment_prompt_has_focus_section(project: Path) -> None:
    text = build_segment_prompt(project, "seg_003")
    assert "## Focus: seg_003" in text
    assert "Chapter: reader" in text
    assert "Source: sources/main.mp4 [22.00–34.00s]" in text


def test_segment_prompt_inlines_script_text(project: Path) -> None:
    text = build_segment_prompt(project, "seg_003")
    assert "### Voiceover script" in text
    assert "Open the reader." in text
    assert "shows reader settings panel" in text  # hint


def test_segment_prompt_neighbors_respects_radius(project: Path) -> None:
    """Focus seg_003 should show seg_001..seg_005 minus itself (radius=2)."""
    text = build_segment_prompt(project, "seg_003")
    neighbors_block = text.split("## Neighbors")[1].split("##")[0]
    for sid in ["seg_001", "seg_002", "seg_004", "seg_005"]:
        assert sid in neighbors_block, f"missing neighbor {sid}"
    # focus itself is excluded from Neighbors (it has its own Focus section)
    focus_lines = [
        line for line in neighbors_block.splitlines()
        if "seg_003" in line and "prev" in line or "next" in line and "seg_003" in line
    ]
    assert not focus_lines


def test_segment_prompt_neighbors_clamped_at_edges(project: Path) -> None:
    """seg_001 has no prev; seg_005 has no next. Within-radius only."""
    first = build_segment_prompt(project, "seg_001").split("## Neighbors")[1].split("##")[0]
    assert "seg_002" in first
    assert "seg_003" in first
    assert "seg_004" not in first  # outside radius

    last = build_segment_prompt(project, "seg_005").split("## Neighbors")[1].split("##")[0]
    assert "seg_004" in last
    assert "seg_003" in last
    assert "seg_002" not in last


def test_segment_prompt_adds_scoped_constraint(project: Path) -> None:
    text = build_segment_prompt(project, "seg_003")
    assert "Stay scoped to segment `seg_003`" in text


def test_segment_prompt_unknown_id_raises(project: Path) -> None:
    with pytest.raises(PromptError, match="not found"):
        build_segment_prompt(project, "seg_999")


# ---------------------------------------------------------------------------
# Transcript window
# ---------------------------------------------------------------------------


def test_transcript_window_absent_when_no_file(project: Path) -> None:
    text = build_segment_prompt(project, "seg_003")
    assert "no transcript available" in text


def test_transcript_window_flat_shape(project: Path) -> None:
    """Flat `{"words": [...]}` shape is supported."""
    (project / "sources").mkdir()
    (project / "sources" / "main.transcript.json").write_text(json.dumps({
        "words": [
            {"text": "earlier", "start": 5.0, "end": 5.5},  # before [22-1, 34+1]
            {"text": "open",    "start": 22.5, "end": 23.0},
            {"text": "the",     "start": 23.0, "end": 23.3},
            {"text": "reader",  "start": 23.3, "end": 23.8},
            {"text": "afterward", "start": 50.0, "end": 50.5},  # after window
        ],
    }))
    text = build_segment_prompt(project, "seg_003")
    transcript_block = text.split("## Transcript window")[1].split("##")[0]
    assert "open the reader" in transcript_block
    assert "earlier" not in transcript_block
    assert "afterward" not in transcript_block


def test_transcript_window_nested_whisper_shape(project: Path) -> None:
    """faster-whisper / whisper-cpp segments[].words[] shape works too."""
    (project / "sources").mkdir()
    (project / "sources" / "main.transcript.json").write_text(json.dumps({
        "segments": [
            {"words": [
                {"word": "open",   "start": 22.3, "end": 22.8},
                {"word": "the",    "start": 22.8, "end": 23.0},
                {"word": "reader", "start": 23.0, "end": 23.6},
            ]},
        ],
    }))
    text = build_segment_prompt(project, "seg_003")
    assert "open the reader" in text


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def test_find_script_clip_by_id() -> None:
    script = {"clips": [{"id": "vo_xyz", "text": "hello"}]}
    seg = _seg("seg_001", vo_clip="vo_xyz")
    assert _find_script_clip(script, seg)["text"] == "hello"


def test_find_script_clip_by_segment_id_fallback() -> None:
    """When script_clip_id isn't set, fall back to matching `segment_id`."""
    script = {"clips": [{"id": "x", "segment_id": "seg_001", "text": "fallback"}]}
    seg = _seg("seg_001", vo_clip="")
    assert _find_script_clip(script, seg)["text"] == "fallback"


def test_find_script_clip_none() -> None:
    assert _find_script_clip(None, _seg("seg_001")) is None
    assert _find_script_clip({"clips": []}, _seg("seg_001")) is None


def test_flatten_transcript_words_flat() -> None:
    out = _flatten_transcript_words({"words": [{"text": "a"}, {"text": "b"}]})
    assert [w["text"] for w in out] == ["a", "b"]


def test_flatten_transcript_words_nested() -> None:
    out = _flatten_transcript_words({
        "segments": [
            {"words": [{"word": "a"}]},
            {"words": [{"word": "b"}, {"word": "c"}]},
        ],
    })
    assert [w["word"] for w in out] == ["a", "b", "c"]


def test_flatten_transcript_words_empty() -> None:
    assert _flatten_transcript_words({}) == []


def test_neighbor_radius_constant_is_two() -> None:
    """If this changes, the neighbor tests must be updated."""
    assert NEIGHBOR_RADIUS == 2


# ---------------------------------------------------------------------------
# Determinism — same project state → byte-identical prompts
# ---------------------------------------------------------------------------


def test_project_prompt_deterministic(project: Path) -> None:
    assert build_project_prompt(project) == build_project_prompt(project)


def test_segment_prompt_deterministic(project: Path) -> None:
    assert build_segment_prompt(project, "seg_003") == build_segment_prompt(project, "seg_003")
