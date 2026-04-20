"""Regenerate remotion/public/gradient-{dark,light}.jpg. Idempotent."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "remotion" / "public"
W, H = 1080, 1920


def radial(stops: list[tuple[float, tuple[int, int, int]]]) -> Image.Image:
    img = Image.new("RGB", (W, H))
    px = img.load()
    cx, cy = W / 2, H / 2
    max_r = (cx**2 + cy**2) ** 0.5
    for y in range(H):
        for x in range(W):
            r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            t = min(1.0, r / max_r)
            # linear interp across stops
            col = stops[-1][1]
            for (pos0, c0), (pos1, c1) in zip(stops, stops[1:], strict=False):
                if pos0 <= t <= pos1:
                    k = (t - pos0) / max(1e-6, pos1 - pos0)
                    col = tuple(int(a + (b - a) * k) for a, b in zip(c0, c1, strict=True))
                    break
            px[x, y] = col  # type: ignore[index]
    return img


def linear(a: tuple[int, int, int], b: tuple[int, int, int]) -> Image.Image:
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)
    for y in range(H):
        k = y / (H - 1)
        col = tuple(int(x + (z - x) * k) for x, z in zip(a, b, strict=True))
        draw.line([(0, y), (W, y)], fill=col)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    dark = radial([
        (0.0, (36, 26, 68)),
        (0.5, (18, 14, 40)),
        (1.0, (6, 4, 18)),
    ])
    dark.save(OUT / "gradient-dark.jpg", "JPEG", quality=88)

    light = linear((240, 230, 255), (180, 160, 220))
    light.save(OUT / "gradient-light.jpg", "JPEG", quality=88)

    # Default active = dark
    dark.save(OUT / "gradient.jpg", "JPEG", quality=88)
    print(f"wrote gradients to {OUT}")


if __name__ == "__main__":
    main()
