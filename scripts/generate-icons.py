#!/usr/bin/env python3
"""Regenerate every shipped image of the Ancilla mark from its vector source.

Source of truth: assets/brand/ancilla-mark.svg, a 32-unit icon grid holding one
round-capped, round-joined polyline (the two strokes of the "A") and one circle
(the node that stands in for the crossbar). This script reads that geometry and
paints it with Pillow alone, no SVG renderer: each mask is drawn at a large
multiple of the output size and box-filtered down (exact area coverage), and
every size is painted on its own instead of being shrunk from one master.

Treatment: navy rounded tile (#1A1A2E, corner 16.8% on the desktop PNGs, 7.5/32
on the SVGs), light strokes (#EFF0F2) and a blue node (#5FA7FF). On plain
backgrounds the strokes take the UI's ink and the node its accent (ON_LIGHT,
ON_DARK). The grid always maps onto the whole canvas, so the tiles and the
transparent master share one layout.

Writes:
  assets/brand/ancilla-mark-2048.png         transparent mark, light-UI colors
  apps/desktop/assets/icon.svg               the tile as a vector
  apps/desktop/src-tauri/icons/*             PNGs, icon.ico and icon.icns, with
                                             the filenames `tauri icon` produces
  apps/web/public/favicon.svg, favicon.ico, apple-touch-icon.png
  docs/assets/readme-hero-{light,dark}.png   set in Inter from node_modules
                                             (run `npm ci` first)

Requires: Pillow >= 10.1 (its ICNS writer works on every platform, so macOS
iconutil is not needed). Run from the repo root:
  python3 scripts/generate-icons.py
"""
from __future__ import annotations

import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from typing import NoReturn

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK_SVG = os.path.join(ROOT, "assets", "brand", "ancilla-mark.svg")
INTER = os.path.join(ROOT, "node_modules", "@fontsource-variable", "inter",
                     "files", "inter-latin-wght-normal.woff2")

TILE = "#1A1A2E"
# (strokes, node) per surface. The blues are the UI accent, oklch(0.55 0.19 257),
# and a lighter step of it, oklch(0.72 0.15 255), that holds up on navy and black.
ON_TILE = ("#EFF0F2", "#5FA7FF")
ON_LIGHT = ("#13161B", "#0A6DDD")
ON_DARK = ("#EFF0F2", "#5FA7FF")
RADIUS_FRAC = 86 / 512  # desktop tile corner, kept from the previous icon set
SVG_RADIUS = 7.5  # corner of the SVG tiles and the UI Logo, in grid units

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
# Every size Pillow's ICNS writer stores (ic07-ic14). It has no 16/32 px @1x entries
# (ic04/ic05), which iconutil adds; harmless while bundle.icon lists only icon.png,
# since tauri-bundler then builds the shipped .icns itself.
ICNS_SIZES = (32, 64, 128, 256, 512, 1024)


class Mark:
    """The geometry of assets/brand/ancilla-mark.svg, in grid units."""

    def __init__(self, path: str) -> None:
        def fail(why: str) -> NoReturn:
            sys.exit(f"{path}: {why}")

        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError) as err:
            fail(f"cannot read the mark ({err})")

        def find(tag: str) -> ET.Element:
            # At any depth and with or without the SVG namespace, so a <g> wrapper still parses.
            for el in root.iter():
                if el.tag.rpartition("}")[2] == tag:
                    return el
            fail(f"no <{tag}>; the mark is one stroke <path> and one node <circle>")

        def number(el: ET.Element, name: str) -> float:
            try:
                return float(el.get(name, ""))
            except ValueError:
                fail(f"<{el.tag.rpartition('}')[2]}> needs a numeric {name}")

        try:
            self.grid = float((root.get("viewBox") or "").split()[2])
        except (IndexError, ValueError):
            fail("the root <svg> needs a viewBox of four numbers")
        stroke = find("path")
        self.d = " ".join((stroke.get("d") or "").split())
        # Only an absolute M/L polyline is understood; curves would need a renderer.
        if not re.fullmatch(r"M[-\d. ,]+(L[-\d. ,]+)+", self.d):
            fail("the stroke must be an absolute M/L polyline")
        nums = [float(n) for n in re.findall(r"-?\d*\.?\d+", self.d)]
        if len(nums) % 2:
            fail("the stroke has an odd number of coordinates")
        self.points = list(zip(nums[0::2], nums[1::2]))
        self.width = number(stroke, "stroke-width")
        node = find("circle")
        self.node = tuple(number(node, k) for k in ("cx", "cy", "r"))


