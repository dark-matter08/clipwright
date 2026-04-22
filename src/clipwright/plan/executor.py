"""Drive a Playwright page through a BrowsePlan, emitting per-action moments.

Each action becomes one moment with `{t, type, label, fields, wait}`. The
downstream segment builder uses `type` to pick camera-zoom patterns and
`label` to generate voiceover copy.
"""
from __future__ import annotations

import importlib.util
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .schema import Action, BrowsePlan


async def execute_plan(page, plan: BrowsePlan, mark, plan_dir: Path) -> None:
    if plan.auth and plan.auth.helper:
        helper = _load_auth_helper(plan.auth.helper, plan_dir)
        await helper(page)
    for action in plan.actions:
        await _execute_action(page, action, plan.base_url, mark)


def _load_auth_helper(spec: str, plan_dir: Path) -> Callable[[Any], Awaitable[None]]:
    if ":" not in spec:
        raise ValueError(f"auth.helper must be 'module:func', got {spec!r}")
    mod_path, func_name = spec.split(":", 1)
    py = plan_dir / f"{mod_path}.py"
    if not py.exists():
        raise FileNotFoundError(f"auth helper module not found: {py}")
    spec_ = importlib.util.spec_from_file_location(f"_clipwright_auth_{mod_path}", py)
    if spec_ is None or spec_.loader is None:
        raise ImportError(f"cannot import {py}")
    mod = importlib.util.module_from_spec(spec_)
    spec_.loader.exec_module(mod)
    fn = getattr(mod, func_name, None)
    if fn is None:
        raise AttributeError(f"{py} has no attribute {func_name!r}")
    return fn


async def _execute_action(page, action: Action, base_url: str, mark) -> None:
    handler = _HANDLERS.get(action.type)
    if handler is None:
        raise ValueError(f"no handler for action type {action.type!r}")
    await handler(page, action, base_url)
    await page.wait_for_timeout(int(action.wait * 1000))
    await mark(
        action.type,
        label=action.label,
        fields=action.fields,
        wait=action.wait,
        chapter=action.chapter,
    )


async def _navigate(page, action: Action, base_url: str) -> None:
    url = action.fields["url"]
    if url.startswith("/"):
        url = base_url.rstrip("/") + url
    await page.goto(url)
    await page.wait_for_load_state("networkidle")


def _resolve_scope(page, fields: dict[str, Any]):
    """Return the page or a specific frame, based on the optional `frame` field.

    `frame` is a substring; the first frame whose URL contains it is used.
    """
    needle = fields.get("frame")
    if not needle:
        return page
    for f in page.frames:
        if needle in f.url:
            return f
    raise ValueError(f"no frame whose url contains {needle!r}")


def _resolve_locator(page, fields: dict[str, Any]):
    scope = _resolve_scope(page, fields)
    if fields.get("selector"):
        return scope.locator(fields["selector"]).first
    if fields.get("test_id"):
        return scope.get_by_test_id(fields["test_id"]).first
    if fields.get("role") and fields.get("name"):
        return scope.get_by_role(fields["role"], name=fields["name"]).first
    if fields.get("text"):
        return scope.get_by_text(fields["text"], exact=fields.get("exact", False)).first
    raise ValueError(f"no selector form in fields: {fields!r}")


async def _click(page, action: Action, base_url: str) -> None:
    loc = _resolve_locator(page, action.fields)
    timeout = int(action.fields.get("timeout", 5000))
    if action.fields.get("force"):
        try:
            await loc.click(force=True, timeout=timeout)
        except Exception:
            await loc.dispatch_event("click", timeout=timeout)
    else:
        await loc.click(timeout=timeout)


async def _type(page, action: Action, base_url: str) -> None:
    loc = _resolve_locator(page, action.fields)
    text = action.fields["text"]
    if action.fields.get("clear", True):
        await loc.fill(text)
    else:
        await loc.type(text, delay=int(action.fields.get("delay_ms", 30)))


async def _hover(page, action: Action, base_url: str) -> None:
    loc = _resolve_locator(page, action.fields)
    await loc.hover(timeout=int(action.fields.get("timeout", 5000)))


async def _scroll(page, action: Action, base_url: str) -> None:
    by_y = int(action.fields.get("by_y", 600))
    to_y = action.fields.get("to_y")
    if to_y is not None:
        await page.evaluate(f"window.scrollTo({{top: {int(to_y)}, behavior: 'smooth'}})")
    else:
        await page.evaluate(
            f"window.scrollTo({{top: document.documentElement.scrollTop + {by_y}, behavior: 'instant'}})"
        )


async def _wait(page, action: Action, base_url: str) -> None:
    # `wait` action has no per-action work; the wait_for_timeout below the
    # handler call in _execute_action covers the dwell.
    return None


async def _key(page, action: Action, base_url: str) -> None:
    await page.keyboard.press(action.fields["press"])


_HANDLERS: dict[str, Callable[..., Awaitable[None]]] = {
    "navigate": _navigate,
    "click": _click,
    "type": _type,
    "hover": _hover,
    "scroll": _scroll,
    "wait": _wait,
    "key": _key,
}
