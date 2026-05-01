"""Script skeleton builder: one clip per segment, fills target_seconds + hint."""
from __future__ import annotations

import json

from clipwright.plan.script_skeleton import build_skeleton, run


def _segments_doc(segs: list[dict]) -> dict:
    return {"video": "/tmp/x.mp4", "duration": 20.0, "segments": segs}


def test_one_clip_per_segment():
    doc = _segments_doc([
        {
            "source_start": 1.5, "source_end": 3.0, "duration": 1.5,
            "moments": [{"t": 2.0, "type": "click", "label": "Open discover"}],
        },
        {
            "source_start": 5.0, "source_end": 8.0, "duration": 3.0,
            "moments": [
                {"t": 5.5, "type": "type", "label": "Search Blue Lock"},
                {"t": 7.0, "type": "scroll", "label": ""},
            ],
        },
    ])
    sk = build_skeleton(doc)
    assert len(sk["clips"]) == 2
    assert sk["clips"][0]["target_seconds"] == 1.5
    assert sk["clips"][0]["text"] == ""
    assert "Open discover" in sk["clips"][0]["hint"]
    assert "Search Blue Lock" in sk["clips"][1]["hint"]
    assert "scroll" in sk["clips"][1]["hint"]


def test_merge_preserves_filled_text(tmp_path):
    segs_path = tmp_path / "segments.json"
    out_path = tmp_path / "script.json"
    doc = _segments_doc([
        {
            "source_start": 0.0, "source_end": 2.0, "duration": 2.0,
            "moments": [{"t": 1.0, "type": "click", "label": "foo"}],
        },
    ])
    segs_path.write_text(json.dumps(doc))
    run(segs_path, out_path)
    written = json.loads(out_path.read_text())
    written["clips"][0]["text"] = "user-authored copy"
    out_path.write_text(json.dumps(written))

    run(segs_path, out_path)  # regenerate, merge
    final = json.loads(out_path.read_text())
    assert final["clips"][0]["text"] == "user-authored copy"


def test_overwrite_discards_existing(tmp_path):
    segs_path = tmp_path / "segments.json"
    out_path = tmp_path / "script.json"
    doc = _segments_doc([
        {
            "source_start": 0.0, "source_end": 2.0, "duration": 2.0,
            "moments": [{"t": 1.0, "type": "click", "label": "foo"}],
        },
    ])
    segs_path.write_text(json.dumps(doc))
    run(segs_path, out_path)
    written = json.loads(out_path.read_text())
    written["clips"][0]["text"] = "will be lost"
    out_path.write_text(json.dumps(written))

    run(segs_path, out_path, overwrite=True)
    final = json.loads(out_path.read_text())
    assert final["clips"][0]["text"] == ""


def test_draft_populates_text():
    doc = _segments_doc([
        {
            "source_start": 0.0, "source_end": 12.0, "duration": 12.0,
            "chapter": "intro",
            "moments": [{"t": 2.0, "type": "navigate", "label": "Open the app"}],
        },
    ])
    sk = build_skeleton(doc, draft=True)
    text = sk["clips"][0]["text"]
    assert text, "draft should produce non-empty text"
    assert text.endswith("."), "draft text should end with a period for TTS pacing"


def test_draft_respects_word_budget():
    # 5-second clip at 2.5 wps → budget ~12 words; draft should stay close.
    doc = _segments_doc([
        {
            "source_start": 0.0, "source_end": 5.0, "duration": 5.0,
            "chapter": "quick",
            "moments": [
                {"t": 1.0, "type": "click", "label": "Tap the button"},
                {"t": 2.5, "type": "type", "label": "Enter email address"},
                {"t": 4.0, "type": "click", "label": "Submit the form"},
            ],
        },
    ])
    sk = build_skeleton(doc, draft=True)
    text = sk["clips"][0]["text"]
    words = len(text.split())
    # Budget = ceil(5 * 2.5) = 13; allow ±5 words of flex for whole-sentence snapping.
    assert words <= 18, f"draft text too long ({words} words) for a 5s clip"


def test_draft_no_llm(tmp_path):
    # draft=True must not make any network calls — it's purely deterministic.
    segs_path = tmp_path / "segments.json"
    out_path = tmp_path / "script.json"
    doc = _segments_doc([
        {
            "source_start": 0.0, "source_end": 10.0, "duration": 10.0,
            "chapter": "demo",
            "moments": [{"t": 3.0, "type": "scroll", "label": "Browse features"}],
        },
    ])
    segs_path.write_text(json.dumps(doc))
    # If this call completes without hanging / raising an ImportError for
    # any LLM SDK, the test passes.
    result = run(segs_path, out_path, draft=True)
    assert result["clips"][0]["text"]
