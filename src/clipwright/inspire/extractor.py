"""Brand asset extractor — fetches a URL headlessly and writes out/brand/.

Artifacts written:
  out/brand/hero.png        — OG image or full-page screenshot
  out/brand/logo.png        — largest favicon / apple-touch-icon (if found)
  out/brand/copy.json       — {title, description, h1}
  out/brand/primary_color   — hex string e.g. "#4f46e5"

All paths are returned in a dict so callers can stage them for Remotion.
The extraction is deterministic given the same URL — re-running produces
byte-identical assets (determinism comes from the page content, not random
seeds). If the page 404s, raises RuntimeError.

Requires Playwright (already a Clipwright dependency).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from .color import pick_brand_color

# CSS variable names that typically carry a brand primary.
_BRAND_VAR_NAMES = [
    "--color-primary",
    "--primary-color",
    "--brand-color",
    "--brand-primary",
    "--accent",
    "--accent-color",
    "--theme-color",
    "--color-accent",
    "--primary",
]

# Favicon / icon link rel values, in preference order.
_ICON_RELS = [
    "apple-touch-icon",
    "apple-touch-icon-precomposed",
    "icon",
    "shortcut icon",
]


async def _extract(url: str, out_dir: Path) -> dict[str, Any]:
    from playwright.async_api import async_playwright  # lazy import

    out_dir.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        page = await ctx.new_page()

        resp = await page.goto(url, wait_until="networkidle", timeout=30_000)
        if resp and resp.status >= 400:
            await browser.close()
            raise RuntimeError(f"HTTP {resp.status} fetching {url!r}")

        # ── Title / description / h1 ────────────────────────────────────────
        title = await page.title() or ""
        description = await page.evaluate(
            "document.querySelector('meta[name=\"description\"]')?.content || "
            "document.querySelector('meta[property=\"og:description\"]')?.content || ''"
        )
        h1 = await page.evaluate(
            "document.querySelector('h1')?.innerText || ''"
        )
        copy = {"title": title.strip(), "description": description.strip(), "h1": h1.strip()}
        (out_dir / "copy.json").write_text(json.dumps(copy, indent=2) + "\n")

        # ── Theme color ──────────────────────────────────────────────────────
        theme_color: str | None = await page.evaluate(
            "document.querySelector('meta[name=\"theme-color\"]')?.content || null"
        )

        # ── CSS custom properties on :root ───────────────────────────────────
        css_vars: list[str] = await page.evaluate(f"""
            (() => {{
                const style = getComputedStyle(document.documentElement);
                return {json.dumps(_BRAND_VAR_NAMES)}.map(v => style.getPropertyValue(v).trim()).filter(Boolean);
            }})()
        """)

        # ── OG image → hero.png ──────────────────────────────────────────────
        og_image: str | None = await page.evaluate(
            "document.querySelector('meta[property=\"og:image\"]')?.content || "
            "document.querySelector('meta[name=\"og:image\"]')?.content || null"
        )
        hero_path = out_dir / "hero.png"
        if og_image:
            # Download OG image.
            try:
                img_resp = await page.request.get(og_image)
                if img_resp.ok:
                    hero_path.write_bytes(await img_resp.body())
            except Exception:  # noqa: BLE001
                og_image = None  # fall through to screenshot

        if not hero_path.exists() or hero_path.stat().st_size < 100:
            # Fall back to a full-page screenshot.
            await page.screenshot(path=str(hero_path), full_page=False, type="png")

        # ── Logo / favicon → logo.png ────────────────────────────────────────
        logo_path = out_dir / "logo.png"
        icon_url: str | None = None
        for rel in _ICON_RELS:
            icon_url = await page.evaluate(
                f"document.querySelector('link[rel=\"{rel}\"]')?.href || null"
            )
            if icon_url:
                break
        if not icon_url:
            # Try /favicon.ico as universal fallback.
            from urllib.parse import urlparse
            parsed = urlparse(url)
            icon_url = f"{parsed.scheme}://{parsed.netloc}/favicon.ico"

        if icon_url:
            try:
                icon_resp = await page.request.get(icon_url)
                if icon_resp.ok:
                    body = await icon_resp.body()
                    if len(body) > 100:
                        # Convert to PNG if PIL available (handles .ico, .svg etc.)
                        try:
                            import io

                            from PIL import Image  # type: ignore[import-untyped]
                            img = Image.open(io.BytesIO(body))
                            img = img.convert("RGBA")
                            # Pick largest size from multi-res ico.
                            if hasattr(img, "n_frames"):
                                pass  # already largest via open()
                            img.save(str(logo_path), format="PNG")
                        except Exception:  # noqa: BLE001
                            logo_path.write_bytes(body)
            except Exception:  # noqa: BLE001
                pass

        await browser.close()

    # ── Primary color ────────────────────────────────────────────────────────
    primary_color = pick_brand_color(
        theme_color=theme_color,
        css_vars=css_vars,
        screenshot_path=str(hero_path) if hero_path.exists() else None,
    )
    (out_dir / "primary_color").write_text(primary_color)

    return {
        "copy": copy,
        "primary_color": primary_color,
        "hero": str(hero_path) if hero_path.exists() else None,
        "logo": str(logo_path) if logo_path.exists() else None,
    }


def extract(url: str, out_dir: Path) -> dict[str, Any]:
    """Synchronous wrapper around the async extractor."""
    return asyncio.run(_extract(url, out_dir))
