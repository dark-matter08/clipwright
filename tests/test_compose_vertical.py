"""Sanity tests for the compose filter string."""
from __future__ import annotations

from clipwright.render.compose_vertical import audio_filter, compose_filter


def test_compose_filter_contains_required_ops():
    f = compose_filter(start=1.0, duration=8.0, out_w=1080, out_h=1920)
    for required in ("trim=start=1.0", "duration=8.0", "scale=1080", "boxblur", "overlay=(W-w)/2:(H-h)/2", "fade=t=in", "fade=t=out"):
        assert required in f, f"missing {required!r} in filter"


def test_compose_filter_emits_vout_label():
    f = compose_filter(start=0.0, duration=5.0)
    assert f.endswith("[vout]")


def test_audio_filter_has_30ms_fades():
    af = audio_filter(lead=0.4, duration=10.0)
    assert "afade=t=in:st=0:d=0.03" in af
    assert "afade=t=out:st=9.970:d=0.03" in af
    assert af.endswith("[aout]")


def test_audio_filter_adelay_uses_lead_ms():
    af = audio_filter(lead=0.25, duration=5.0)
    assert "adelay=250|250" in af
