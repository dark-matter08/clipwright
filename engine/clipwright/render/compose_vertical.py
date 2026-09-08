"""Filter-string builder for blurred-backdrop + centered-source composition."""
from __future__ import annotations


def compose_filter(
    *,
    start: float,
    duration: float,
    source_end: float | None = None,
    out_w: int = 1080,
    out_h: int = 1920,
    fade: float = 0.35,
    src_label: str = "[0:v]",
    out_label: str = "[vout]",
) -> str:
    """Compose the source video at out_w x out_h with a blurred, darkened copy behind it.

    When *source_end* is provided the trim respects the actual source range and
    applies a setpts speed factor so the output matches *duration* exactly.
    This enables proper slow-mo (source shorter than target) and speed-up
    (source longer than target) instead of grabbing frames past source_end.

    Honors Hard Rule 4 equivalent for a single-input graph: a fresh PTS after trim so
    downstream overlays can anchor to t=0 of the composed stream.
    """
    bg_w = int(out_w * 1.12)
    bg_h = int(out_h * 1.12)
    fade_out_start = max(0.0, duration - fade)

    if source_end is not None:
        src_dur = source_end - start
        if src_dur > 0 and abs(src_dur - duration) > 0.05:
            speed_factor = duration / src_dur
            trim_expr = f"trim=start={start}:end={source_end}"
            pts_expr = f"setpts=(PTS-STARTPTS)*{speed_factor:.6f}"
        else:
            trim_expr = f"trim=start={start}:end={source_end}"
            pts_expr = "setpts=PTS-STARTPTS"
    else:
        trim_expr = f"trim=start={start}:duration={duration}"
        pts_expr = "setpts=PTS-STARTPTS"

    return (
        f"{src_label}{trim_expr},{pts_expr},"
        f"scale={out_w}:-2,split[src][blurred];"
        f"[blurred]scale={bg_w}:{bg_h},crop={out_w}:{out_h},"
        f"boxblur=30:8,eq=brightness=-0.1:saturation=0.7[bg];"
        f"[src]scale={out_w}:-2[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2[comp];"
        f"[comp]fade=t=in:st=0:d={fade},"
        f"fade=t=out:st={fade_out_start:.3f}:d={fade}{out_label}"
    )


def audio_filter(
    *,
    lead: float,
    duration: float,
    src_label: str = "[1:a]",
    out_label: str = "[aout]",
    edge_fade: float = 0.03,
) -> str:
    """Pad audio with lead silence, fit total duration, 30ms fades per Hard Rule 3."""
    delay_ms = int(lead * 1000)
    fade_out_start = max(0.0, duration - edge_fade)
    return (
        f"{src_label}adelay={delay_ms}|{delay_ms},"
        f"apad=whole_dur={duration},atrim=duration={duration},"
        f"afade=t=in:st=0:d={edge_fade},"
        f"afade=t=out:st={fade_out_start:.3f}:d={edge_fade}{out_label}"
    )
