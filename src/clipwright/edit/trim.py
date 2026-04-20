"""Dead-time trimming from a Playwright action log."""
from __future__ import annotations

import json
from pathlib import Path

from ..ffmpeg import probe_duration

Range = tuple[float, float]


def compute_ranges(
    moments: list[dict],
    video_duration: float,
    *,
    pre_roll: float = 0.5,
    post_roll: float = 1.0,
    merge_gap: float = 2.0,
    split_gap: float = 3.0,
) -> list[Range]:
    if not moments:
        return [(0.0, video_duration)]

    ts = sorted(float(m["t"]) for m in moments)

    # Each action defines a window [t - pre_roll, t + post_roll].
    windows: list[Range] = [(max(0.0, t - pre_roll), min(video_duration, t + post_roll)) for t in ts]

    merged: list[Range] = []
    for s, e in windows:
        if not merged:
            merged.append((s, e))
            continue
        ps, pe = merged[-1]
        if s - pe <= merge_gap:
            merged[-1] = (ps, max(pe, e))
        else:
            merged.append((s, e))

    out: list[Range] = []
    for s, e in merged:
        if e - s > split_gap * 2:
            cuts = int((e - s) // split_gap)
            step = (e - s) / max(1, cuts)
            cur = s
            for _ in range(cuts):
                nxt = min(e, cur + step)
                out.append((cur, nxt))
                cur = nxt
            if cur < e:
                out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


def trim(
    video: Path,
    moments: Path,
    out: Path,
    *,
    pre_roll: float = 0.5,
    post_roll: float = 1.0,
    merge_gap: float = 2.0,
    split_gap: float = 3.0,
) -> list[Range]:
    duration = probe_duration(video)
    data = json.loads(moments.read_text())
    ranges = compute_ranges(
        data,
        duration,
        pre_roll=pre_roll,
        post_roll=post_roll,
        merge_gap=merge_gap,
        split_gap=split_gap,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"video": str(video), "duration": duration, "ranges": [list(r) for r in ranges]},
            indent=2,
        )
    )
    return ranges
