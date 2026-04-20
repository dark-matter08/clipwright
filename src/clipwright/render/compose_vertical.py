"""Filter-string builder for blurred-backdrop + centered-source composition."""
from __future__ import annotations


def compose_filter(
    *,
    start: float,
    duration: float,
    out_w: int = 1080,
    out_h: int = 1920,
    fade: float = 0.35,
    src_label: str = "[0:v]",
    out_label: str = "[vout]",
) -> str:
    """Compose the source video at out_w x out_h with a blurred, darkened copy behind it.

    Honors Hard Rule 4 equivalent for a single-input graph: a fresh PTS after trim so
    downstream overlays can anchor to t=0 of the composed stream.
    """
    bg_w = int(out_w * 1.12)
    bg_h = int(out_h * 1.12)
    fade_out_start = max(0.0, duration - fade)
    return (
        f"{src_label}trim=start={start}:duration={duration},setpts=PTS-STARTPTS,"
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
