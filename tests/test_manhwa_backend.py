"""Tests for the manhwa-recap Remotion backend builder.

We don't shell out to `npx remotion render` in unit tests — that needs
Node + ffmpeg + ~30s per fixture. Instead we exercise `build_inputs`
which is the meaty part (manifest → props JSON, asset staging, caption
synthesis) and stub the actual subprocess at the `render` boundary.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from clipwright.render import manhwa_backend


def _seed_manhwa_project(d: Path, *, n_segments: int = 3, theme: str | None = None) -> None:
    """Lay down a v2 project shell that mimics a real manhwa-recap-single
    setup: per-segment panels, audio, timestamps, optional camera files,
    optional script."""
    payload = {
        "schema_version": 2, "title": "Recap", "aspect": "9:16", "fps": 30,
        "render_backend": "remotion", "tts_provider": "kokoro",
        "template_id": "manhwa-recap-single",
    }
    (d / "project.json").write_text(json.dumps(payload))
    (d / "videos").mkdir()
    (d / "sources" / "panels" / "chapter-1").mkdir(parents=True)
    (d / "voiceover" / "audio" / "chapter-1").mkdir(parents=True)
    (d / "voiceover" / "scripts").mkdir(parents=True)
    (d / "camera").mkdir()

    segments = []
    clips = []
    for i in range(n_segments):
        seg_id = f"seg_{i+1:03d}"
        clip_id = f"clip_{seg_id}"
        panel_path = d / "sources" / "panels" / "chapter-1" / f"p{i+1:02d}.webp"
        panel_path.write_bytes(b"\x00")  # fake-but-present
        audio_path = d / "voiceover" / "audio" / "chapter-1" / f"{seg_id}.mp3"
        audio_path.write_bytes(b"\x00")
        # Word-level timestamps so caption synthesis exercises the chunk path.
        ts_path = d / "voiceover" / "audio" / "chapter-1" / f"{seg_id}.timestamps.json"
        ts_path.write_text(json.dumps({
            "words": [
                {"word": "word", "start": j * 0.4, "end": (j + 1) * 0.4}
                for j in range(6)
            ],
        }))
        # Camera keyframes — new pan_x/pan_y shape.
        cam_path = d / "camera" / f"{seg_id}.json"
        cam_path.write_text(json.dumps({
            "keyframes": [
                {"t": 0.0, "zoom": 1.0, "pan_x": 0.0, "pan_y": 0.0},
                {"t": 5.0, "zoom": 1.15, "pan_x": 0.0, "pan_y": 0.2},
            ],
        }))
        segments.append({
            "id": seg_id,
            "source": f"sources/panels/chapter-1/p{i+1:02d}.webp",
            "source_start": 0.0,
            "source_end": 5.0,
            "target_duration": 5.0,
            "kind": "scene",
            "scene_type": "panel",
            "label": f"Panel {i+1}",
            "chapter": ["opening", "protagonist", "hook"][i % 3],
            "voiceover": {"enabled": True, "script_clip_id": clip_id},
            "captions": {"enabled": True, "ref": f"captions/index.json#{seg_id}"},
            # Camera is loaded directly from <project>/camera/<seg>.json by
            # the manhwa backend — the segment ref isn't read for the
            # render path, just needs to be schema-valid.
            "camera": {"enabled": True, "ref": f"camera/index.json#{seg_id}"},
            "annotations": {"enabled": False, "ref": ""},
        })
        clips.append({"id": clip_id, "text": f"Sample voiceover {i+1}.",
                      "target_seconds": 5.0})

    (d / "videos" / "chapter-1.json").write_text(json.dumps({
        "schema_version": 2, "video_id": "chapter-1", "title": "Chapter 1",
        "chat_session_id": "", "segments": segments,
    }))
    (d / "voiceover" / "scripts" / "chapter-1.json").write_text(
        json.dumps({"clips": clips})
    )


@pytest.fixture
def staged_cleanup():
    """Make sure each test cleans the remotion/public/_manhwa/<id>/ dir
    we wrote into. Without this we'd pile up test-fixture residue in
    the real Remotion project across runs."""
    yield
    stage = manhwa_backend.REMOTION_DIR / "public" / "_manhwa"
    if stage.exists():
        for child in stage.iterdir():
            if child.name.startswith("chapter-"):
                shutil.rmtree(child, ignore_errors=True)


def test_build_inputs_produces_one_seg_input_per_manifest_segment(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    _seed_manhwa_project(tmp_path, n_segments=3)
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
    )
    assert inputs["fps"] == 30
    assert inputs["width"] == 1080
    assert inputs["theme"] == "dark-fantasy"
    assert len(inputs["segments"]) == 3
    assert [s["id"] for s in inputs["segments"]] == ["seg_001", "seg_002", "seg_003"]


def test_build_inputs_stages_assets_under_remotion_public(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    _seed_manhwa_project(tmp_path, n_segments=2)
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
    )
    seg = inputs["segments"][0]
    # Source + audio paths are now relative-to-public keys, not the
    # original project-relative paths.
    assert seg["source"].startswith("_manhwa/chapter-1/panels/")
    assert seg["audio_path"].startswith("_manhwa/chapter-1/audio/")
    # And those staged files actually exist on disk under the Remotion
    # project's public/ tree.
    staged_panel = manhwa_backend.REMOTION_DIR / "public" / seg["source"]
    assert staged_panel.exists()


def test_build_inputs_synthesizes_captions_from_timestamps(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    _seed_manhwa_project(tmp_path, n_segments=1)
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
    )
    captions = inputs["segments"][0]["captions"]
    # 6 words chunked in groups of 2 → 3 caption events. Matches the
    # reference TikTok 2-word burst style; the prior 5-word chunks were
    # line-wrapping and clipping the 9:16 canvas edges.
    assert len(captions) == 3
    assert captions[0]["text"]
    assert captions[0]["start"] < captions[0]["end"]
    # Each chunk should be exactly 2 words.
    for c in captions:
        assert len(c["text"].split()) == 2, f"expected 2-word chunk, got {c['text']!r}"


def test_build_inputs_carries_camera_keyframes(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    _seed_manhwa_project(tmp_path, n_segments=1)
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
    )
    cam = inputs["segments"][0]["camera"]
    assert len(cam) == 2
    assert cam[0]["zoom"] == 1.0
    assert cam[1]["pan_y"] == pytest.approx(0.2)


def test_build_inputs_translates_legacy_focus_keyframes(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    """Legacy camera files used `focus: [x, y]` — backend translates."""
    _seed_manhwa_project(tmp_path, n_segments=1)
    cam_path = tmp_path / "camera" / "seg_001.json"
    cam_path.write_text(json.dumps({
        "keyframes": [
            {"t": 0.0, "zoom": 1.0, "focus": [0.5, 0.5]},
            {"t": 5.0, "zoom": 1.2, "focus": [0.5, 0.8]},
        ],
    }))
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
    )
    cam = inputs["segments"][0]["camera"]
    # focus[1]=0.8 → pan_y = (0.5 - 0.8) * 0.5 = -0.15
    assert cam[1]["pan_y"] == pytest.approx(-0.15)


def test_build_inputs_errors_when_segment_source_missing(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    _seed_manhwa_project(tmp_path, n_segments=1)
    # Remove the panel file so the staging step trips.
    (tmp_path / "sources" / "panels" / "chapter-1" / "p01.webp").unlink()
    with pytest.raises(manhwa_backend.ManhwaRenderError, match="doesn't exist"):
        manhwa_backend.build_inputs(
            project_dir=tmp_path, video_id="chapter-1",
            fps=30, width=1080, height=1920,
        )


def test_build_inputs_errors_on_zero_segments(
    tmp_path: Path, staged_cleanup: None,
) -> None:
    _seed_manhwa_project(tmp_path, n_segments=0)
    with pytest.raises(manhwa_backend.ManhwaRenderError, match="zero segments"):
        manhwa_backend.build_inputs(
            project_dir=tmp_path, video_id="chapter-1",
            fps=30, width=1080, height=1920,
        )


def test_theme_default_for_manhwa(tmp_path: Path, staged_cleanup: None) -> None:
    _seed_manhwa_project(tmp_path, n_segments=1)
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
    )
    assert inputs["theme"] == "dark-fantasy"


def test_theme_override_wins(tmp_path: Path, staged_cleanup: None) -> None:
    _seed_manhwa_project(tmp_path, n_segments=1)
    inputs = manhwa_backend.build_inputs(
        project_dir=tmp_path, video_id="chapter-1",
        fps=30, width=1080, height=1920,
        theme_override="cyberpunk",
    )
    assert inputs["theme"] == "cyberpunk"


def test_render_final_dispatches_to_manhwa_for_template(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, staged_cleanup: None,
) -> None:
    """`clipwright render-final` should route to the Remotion manhwa
    backend when the project is bound to a manhwa template, rather than
    falling through to the per-segment ffmpeg concat path."""
    from clipwright import render_final as rf

    _seed_manhwa_project(tmp_path, n_segments=2)

    calls: list[tuple[Path, str]] = []

    def fake_render(*, project_dir: Path, video_id: str, out: Path, **kwargs):
        calls.append((project_dir, video_id))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fake-mp4")
        return out

    monkeypatch.setattr(manhwa_backend, "render", fake_render)
    result = rf.render_final(tmp_path, video_id="chapter-1")
    assert calls == [(tmp_path.resolve(), "chapter-1")]
    assert result.out_path.exists()
    assert result.n_segments == 2
