"""Build a script.json skeleton from segments.json.

Mechanical only — fills `id`, `target_seconds`, and `hint` (derived from
moment types + labels). The Claude Code skill instructs the agent to fill
the empty `text` field; we never call an LLM from the CLI.

The ``--draft`` flag populates each clip's ``text`` with a heuristic draft
derived from the hint and the SKILL.md prosody rules (2.5 wps, fragment
sentences, period-as-pause). It's a starting point, not a final copy.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

_TARGET_WPS = 2.5  # words per second — from SKILL.md §Principle 5


def _draft_text(hint: str, target_seconds: float) -> str:
    """Produce a rough voiceover draft from the action hint.

    Rules applied (mirrors SKILL.md §Script writing):
    - Target ≈ 2.5 words/sec. Word budget = round(target_seconds * 2.5).
    - Convert hint labels to short imperative fragments.
    - Capitalise each fragment and end with a period.
    - Join multiple fragments with ". " so TTS pauses between them.
    """
    if not hint or hint == "no actions captured in this segment":
        word_budget = max(4, math.ceil(target_seconds * _TARGET_WPS))
        return ". ".join(["Introducing a new feature"] * max(1, word_budget // 5)) + "."

    # Split on " → " delimiters written by _hint_for_segment.
    parts = [p.strip() for p in hint.split("→") if p.strip()]
    fragments = []
    for part in parts:
        # Strip "type: " prefix if present.
        label = re.sub(r"^\w+:\s*", "", part).strip()
        if not label:
            continue
        # Capitalise first letter, strip trailing punctuation, add period.
        label = label[0].upper() + label[1:].rstrip(".,;") + "."
        fragments.append(label)

    if not fragments:
        fragments = ["See it in action."]

    # Trim to word budget, keeping whole sentences.
    word_budget = max(4, math.ceil(target_seconds * _TARGET_WPS))
    result_parts: list[str] = []
    used = 0
    for frag in fragments:
        words = len(frag.split())
        if used + words > word_budget and result_parts:
            break
        result_parts.append(frag)
        used += words

    return " ".join(result_parts) if result_parts else fragments[0]


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


def build_skeleton(segments_doc: dict, *, draft: bool = False) -> dict:
    clips = []
    for i, seg in enumerate(segments_doc.get("segments") or []):
        moments = seg.get("moments") or []
        chapter = seg.get("chapter") or ""
        stem = _slug(chapter) if chapter else (moments[0].get("type") if moments else "beat")
        target = round(float(seg.get("duration", 0.0)), 3)
        hint = _hint_for_segment(moments)
        clips.append({
            "id": f"{i + 1:02d}_{stem}",
            "target_seconds": target,
            "chapter": chapter,
            "hint": hint,
            "text": _draft_text(hint, target) if draft else "",
        })
    return {"clips": clips}


def run(segments_path: Path, out: Path, *, overwrite: bool = False, draft: bool = False) -> dict:
    if out.exists() and not overwrite:
        existing = json.loads(out.read_text())
        # Merge: keep any non-empty `text` the user (or Claude) already wrote.
        segments_doc = json.loads(segments_path.read_text())
        skeleton = build_skeleton(segments_doc, draft=draft)
        text_by_id = {c["id"]: c.get("text", "") for c in existing.get("clips") or []}
        for c in skeleton["clips"]:
            if text_by_id.get(c["id"]):
                c["text"] = text_by_id[c["id"]]
        out.write_text(json.dumps(skeleton, indent=2) + "\n")
        return skeleton
    segments_doc = json.loads(segments_path.read_text())
    skeleton = build_skeleton(segments_doc, draft=draft)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(skeleton, indent=2) + "\n")
    return skeleton
