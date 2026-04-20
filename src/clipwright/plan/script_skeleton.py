"""Build a script.json skeleton from segments.json.

Mechanical only — fills `id`, `target_seconds`, and `hint` (derived from
moment types + labels). The Claude Code skill instructs the agent to fill
the empty `text` field; we never call an LLM from the CLI.
"""
from __future__ import annotations

import json
from pathlib import Path


def _hint_for_segment(moments: list[dict]) -> str:
    if not moments:
        return "no actions captured in this segment"
    bits = []
    for m in moments:
        t = m.get("type", "")
        label = (m.get("label") or "").strip()
        bits.append(f"{t}: {label}" if label else t)
    return " → ".join(bits)


def _slug(s: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in s.lower()).strip("_") or "beat"


def build_skeleton(segments_doc: dict) -> dict:
    clips = []
    for i, seg in enumerate(segments_doc.get("segments") or []):
        moments = seg.get("moments") or []
        chapter = seg.get("chapter") or ""
        stem = _slug(chapter) if chapter else (moments[0].get("type") if moments else "beat")
        clips.append({
            "id": f"{i + 1:02d}_{stem}",
            "target_seconds": round(float(seg.get("duration", 0.0)), 3),
            "chapter": chapter,
            "hint": _hint_for_segment(moments),
            "text": "",
        })
    return {"clips": clips}


def run(segments_path: Path, out: Path, *, overwrite: bool = False) -> dict:
    if out.exists() and not overwrite:
        existing = json.loads(out.read_text())
        # Merge: keep any non-empty `text` the user (or Claude) already wrote.
        segments_doc = json.loads(segments_path.read_text())
        skeleton = build_skeleton(segments_doc)
        text_by_id = {c["id"]: c.get("text", "") for c in existing.get("clips") or []}
        for c in skeleton["clips"]:
            if text_by_id.get(c["id"]):
                c["text"] = text_by_id[c["id"]]
        out.write_text(json.dumps(skeleton, indent=2) + "\n")
        return skeleton
    segments_doc = json.loads(segments_path.read_text())
    skeleton = build_skeleton(segments_doc)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(skeleton, indent=2) + "\n")
    return skeleton