def coverage(size: int, grid: float, draw) -> Image.Image:
    """An L mask at `size` px; `draw(d, k)` paints it with k px per grid unit."""
    ss = max(4, math.ceil(4096 / size))
    big = Image.new("L", (size * ss, size * ss), 0)
    draw(ImageDraw.Draw(big), size * ss / grid)
    return big.reduce(ss)


def fill(img: Image.Image, color: str, mask: Image.Image) -> None:
    layer = Image.new("RGBA", img.size, color)
    layer.putalpha(mask)
    img.alpha_composite(layer)


def paint(mark: Mark, size: int, colors: tuple[str, str],
          tile: str | None = None) -> Image.Image:
    """The mark on a `size` px canvas spanning the grid. tile: None | tile | square."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if tile == "square":
        img.paste(TILE, (0, 0, size, size))
    elif tile == "tile":
        def tile_shape(d: ImageDraw.ImageDraw, k: float) -> None:
            edge = mark.grid * k - 1
            d.rounded_rectangle([0, 0, edge, edge],
                                radius=round(mark.grid * RADIUS_FRAC * k), fill=255)
        fill(img, TILE, coverage(size, mark.grid, tile_shape))

    def strokes(d: ImageDraw.ImageDraw, k: float) -> None:
        r = mark.width / 2 * k
        pts = [(x * k, y * k) for x, y in mark.points]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            n = math.hypot(x1 - x0, y1 - y0)
            if not n:  # a repeated point: its round join below covers it
                continue
            nx, ny = -(y1 - y0) / n * r, (x1 - x0) / n * r
            d.polygon([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny),
                       (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], fill=255)
        for x, y in pts:  # round caps at the ends, round joins between
            d.ellipse([x - r, y - r, x + r, y + r], fill=255)

    def node(d: ImageDraw.ImageDraw, k: float) -> None:
        cx, cy, r = (v * k for v in mark.node)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)

    fill(img, colors[0], coverage(size, mark.grid, strokes))
    fill(img, colors[1], coverage(size, mark.grid, node))
    return img


def tile_svg(mark: Mark, px: int | None = None) -> str:
    g, (ink, dot) = f"{mark.grid:g}", ON_TILE
    cx, cy, r = (f"{v:g}" for v in mark.node)
    dims = f' width="{px}" height="{px}"' if px else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {g} {g}"{dims}>'
            f'<rect width="{g}" height="{g}" rx="{SVG_RADIUS:g}" fill="{TILE}"/>'
            f'<path d="{mark.d}" fill="none" stroke="{ink}" '
            f'stroke-width="{mark.width:g}" stroke-linecap="round" '
            f'stroke-linejoin="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{dot}"/></svg>\n')


def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    try:
        face = ImageFont.truetype(INTER, size)
        face.set_variation_by_axes([weight])
        return face
    except OSError:
        print("warning: Inter not found (run npm ci); using Pillow's default face",
              file=sys.stderr)
        return ImageFont.load_default(size=size)


def hero(mark: Mark, dark: bool) -> Image.Image:
    """README banner: the mark beside the name, the tagline centered under both."""
    bg, muted = ("#101113", "#AEB1B6") if dark else ("#FBFCFE", "#4B5056")
    colors = ON_DARK if dark else ON_LIGHT
    img = Image.new("RGBA", (1600, 480), bg)
    d = ImageDraw.Draw(img)
    name, tagline = font(132, 700), font(38, 450)
    title = "Ancilla"
    line = "A desktop companion for Muse Code agent swarms"

    cap = -d.textbbox((0, 0), "H", font=name, anchor="ls")[1]
    ink = (mark.width + max(y for _, y in mark.points)
           - min(y for _, y in mark.points)) / mark.grid
    art = paint(mark, round(cap * 1.2 / ink), colors)
    art = art.crop(art.getchannel("A").getbbox())

    gap, leading = round(cap * 0.42), 112
    left = round((img.width - art.width - gap - d.textlength(title, font=name)) / 2)
    # The mark is centered on the cap height, and the whole block on the canvas.
    above = cap / 2 + art.height / 2
    below = leading + tagline.getmetrics()[1]
    baseline = round((img.height - above - below) / 2 + above)
    img.alpha_composite(art, (left, round(baseline - above)))
    d.text((left + art.width + gap, baseline), title, font=name, fill=colors[0],
           anchor="ls")
    d.text((img.width / 2, baseline + leading), line, font=tagline, fill=muted,
           anchor="ms")
    return img.convert("RGB")


def save(img: Image.Image, *rel: str) -> None:
    path = os.path.join(ROOT, *rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print("wrote", "/".join(rel), img.size)


def main() -> int:
    mark = Mark(MARK_SVG)
    icons = ("apps", "desktop", "src-tauri", "icons")
    tiles: dict[int, Image.Image] = {}

    def tile(size: int) -> Image.Image:
        if size not in tiles:
            tiles[size] = paint(mark, size, ON_TILE, "tile")
        return tiles[size]

    save(paint(mark, 2048, ON_LIGHT), "assets", "brand", "ancilla-mark-2048.png")

    save(tile(512), *icons, "icon.png")
    for s, name in ((32, "32x32.png"), (64, "64x64.png"),
                    (128, "128x128.png"), (256, "128x128@2x.png")):
        save(tile(s), *icons, name)
    for s in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save(tile(s), *icons, f"Square{s}x{s}Logo.png")
    save(tile(50), *icons, "StoreLogo.png")

    # Each ICO/ICNS entry is painted at its own size; the writers take the
    # largest image as the base and the rest through append_images.
    tile(256).save(os.path.join(ROOT, *icons, "icon.ico"), format="ICO",
                   sizes=[(s, s) for s in ICO_SIZES],
                   append_images=[tile(s) for s in ICO_SIZES[:-1]])
    print("wrote icon.ico", ICO_SIZES)
    tile(1024).save(os.path.join(ROOT, *icons, "icon.icns"), format="ICNS",
                    append_images=[tile(s) for s in ICNS_SIZES])
    print("wrote icon.icns", ICNS_SIZES)

    with open(os.path.join(ROOT, "apps", "desktop", "assets", "icon.svg"), "w",
              newline="\n") as f:
        f.write(tile_svg(mark, 512))
    print("wrote apps/desktop/assets/icon.svg")

    public = ("apps", "web", "public")
    with open(os.path.join(ROOT, *public, "favicon.svg"), "w", newline="\n") as f:
        f.write(tile_svg(mark))
    print("wrote apps/web/public/favicon.svg")
    tile(48).save(os.path.join(ROOT, *public, "favicon.ico"), format="ICO",
                  sizes=[(16, 16), (32, 32), (48, 48)],
                  append_images=[tile(16), tile(32)])
    print("wrote apps/web/public/favicon.ico (16, 32, 48)")
    # iOS masks the corners itself and wants no transparency.
    save(paint(mark, 180, ON_TILE, "square").convert("RGB"), *public,
         "apple-touch-icon.png")

    save(hero(mark, dark=False), "docs", "assets", "readme-hero-light.png")
    save(hero(mark, dark=True), "docs", "assets", "readme-hero-dark.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
