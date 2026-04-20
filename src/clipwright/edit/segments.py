"""Build Segments from moments.json.

Rules (from the 11-step process):
  - Each moment defines a window [t − lead, t + trail] where lead=500ms, trail=1000ms.
  - Consecutive windows are merged when the gap between them is < merge_gap (2s default).
  - Long merged windows are split when a *gap inside* is ≥ split_gap (3s default).
  - +1s tail is added after the final window.
  - Windows are clamped to [0, video_duration].

A Segment carries `source_start`, `source_end`, and the list of moments it
contains. This replaces the anonymous (start, end) tuple EDL — downstream code
can now pick camera zoom per moment type.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..ffmpeg import probe_duration


@dataclass
class SegmentMoment:
    t: float
    type: str
    label: str = ""
    fields: dict[str, Any] = field(default_factory=dict)
    chapter: str = ""
    wait: float = 0.0


@dataclass
class Segment:
    source_start: float
    source_end: float
    moments: list[SegmentMoment]
    chapter: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, self.source_end - self.source_start)


def build_segments(
    moments: list[dict],
    video_duration: float,
    *,
    lead: float = 0.8,
    trail: float = 2.0,
    merge_gap: float = 5.0,
    split_gap: float = 15.0,
    final_tail: float = 1.0,
) -> list[Segment]:
    if not moments:
        return [Segment(source_start=0.0, source_end=video_duration, moments=[])]

    items = [
        SegmentMoment(
            t=float(m["t"]),
            type=str(m.get("action", "unknown")),
            label=str(m.get("label", "")),
            fields=dict(m.get("fields", {})),
            chapter=str(m.get("chapter", "")),
            wait=float(m.get("wait", 0.0)),
        )
        for m in moments
    ]
    items.sort(key=lambda m: m.t)

    # Chapter-first grouping: if every moment declares a chapter, build one
    # segment per contiguous run of same-chapter moments. This overrides the
    # timing heuristics — author intent wins over gap math.
    if items and all(m.chapter for m in items):
        runs: list[list[SegmentMoment]] = []
        for m in items:
            if runs and runs[-1][-1].chapter == m.chapter:
                runs[-1].append(m)
            else:
                runs.append([m])
        segs: list[Segment] = []
        for run in runs:
            # Mark time is logged AFTER the action's own dwell (`wait`).
            # For the first moment in a chapter, back off far enough to show
            # the action happening, not just its aftermath. For the last
            # moment, give a generous trail so async UI settles on-camera.
            first_lead = max(lead, run[0].wait + 0.4)
            last_trail = max(trail, run[-1].wait * 0.5 + 2.5)
            s = max(0.0, run[0].t - first_lead)
            e = min(video_duration, run[-1].t + last_trail)
            segs.append(Segment(source_start=s, source_end=e, moments=run, chapter=run[0].chapter))
        if segs:
            segs[-1] = Segment(
                source_start=segs[-1].source_start,
                source_end=min(video_duration, segs[-1].source_end + final_tail),
                moments=segs[-1].moments,
                chapter=segs[-1].chapter,
            )
        return segs

    # 1. Build window per moment, attach moment to it.
    windows: list[tuple[float, float, list[SegmentMoment]]] = []
    for mi in items:
        s = max(0.0, mi.t - lead)
        e = min(video_duration, mi.t + trail)
        windows.append((s, e, [mi]))

    # 2. Merge when gap < merge_gap.
    merged: list[tuple[float, float, list[SegmentMoment]]] = []
    for s, e, ms in windows:
        if not merged:
            merged.append((s, e, list(ms)))
            continue
        ps, pe, pms = merged[-1]
        if s - pe < merge_gap:
            merged[-1] = (ps, max(pe, e), pms + ms)
        else:
            merged.append((s, e, list(ms)))

    # 3. Split a merged window when the gap between two consecutive internal
    # moments is >= split_gap.
    split: list[tuple[float, float, list[SegmentMoment]]] = []
    for s, e, ms in merged:
        if len(ms) < 2:
            split.append((s, e, ms))
            continue
        cur_start = s
        cur_moments: list[SegmentMoment] = [ms[0]]
        for prev, nxt in zip(ms, ms[1:], strict=False):
            if nxt.t - prev.t >= split_gap:
                # close current window at prev + trail
                cur_end = min(video_duration, prev.t + trail)
                split.append((cur_start, cur_end, cur_moments))
                cur_start = max(0.0, nxt.t - lead)
                cur_moments = [nxt]
            else:
                cur_moments.append(nxt)
        cur_end = e  # last window keeps its original end
        split.append((cur_start, cur_end, cur_moments))

    # 4. +1s tail on the last segment only.
    if split:
        s, e, ms = split[-1]
        split[-1] = (s, min(video_duration, e + final_tail), ms)

    return [Segment(source_start=s, source_end=e, moments=ms) for s, e, ms in split]


def segments_to_json(segments: list[Segment], video: Path, video_duration: float) -> dict:
    return {
        "video": str(video),
        "duration": video_duration,
        "segments": [
            {
                "source_start": round(seg.source_start, 3),
                "source_end": round(seg.source_end, 3),
                "duration": round(seg.duration, 3),
                "chapter": seg.chapter,
                "moments": [asdict(m) for m in seg.moments],
            }
            for seg in segments
        ],
    }


def run(
    video: Path,
    moments_path: Path,
    out: Path,
    *,
    lead: float = 0.8,
    trail: float = 2.0,
    merge_gap: float = 5.0,
    split_gap: float = 15.0,
    final_tail: float = 1.0,
) -> list[Segment]:
    duration = probe_duration(video)
    moments = json.loads(moments_path.read_text())
    segments = build_segments(
        moments, duration,
        lead=lead, trail=trail,
        merge_gap=merge_gap, split_gap=split_gap,
        final_tail=final_tail,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(segments_to_json(segments, video, duration), indent=2))
    return segments
