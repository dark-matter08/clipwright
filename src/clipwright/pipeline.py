"""Pipeline orchestrator — callable library that CLI and future GUI both consume.

The Pipeline class drives every stage and emits typed events via an optional
``on_event`` callback. The CLI renders these events as Rich output; a future
desktop GUI can render them as native UI elements without shelling out.

Usage (library)::

    from clipwright.pipeline import Pipeline, Event

    def on_event(ev: Event) -> None:
        print(ev)

    p = Pipeline.from_dir("/path/to/project", on_event=on_event)
    p.build(confirm_tts=True)

Usage (CLI): see cli.py ``build`` and ``status`` commands.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config as config_mod
from .errors import ClipwrightError

# ---------------------------------------------------------------------------
# Events (consumed by CLI/GUI)
# ---------------------------------------------------------------------------

@dataclass
class StageStarted:
    stage: str


@dataclass
class StageCompleted:
    stage: str
    detail: str = ""


@dataclass
class StageSkipped:
    stage: str
    reason: str = "already up-to-date"


@dataclass
class StageFailed:
    stage: str
    error: ClipwrightError


@dataclass
class ConfirmRequested:
    prompt: str
    detail: str = ""


Event = StageStarted | StageCompleted | StageSkipped | StageFailed | ConfirmRequested

OnEvent = Callable[[Event], None]


def _noop(_: Event) -> None:
    pass


# ---------------------------------------------------------------------------
# Pipeline state (which artifacts exist and are non-empty)
# ---------------------------------------------------------------------------

@dataclass
class ArtifactState:
    name: str
    path: Path
    exists: bool
    stale: bool = False


@dataclass
class PipelineState:
    root: Path
    artifacts: list[ArtifactState] = field(default_factory=list)

    def is_ready(self, name: str) -> bool:
        for a in self.artifacts:
            if a.name == name:
                return a.exists and not a.stale
        return False


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class Pipeline:
    def __init__(
        self,
        root: Path,
        cfg: config_mod.ProjectConfig,
        *,
        on_event: OnEvent = _noop,
    ) -> None:
        self.root = root
        self.cfg = cfg
        self.out_dir = cfg.resolve_out(root)
        self.on_event = on_event

    @classmethod
    def from_dir(
        cls,
        directory: str | Path,
        *,
        on_event: OnEvent = _noop,
    ) -> Pipeline:
        root = Path(directory).resolve()
        cfg = config_mod.load(root)
        return cls(root, cfg, on_event=on_event)

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def status(self) -> PipelineState:
        od = self.out_dir
        checks: list[tuple[str, Path]] = [
            ("video", od / "video.mp4"),
            ("moments", od / "moments.json"),
            ("segments", od / "segments.json"),
            ("camera", od / "camera.json"),
            ("annotations", od / "annotations.json"),
            ("brand", od / "brand"),
            ("script", self.root / self.cfg.voice_script),
            ("audio", od / "audio"),
            ("captions", od / "subs"),
            ("outro", od / "outro.mp4"),
            ("final", od / "final.mp4"),
        ]
        artifacts = []
        for name, path in checks:
            exists = path.exists() and (path.stat().st_size > 0 if path.is_file() else any(path.iterdir()))
            artifacts.append(ArtifactState(name=name, path=path, exists=exists))
        return PipelineState(root=self.root, artifacts=artifacts)

    # ------------------------------------------------------------------
    # Individual stages (callable without the orchestrator)
    # ------------------------------------------------------------------

    def run_segments(self) -> int:
        from .edit import segments as segments_mod
        od = self.out_dir
        moments_path = od / "moments.json"
        video_path = od / "video.mp4"
        if not moments_path.exists():
            raise ClipwrightError(
                "moments.json not found",
                fix="clipwright record --plan browse-plan.json",
                docs="docs/troubleshooting.md#missing-moments",
            )
        segs = segments_mod.run(
            video_path,
            moments_path,
            od / "segments.json",
            lead=self.cfg.pre_roll,
            trail=self.cfg.post_roll,
            merge_gap=self.cfg.merge_gap,
            split_gap=self.cfg.split_gap,
        )
        return len(segs)

    def run_keyframes(self) -> int:
        from .edit import keyframes as keyframes_mod
        od = self.out_dir
        segs_path = od / "segments.json"
        if not segs_path.exists():
            raise ClipwrightError(
                "segments.json not found",
                fix="clipwright segments",
                docs="docs/troubleshooting.md#missing-segments",
            )
        plan = keyframes_mod.run(segs_path, od / "camera.json", fps=self.cfg.fps)
        return len(plan.keyframes)

    def run_generate(
        self,
        slot: str,
        provider: str,
        prompt: str,
        *,
        duration: float = 3.0,
        fallback: bool = False,
    ) -> dict:
        from .generate.base import GenerateRequest, get_provider
        gen_dir = self.out_dir / "generated"
        gen_dir.mkdir(parents=True, exist_ok=True)
        suffix = ".mp4" if slot in ("intro", "outro") or slot.startswith("broll") else ".png"
        out_path = gen_dir / f"{slot}{suffix}"
        brand_dir = self.out_dir / "brand"
        image_refs = [brand_dir / n for n in ("hero.png", "logo.png") if (brand_dir / n).exists()]
        prov = get_provider(provider)
        if fallback:
            try:
                prov.validate_env()
            except Exception:  # noqa: BLE001
                return {"slot": slot, "cached": False, "fallback": True}
        request = GenerateRequest(
            slot=slot,
            prompt=prompt,
            image_refs=image_refs,
            duration=duration,
            width=self.cfg.resolution[0],
            height=self.cfg.resolution[1],
        )
        try:
            result = prov.generate(request, out_path)
            return {"slot": slot, "path": str(result.path), "cached": result.cached, "fallback": False}
        except Exception as exc:
            if fallback:
                return {"slot": slot, "cached": False, "fallback": True, "reason": str(exc)}
            raise

    def run_inspire(self, url: str) -> dict:
        from .inspire.extractor import extract
        brand_dir = self.out_dir / "brand"
        return extract(url, brand_dir)

    def run_annotations(self) -> int:
        from .edit import annotations as annotations_mod
        od = self.out_dir
        segs_path = od / "segments.json"
        if not segs_path.exists():
            raise ClipwrightError(
                "segments.json not found",
                fix="clipwright segments",
                docs="docs/troubleshooting.md#missing-segments",
            )
        result = annotations_mod.run(segs_path, od / "annotations.json")
        return len(result.get("events", []))

    def run_script_init(self, *, overwrite: bool = False, draft: bool = False) -> dict[str, Any]:
        from .plan import script_skeleton
        od = self.out_dir
        segs_path = od / "segments.json"
        if not segs_path.exists():
            raise ClipwrightError(
                "segments.json not found",
                fix="clipwright segments",
                docs="docs/troubleshooting.md#missing-segments",
            )
        script_path = (self.root / self.cfg.voice_script).resolve()
        skeleton = script_skeleton.run(segs_path, script_path, overwrite=overwrite, draft=draft)
        return skeleton

    def run_tts(
        self,
        *,
        provider: str | None = None,
        force: bool = False,
    ) -> tuple[int, int]:
        """Returns (synthesized, cached) clip counts."""
        import hashlib

        from .ffmpeg import probe_duration, stretch_audio
        from .tts import get_provider

        provider_name = provider or self.cfg.tts_provider
        tts_provider = get_provider(provider_name)
        od = self.out_dir
        audio_dir = od / "audio"
        audio_dir.mkdir(exist_ok=True)
        script_path = (self.root / self.cfg.voice_script).resolve()
        if not script_path.exists():
            raise ClipwrightError(
                "script.json not found",
                fix="clipwright script init",
                docs="docs/troubleshooting.md#missing-script",
            )
        data = json.loads(script_path.read_text())

        def _hash(*parts: str) -> str:
            return hashlib.sha256("\0".join(parts).encode()).hexdigest()

        def _read_cache(p: Path) -> str | None:
            try:
                return json.loads(p.read_text()).get("hash")
            except Exception:
                return None

        synthesized = cached = 0
        for clip in data["clips"]:
            cid = clip["id"]
            if not clip.get("text"):
                continue
            voice = clip.get("voice") or clip.get("voice_id") or (self.cfg.voice_id or None)
            target = clip.get("target_seconds")
            mp3 = audio_dir / f"{cid}.mp3"
            ts = audio_dir / f"{cid}.timestamps.json"
            cache_file = audio_dir / f"{cid}.cache.json"
            clip_hash = _hash(clip["text"], voice or "", provider_name, str(target or ""))

            if not force and mp3.exists() and ts.exists() and _read_cache(cache_file) == clip_hash:
                cached += 1
                continue

            tts_provider.synthesize(clip["text"], out_mp3=mp3, out_timestamps=ts, voice=voice)

            if target:
                cur = probe_duration(mp3)
                if cur > float(target) * 1.03:
                    stretched = audio_dir / f"{cid}.stretched.mp3"
                    ratio = stretch_audio(mp3, stretched, float(target))
                    stretched.replace(mp3)
                    align = json.loads(ts.read_text())
                    for key in ("character_start_times_seconds", "character_end_times_seconds"):
                        if key in align:
                            align[key] = [round(t / ratio, 4) for t in align[key]]
                    ts.write_text(json.dumps(align))

            cache_file.write_text(json.dumps({"hash": clip_hash}))
            synthesized += 1

        return synthesized, cached

    def run_caption(self, *, style_path: Path | None = None, force: bool = False) -> int:
        import hashlib

        from .captions.chunker import chars_to_words, chunk_words
        from .captions.png_renderer import CaptionStyle, render_all

        od = self.out_dir
        audio_dir = od / "audio"
        subs_dir = od / "subs"
        subs_dir.mkdir(exist_ok=True)
        style = (
            CaptionStyle.from_json(style_path)
            if style_path
            else CaptionStyle(width=self.cfg.resolution[0], height=self.cfg.resolution[1])
        )
        style_key = style_path.read_text() if style_path else f"{self.cfg.resolution[0]}x{self.cfg.resolution[1]}"

        def _hash(*parts: str) -> str:
            return hashlib.sha256("\0".join(parts).encode()).hexdigest()

        def _read_cache(p: Path) -> str | None:
            try:
                return json.loads(p.read_text()).get("hash")
            except Exception:
                return None

        total_chunks = 0
        for ts_path in sorted(audio_dir.glob("*.timestamps.json")):
            cid = ts_path.name.removesuffix(".timestamps.json")
            ts_content = ts_path.read_text()
            cap_hash = _hash(ts_content, style_key)
            cache_file = subs_dir / f"{cid}.cache.json"
            png_dir = subs_dir / cid
            align = json.loads(ts_content)
            chunks = chunk_words(chars_to_words(align), n=2, upper=True)
            if not force and png_dir.exists() and _read_cache(cache_file) == cap_hash:
                total_chunks += len(chunks)
                continue
            render_all(chunks, style, png_dir)
            cache_file.write_text(json.dumps({"hash": cap_hash}))
            total_chunks += len(chunks)
        return total_chunks

    def run_outro(self, *, preset: str | None = None, brand_path: Path | None = None) -> Path:
        from .ffmpeg import require
        from .outro.brand import BrandConfig
        from .outro.render import render_outro

        require()
        preset = preset or self.cfg.outro_preset
        od = self.out_dir
        if brand_path:
            brand = BrandConfig.from_json(brand_path)
        else:
            tmpl = Path(__file__).resolve().parent.parent.parent / "templates" / "outros" / f"{preset}.json"
            brand = BrandConfig.from_json(tmpl) if tmpl.exists() else BrandConfig()
        brand.width, brand.height = self.cfg.resolution
        brand.fps = self.cfg.fps
        out_path = od / "outro.mp4"
        render_outro(brand, out_path)
        return out_path

    def run_render(
        self,
        *,
        backend: str = "ffmpeg",
        no_captions: bool = False,
        no_outro: bool = False,
    ) -> Path:
        from .ffmpeg import require
        require()
        od = self.out_dir
        out_final = od / "final.mp4"
        if backend == "remotion":
            self._render_remotion(od, out_final, no_outro=no_outro)
        else:
            self._render_ffmpeg(od, out_final, no_captions=no_captions, no_outro=no_outro)
        return out_final

    def _render_ffmpeg(
        self,
        od: Path,
        out_final: Path,
        *,
        no_captions: bool,
        no_outro: bool,
    ) -> None:
        import json as _json

        from .ffmpeg import probe_duration
        from .render.composer import Segment, SubtitleChunk, render

        edl_path = od / "edl.json"
        if not edl_path.exists():
            raise ClipwrightError(
                "edl.json not found — ffmpeg backend requires edl.json",
                fix="clipwright trim  (legacy) or use --backend remotion",
                docs="docs/troubleshooting.md#missing-edl",
            )
        edl = _json.loads(edl_path.read_text())
        source = Path(edl["video"])
        audio_dir = od / "audio"
        subs_dir = od / "subs"
        per_clip_audio = sorted(audio_dir.glob("*.mp3"))
        ranges = edl["ranges"]

        if len(per_clip_audio) != len(ranges) and per_clip_audio:
            raise ClipwrightError(
                f"{len(per_clip_audio)} audio clips vs {len(ranges)} ranges — counts differ",
                fix="Create beat_map.json mapping clip_id -> range index",
                docs="docs/troubleshooting.md#beat-map",
            )

        audio_by_range = {i: a for i, a in enumerate(per_clip_audio)}
        segments_list: list[Segment] = []
        subtitles: list[list[SubtitleChunk]] = []
        for i, (s, e) in enumerate(ranges):
            audio = audio_by_range.get(i)
            if audio is not None:
                dur = probe_duration(audio)
                lead, tail = self.cfg.lead, self.cfg.tail
            else:
                dur = float(e) - float(s)
                lead = tail = 0.0
            segments_list.append(Segment(start=float(s), duration=dur, audio=audio, lead=lead, tail=tail))
            chunks_here: list[SubtitleChunk] = []
            if not no_captions and audio is not None:
                cid = audio.stem
                index_json = subs_dir / f"{cid}.json"
                png_dir = subs_dir / cid
                if index_json.exists() and png_dir.exists():
                    for j, ch in enumerate(_json.loads(index_json.read_text())):
                        png = png_dir / f"{j:03d}.png"
                        chunks_here.append(SubtitleChunk(
                            start=ch["start"] + lead,
                            end=ch["end"] + lead,
                            png=png,
                        ))
            subtitles.append(chunks_here)

        outro_path = od / "outro.mp4"
        outro_final = outro_path if (not no_outro and outro_path.exists()) else None
        render(
            source=source,
            segments=segments_list,
            work_dir=od / "work",
            out=out_final,
            resolution=self.cfg.resolution,
            fps=self.cfg.fps,
            subtitles_per_segment=subtitles,
            outro=outro_final,
        )

    def _render_remotion(self, od: Path, out_final: Path, *, no_outro: bool) -> None:
        from .ffmpeg import probe_duration
        from .render import remotion_backend

        segs_path = od / "segments.json"
        cam_path = od / "camera.json"
        if not segs_path.exists() or not cam_path.exists():
            raise ClipwrightError(
                "remotion backend requires segments.json and camera.json",
                fix="clipwright segments && clipwright keyframes",
                docs="docs/troubleshooting.md#missing-segments",
            )
        segs_doc = json.loads(segs_path.read_text())
        source = Path(segs_doc["video"])
        outro_path = od / "outro.mp4"
        outro_final = outro_path if (not no_outro and outro_path.exists()) else None
        outro_dur = probe_duration(outro_final) if outro_final else 0.0
        remotion_backend.render(
            out_dir=od,
            source_video=source,
            fps=self.cfg.fps,
            width=self.cfg.resolution[0],
            height=self.cfg.resolution[1],
            outro=outro_final,
            outro_duration=outro_dur,
            out=out_final,
        )

    # ------------------------------------------------------------------
    # Orchestrator
    # ------------------------------------------------------------------

    def build(
        self,
        *,
        provider: str | None = None,
        backend: str = "remotion",
        force_tts: bool = False,
        force_captions: bool = False,
        no_outro: bool = False,
        no_captions: bool = False,
        confirm_tts: Callable[[], bool] | None = None,
    ) -> Path:
        """Run all pipeline stages in order, skipping stages whose outputs are current.

        ``confirm_tts`` is called before TTS synthesis (after script init). If
        it returns False, the build stops. The CLI passes a Rich-based prompt;
        the GUI passes a native dialog callback.
        """
        ev = self.on_event
        od = self.out_dir

        def _stage(name: str, fn: Callable[[], Any], detail_fn: Callable[[Any], str] | None = None) -> Any:
            ev(StageStarted(name))
            try:
                result = fn()
                detail = detail_fn(result) if detail_fn else ""
                ev(StageCompleted(name, detail))
                return result
            except ClipwrightError as exc:
                ev(StageFailed(name, exc))
                raise

        # segments
        if not (od / "segments.json").exists():
            _stage("segments", self.run_segments, lambda n: f"{n} segments")
        else:
            ev(StageSkipped("segments"))

        # keyframes
        if not (od / "camera.json").exists():
            _stage("keyframes", self.run_keyframes, lambda n: f"{n} keyframes")
        else:
            ev(StageSkipped("keyframes"))

        # annotations (best-effort — may produce 0 events if no bbox data yet)
        if not (od / "annotations.json").exists():
            _stage("annotations", self.run_annotations, lambda n: f"{n} annotation event(s)")
        else:
            ev(StageSkipped("annotations"))

        # script init
        script_path = (self.root / self.cfg.voice_script).resolve()
        if not script_path.exists():
            _stage("script", lambda: self.run_script_init(draft=True), lambda _: "skeleton written")
        else:
            script_data = json.loads(script_path.read_text())
            missing = [c["id"] for c in script_data.get("clips", []) if not c.get("text")]
            if missing:
                ev(StageSkipped("script", reason=f"exists but {len(missing)} clip(s) have no text"))
            else:
                ev(StageSkipped("script"))

        # TTS — always gated by confirm_tts
        script_data = json.loads(script_path.read_text()) if script_path.exists() else {"clips": []}
        clips_with_text = [c for c in script_data.get("clips", []) if c.get("text")]
        if clips_with_text:
            if confirm_tts is not None and not confirm_tts():
                ev(StageSkipped("tts", reason="cancelled by user"))
                return od / "final.mp4"

            def _do_tts() -> tuple[int, int]:
                return self.run_tts(provider=provider, force=force_tts)

            _stage("tts", _do_tts, lambda r: f"{r[0]} synthesized, {r[1]} cached")
        else:
            ev(StageSkipped("tts", reason="no clips with text"))

        # captions
        _stage("caption", lambda: self.run_caption(force=force_captions), lambda n: f"{n} chunks")

        # outro
        if not (od / "outro.mp4").exists() and not no_outro:
            _stage("outro", self.run_outro)
        else:
            ev(StageSkipped("outro"))

        # render
        out = _stage(
            "render",
            lambda: self.run_render(backend=backend, no_captions=no_captions, no_outro=no_outro),
        )
        return out or od / "final.mp4"
