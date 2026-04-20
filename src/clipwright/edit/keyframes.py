"""Build camera keyframes on the OUTPUT timeline from segments.json.

All action types are flat 1.0 — no camera motion. Zooms were causing
jittery, disorienting footage in practice; even a conservative text-entry
zoom looked janky against the composed mobile frame. Keep camera flat
unless a future use case specifically justifies animation.

A "punch" lasts `hold` seconds around the moment: ramp in over `ramp`, hold
at peak, ramp out over `ramp`. Keyframes are emitted in output-timeline
seconds — start of output = 0 at the start of the first segment.

Output schema (camera.json):

    {
      "fps": 60,
      "total_duration": 12.480,
      "keyframes": [
        {"t": 0.000, "zoom": 1.0, "focus": [0.5, 0.5]},
        {"t": 2.300, "zoom": 1.5, "focus": [0.62, 0.41]},
        ...
      ]
    }

`focus` is a normalized (x, y) center-of-zoom. For now it's center (0.5, 0.5)
for every action — future work can read it from action.fields (e.g. the
clicked element's bounding box).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ZOOM_BY_TYPE = {
    "navigate": 1.0,
    "click": 1.0,
    "type": 1.0,
    "hover": 1.0,
    "scroll": 1.0,
    "wait": 1.0,
}


@dataclass
class Keyframe:
    t: float
    zoom: float
    focus: tuple[float, float] = (0.5, 0.5)

    def to_dict(self) -> dict[str, Any]:
        return {"t": round(self.t, 3), "zoom": round(self.zoom, 3), "focus": list(self.focus)}


@dataclass
class CameraPlan:
    fps: int
    total_duration: float
    keyframes: list[Keyframe] = field(default_factory=list)


def build_keyframes(
    segments: list[dict],
    *,
    fps: int = 60,
    ramp: float = 0.25,
    hold: float = 0.8,
) -> CameraPlan:
    kfs: list[Keyframe] = []
    output_t = 0.0  # running output-timeline offset at current segment start

    for seg in segments:
        src_start = float(seg["source_start"])
        dur = float(seg["duration"])
        # Start of segment anchors to zoom 1.0.
        kfs.append(Keyframe(t=output_t, zoom=1.0))

        for m in seg.get("moments") or []:
            peak = ZOOM_BY_TYPE.get(m["type"], 1.0)
            if peak == 1.0:
                continue
            # Map moment time (source) into output time.
            local = max(0.0, float(m["t"]) - src_start)
            center = output_t + local
            in_t = center - (hold / 2) - ramp
            peak_in = center - (hold / 2)
            peak_out = center + (hold / 2)
            out_t = center + (hold / 2) + ramp

            # Clamp against segment bounds.
            seg_end_out = output_t + dur
            in_t = max(output_t, in_t)
            out_t = min(seg_end_out, out_t)
            peak_in = max(in_t, peak_in)
            peak_out = min(out_t, peak_out)

            kfs.append(Keyframe(t=in_t, zoom=1.0))
            kfs.append(Keyframe(t=peak_in, zoom=peak))
            kfs.append(Keyframe(t=peak_out, zoom=peak))
            kfs.append(Keyframe(t=out_t, zoom=1.0))

        output_t += dur
        kfs.append(Keyframe(t=output_t, zoom=1.0))

    # Collapse keyframes at identical timestamps (keep the last).
    dedup: dict[float, Keyframe] = {}
    for k in kfs:
        dedup[round(k.t, 4)] = k
    kfs_sorted = sorted(dedup.values(), key=lambda k: k.t)

    return CameraPlan(fps=fps, total_duration=output_t, keyframes=kfs_sorted)


def run(segments_path: Path, out: Path, *, fps: int = 60) -> CameraPlan:
    data = json.loads(segments_path.read_text())
    plan = build_keyframes(data.get("segments") or [], fps=fps)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(
        {
            "fps": plan.fps,
            "total_duration": round(plan.total_duration, 3),
            "keyframes": [k.to_dict() for k in plan.keyframes],
        },
        indent=2,
    ))
    return plan
