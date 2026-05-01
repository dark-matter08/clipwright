"""Build annotations.json from segments.json.

Generates per-output-timeline annotation events for Remotion overlays.
Each annotation covers the window around one moment that has bbox data.

Output schema (annotations.json):

    {
      "viewport_w": 540,
      "viewport_h": 960,
      "events": [
        {
          "t_in":  0.40,       // output-timeline seconds, just before action
          "t_out": 1.10,       // output-timeline seconds, fade-out point
          "action_type": "click",
          "cx": 270.5,         // bbox center x in recording CSS pixels
          "cy": 400.0,         // bbox center y in recording CSS pixels
          "bw": 80.0,          // bbox width in recording CSS pixels
          "bh": 30.0,          // bbox height
          "label": "Tap here",
          "chapter": "intro"
        },
        ...
      ]
    }

Remotion components read `cx/cy/bw/bh` and divide by `viewport_w/viewport_h`
to get normalized coords, then multiply by the canvas size for final positions.

Annotation types emitted per action_type:
  click  → ClickRipple  (radial wave from centroid)
  hover  → ClickRipple  (softer, same component)
  type   → HighlightRing (animated stroke around input bbox)
"""
from __future__ import annotations

import json
from pathlib import Path

# Window constants (seconds).
_LEAD = 0.1   # annotation starts this many seconds before the moment
_TRAIL = 0.7  # annotation ends this many seconds after the moment


def _is_annotatable(action_type: str) -> bool:
    return action_type in {"click", "hover", "type"}


def build_annotations(
    segments: list[dict],
    *,
    viewport_w: int = 540,
    viewport_h: int = 960,
) -> dict:
    """Return the full annotations document from a parsed segments list."""
    events: list[dict] = []
    output_t = 0.0

    for seg in segments:
        src_start = float(seg["source_start"])
        dur = float(seg["duration"])
        seg_end = output_t + dur

        for m in seg.get("moments") or []:
            action_type = str(m.get("type", m.get("action", "")))
            if not _is_annotatable(action_type):
                continue

            bbox = m.get("bbox")
            if not bbox:
                continue  # no geometry → no overlay

            # Map source-timeline moment time to output-timeline.
            local = max(0.0, float(m["t"]) - src_start)
            t_moment = output_t + local

            t_in = max(output_t, t_moment - _LEAD)
            t_out = min(seg_end, t_moment + _TRAIL)
            if t_out <= t_in:
                continue

            cx = float(bbox["x"]) + float(bbox["w"]) / 2.0
            cy = float(bbox["y"]) + float(bbox["h"]) / 2.0

            events.append({
                "t_in": round(t_in, 3),
                "t_out": round(t_out, 3),
                "action_type": action_type,
                "cx": round(cx, 1),
                "cy": round(cy, 1),
                "bw": round(float(bbox["w"]), 1),
                "bh": round(float(bbox["h"]), 1),
                "label": str(m.get("label", "")),
                "chapter": str(m.get("chapter", "")),
            })

        output_t += dur

    return {
        "viewport_w": viewport_w,
        "viewport_h": viewport_h,
        "events": events,
    }


def run(
    segments_path: Path,
    out: Path,
    *,
    viewport_w: int = 540,
    viewport_h: int = 960,
) -> dict:
    doc = json.loads(segments_path.read_text())
    result = build_annotations(
        doc.get("segments") or [],
        viewport_w=viewport_w,
        viewport_h=viewport_h,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2) + "\n")
    return result
