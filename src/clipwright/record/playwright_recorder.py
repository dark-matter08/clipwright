"""Drive a Playwright Chromium session through a user script, emit video + moments.

Moments are produced by explicit `mark()` calls from the user script — no trace.zip
parsing. User scripts receive `(page, mark)` where `mark` is a callable:

    await mark("click", selector="#cta")
    await mark("scroll", y=640)
    await mark("nav", url=page.url)

Auto-marks: page.goto(url) is wrapped to emit a "nav" moment. Everything else is
explicit — keeps the contract obvious and the output stable across Playwright
versions.
"""
from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..ffmpeg import VCODEC, run


@dataclass
class Moment:
    t: float
    action: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out = {"t": round(self.t, 3), "action": self.action}
        out.update(self.data)
        return out


class _MarkRecorder:
    """Async callable collecting moments relative to recording start."""

    def __init__(self) -> None:
        self._t0: float | None = None
        self.moments: list[Moment] = []

    def start(self) -> None:
        self._t0 = time.monotonic()

    async def __call__(self, action: str, **data: Any) -> None:
        if self._t0 is None:
            return
        t = time.monotonic() - self._t0
        self.moments.append(Moment(t=t, action=action, data=data))


def _load_user_script(path: Path):
    spec = importlib.util.spec_from_file_location("clipwright_user_demo", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "run"):
        raise AttributeError(f"{path} must define `async def run(page, mark)` (mark optional)")
    return mod.run


async def _call_user_run(user_run, page, mark) -> None:
    """Support both `run(page)` and `run(page, mark)` signatures."""
    sig = inspect.signature(user_run)
    if len(sig.parameters) >= 2:
        await user_run(page, mark)
    else:
        await user_run(page)


async def _run(
    url: str,
    user_run,
    video_dir: Path,
    size: tuple[int, int],
    recorder: _MarkRecorder,
) -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": size[0], "height": size[1]},
            record_video_dir=str(video_dir),
            record_video_size={"width": size[0], "height": size[1]},
        )
        page = await context.new_page()
        recorder.start()
        if url:
            await page.goto(url)
            await recorder("nav", url=url)
        await _call_user_run(user_run, page, recorder)
        await context.close()
        await browser.close()


def record(
    url: str,
    script_path: Path,
    out_dir: Path,
    *,
    size: tuple[int, int] = (1080, 1920),
) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    video_dir = out_dir / "_raw_video"
    video_dir.mkdir(exist_ok=True)

    user_run = _load_user_script(script_path)
    recorder = _MarkRecorder()
    asyncio.run(_run(url, user_run, video_dir, size, recorder))

    webms = sorted(video_dir.glob("*.webm"))
    if not webms:
        raise RuntimeError("Playwright produced no video (check record_video_dir permissions)")
    webm = webms[-1]
    video_mp4 = out_dir / "video.mp4"
    run(["ffmpeg", "-y", "-i", str(webm), *VCODEC, "-an", str(video_mp4)])

    moments_path = out_dir / "moments.json"
    moments_path.write_text(json.dumps([m.to_dict() for m in recorder.moments], indent=2))
    return video_mp4, moments_path
