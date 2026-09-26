#!/usr/bin/env python3
"""Regenerate the desktop app icon set from the Ancilla mark.

Treatment (locked): navy rounded tile (#1A1A2E, radius 16.8%%) + light mark
(#EFF0F2, 48%% of tile height), no dot. iOS gets the opaque square variant,
Android round gets the circular variant; everything else is the tile.

Writes into apps/desktop/src-tauri/icons/ with the exact filenames and sizes
`tauri icon` produced. icon.icns needs macOS `iconutil`; on other platforms
it is skipped with a warning (regenerate on macOS or in CI).

Requires: Pillow. Run from the repo root:
  .venv/bin/python scripts/generate-icons.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "apps", "desktop", "src-tauri", "icons")
MARK_PNG = os.path.join(ROOT, "assets", "social", "ancilla-mark-2048.png")
MARK_INK = (602, 521, 1444, 1439)

TILE = "#1A1A2E"
MARK = "#EFF0F2"
RADIUS_FRAC = 86 / 512  # measured from the previous icon
MARK_H_FRAC = 0.48


def mark_layer(height: int, color: str) -> Image.Image:
    ink = Image.open(MARK_PNG).crop(MARK_INK)
    w, h = ink.size
    target = (round(height * w / h), height)
    alpha = ink.getchannel("A").resize(target, Image.LANCZOS)
    layer = Image.new("RGBA", target, color)
    layer.putalpha(alpha)
    return layer


def master(size: int, variant: str = "tile") -> Image.Image:
    """Full icon art at `size` px. Variants: tile | square | round."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if variant == "square":
        d.rectangle([0, 0, size - 1, size - 1], fill=TILE)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1],
                            radius=round(size * RADIUS_FRAC), fill=TILE)
    mark = mark_layer(round(size * MARK_H_FRAC), MARK)
    img.alpha_composite(mark, ((size - mark.size[0]) // 2,
                               (size - mark.size[1]) // 2))
    if variant == "round":
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        img.putalpha(ImageChops.darker(img.getchannel("A"), mask))
    return img


def write(img: Image.Image, rel: str) -> None:
    path = os.path.join(ICONS, rel)
    img.save(path)
    print("wrote", rel, img.size)


def main() -> int:
    assert os.path.exists(MARK_PNG), "missing mark master"
    tile1024 = master(1024)
    square1024 = master(1024, "square")

    write(tile1024.resize((512, 512), Image.LANCZOS), "icon.png")
    for s, name in ((32, "32x32.png"), (64, "64x64.png"),
                    (128, "128x128.png"), (256, "128x128@2x.png")):
        write(tile1024.resize((s, s), Image.LANCZOS), name)
    for s in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        write(tile1024.resize((s, s), Image.LANCZOS),
              f"Square{s}x{s}Logo.png")
    write(tile1024.resize((50, 50), Image.LANCZOS), "StoreLogo.png")

    tile1024.save(os.path.join(ICONS, "icon.ico"),
                  sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                         (64, 64), (256, 256)])
    print("wrote icon.ico (16,24,32,48,64,256)")

    android = (("mdpi", 48, 108), ("hdpi", 49, 162), ("xhdpi", 96, 216),
               ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432))
    for dpi, launcher, fg in android:
        base = f"android/mipmap-{dpi}"
        write(tile1024.resize((launcher, launcher), Image.LANCZOS),
              f"{base}/ic_launcher.png")
        write(master(launcher, "round"), f"{base}/ic_launcher_round.png")
        write(tile1024.resize((fg, fg), Image.LANCZOS),
              f"{base}/ic_launcher_foreground.png")

    ios = {"AppIcon-20x20@1x.png": 20, "AppIcon-20x20@2x.png": 40,
           "AppIcon-20x20@2x-1.png": 40, "AppIcon-20x20@3x.png": 60,
           "AppIcon-29x29@1x.png": 29, "AppIcon-29x29@2x.png": 58,
           "AppIcon-29x29@2x-1.png": 58, "AppIcon-29x29@3x.png": 87,
           "AppIcon-40x40@1x.png": 40, "AppIcon-40x40@2x.png": 80,
           "AppIcon-40x40@2x-1.png": 80, "AppIcon-40x40@3x.png": 120,
           "AppIcon-60x60@2x.png": 120, "AppIcon-60x60@3x.png": 180,
           "AppIcon-76x76@1x.png": 76, "AppIcon-76x76@2x.png": 152,
           "AppIcon-83.5x83.5@2x.png": 167, "AppIcon-512@2x.png": 1024}
    for name, size in ios.items():
        write(square1024.resize((size, size), Image.LANCZOS), f"ios/{name}")

    if sys.platform != "darwin" or shutil.which("iconutil") is None:
        print("warning: iconutil missing (not macOS?), icon.icns unchanged")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "Icon.iconset")
        os.makedirs(iconset)
        for size, tag in ((16, "16x16"), (32, "16x16@2x"), (32, "32x32"),
                          (64, "32x32@2x"), (128, "128x128"),
                          (256, "128x128@2x"), (256, "256x256"),
                          (512, "256x256@2x"), (512, "512x512"),
                          (1024, "512x512@2x")):
            tile1024.resize((size, size), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{tag}.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o",
                        os.path.join(ICONS, "icon.icns")], check=True)
    print("wrote icon.icns")
    return 0


if __name__ == "__main__":
    sys.exit(main())
