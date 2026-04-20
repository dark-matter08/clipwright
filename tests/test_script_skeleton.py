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
