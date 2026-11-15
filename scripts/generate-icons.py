#!/usr/bin/env python3
"""Asset generation utility for Ancilla brand iconography and application icons.

Processes the canonical vector source (assets/brand/ancilla-mark.svg) and renders
high-fidelity raster and vector artifacts across all desktop, web, and documentation targets.
"""

from __future__ import annotations

import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import NamedTuple, Sequence

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
VECTOR_MARK_PATH = REPO_ROOT / "assets" / "brand" / "ancilla-mark.svg"
INTER_FONT_PATH = (
    REPO_ROOT
    / "node_modules"
    / "@fontsource-variable"
    / "inter"
    / "files"
    / "inter-latin-wght-normal.woff2"
)

BRAND_TILE_BG = "#0B1F18"
PALETTE_ON_TILE = ("#EEF5EE", "#34D399")
PALETTE_ON_LIGHT = ("#121815", "#0B7862")
PALETTE_ON_DARK = ("#EEF5EE", "#34D399")

TILE_CORNER_RATIO = 86.0 / 512.0
SVG_CORNER_RADIUS = 7.5

WINDOWS_ICO_RESOLUTIONS = (16, 24, 32, 48, 64, 128, 256)
MACOS_ICNS_RESOLUTIONS = (32, 64, 128, 256, 512, 1024)
SQUARE_LOGO_SIZES = (30, 44, 71, 89, 107, 142, 150, 284, 310)


class NodeGeometry(NamedTuple):
    cx: float
    cy: float
    r: float


class AncillaMarkGeometry:
    """Parses and encapsulates the SVG vector geometry for Ancilla's brand emblem."""

    def __init__(self, source_svg_path: Path | str) -> None:
        source_path = Path(source_svg_path)
        if not source_path.is_file():
            sys.exit(f"Source vector file not found: {source_path}")

        try:
            tree = ET.parse(source_path)
            root_element = tree.getroot()
        except Exception as parse_exc:
            sys.exit(f"Failed to parse XML from {source_path}: {parse_exc}")

        view_box_attr = root_element.get("viewBox", "")
        box_tokens = view_box_attr.split()
        if len(box_tokens) != 4:
            sys.exit(f"Invalid viewBox attribute in {source_path}: '{view_box_attr}'")

        try:
            self.grid_units = float(box_tokens[2])
        except ValueError:
            sys.exit(f"Non-numeric viewBox grid dimension: {box_tokens[2]}")

        path_elem = self._locate_element_by_tag(root_element, "path")
        circle_elem = self._locate_element_by_tag(root_element, "circle")

        raw_path_d = path_elem.get("d", "").strip()
        self.path_data = " ".join(raw_path_d.split())
        if not re.fullmatch(r"M[-\d. ,]+(L[-\d. ,]+)+", self.path_data):
            sys.exit(f"Path d attribute must describe an absolute polyline: {self.path_data}")

        coord_strings = re.findall(r"-?\d*\.?\d+", self.path_data)
        if len(coord_strings) % 2 != 0:
            sys.exit("Coordinates list in stroke path has an odd length")

        float_coords = [float(val) for val in coord_strings]
        self.polyline_points = list(zip(float_coords[0::2], float_coords[1::2]))

        try:
            self.stroke_thickness = float(path_elem.get("stroke-width", "0"))
            self.node = NodeGeometry(
                cx=float(circle_elem.get("cx", "0")),
                cy=float(circle_elem.get("cy", "0")),
                r=float(circle_elem.get("r", "0")),
            )
        except ValueError as num_err:
            sys.exit(f"Numeric parse error in geometry attributes: {num_err}")

    @staticmethod
    def _locate_element_by_tag(parent_root: ET.Element, tag_name: str) -> ET.Element:
        for node in parent_root.iter():
            local_tag = node.tag.split("}")[-1] if "}" in node.tag else node.tag
            if local_tag == tag_name:
                return node
        sys.exit(f"Required element <{tag_name}> missing from vector definition")


def render_coverage_channel(
    pixel_dimension: int,
    reference_grid: float,
    paint_callback,
) -> Image.Image:
    """Renders a grayscale coverage mask using supersampling for box-filtered antialiasing."""
    oversample_scale = max(4, math.ceil(4096 / pixel_dimension))
    canvas_oversampled_size = pixel_dimension * oversample_scale

    mask_surface = Image.new("L", (canvas_oversampled_size, canvas_oversampled_size), 0)
    canvas_context = ImageDraw.Draw(mask_surface)
    scale_factor = canvas_oversampled_size / reference_grid

    paint_callback(canvas_context, scale_factor)
    return mask_surface.reduce(oversample_scale)


def apply_color_layer(target_image: Image.Image, hex_color: str, alpha_mask: Image.Image) -> None:
    """Overlays a solid color layer modulated by the provided alpha mask."""
    color_surface = Image.new("RGBA", target_image.size, hex_color)
    color_surface.putalpha(alpha_mask)
    target_image.alpha_composite(color_surface)


def rasterize_mark(
    mark: AncillaMarkGeometry,
    dimension_px: int,
    stroke_and_node_colors: tuple[str, str],
    background_mode: str | None = None,
) -> Image.Image:
    """Rasterizes the Ancilla mark onto a canvas of dimension_px x dimension_px."""
    canvas = Image.new("RGBA", (dimension_px, dimension_px), (0, 0, 0, 0))

    if background_mode == "square":
        canvas.paste(BRAND_TILE_BG, (0, 0, dimension_px, dimension_px))
    elif background_mode == "tile":
        def draw_rounded_tile(draw_ctx: ImageDraw.ImageDraw, scale: float) -> None:
            max_bound = mark.grid_units * scale - 1
            corner_px = round(mark.grid_units * TILE_CORNER_RATIO * scale)
            draw_ctx.rounded_rectangle([0, 0, max_bound, max_bound], radius=corner_px, fill=255)

        tile_mask = render_coverage_channel(dimension_px, mark.grid_units, draw_rounded_tile)
        apply_color_layer(canvas, BRAND_TILE_BG, tile_mask)

    def draw_mark_strokes(draw_ctx: ImageDraw.ImageDraw, scale: float) -> None:
        half_stroke_px = (mark.stroke_thickness / 2.0) * scale
        scaled_points = [(px * scale, py * scale) for px, py in mark.polyline_points]

        for pt_start, pt_end in zip(scaled_points, scaled_points[1:]):
            dx = pt_end[0] - pt_start[0]
            dy = pt_end[1] - pt_start[1]
            seg_len = math.hypot(dx, dy)
            if seg_len == 0:
                continue

            normal_x = (-dy / seg_len) * half_stroke_px
            normal_y = (dx / seg_len) * half_stroke_px

            quad_vertices = [
                (pt_start[0] + normal_x, pt_start[1] + normal_y),
                (pt_end[0] + normal_x, pt_end[1] + normal_y),
                (pt_end[0] - normal_x, pt_end[1] - normal_y),
                (pt_start[0] - normal_x, pt_start[1] - normal_y),
            ]
            draw_ctx.polygon(quad_vertices, fill=255)

        for px, py in scaled_points:
            draw_ctx.ellipse(
                [px - half_stroke_px, py - half_stroke_px, px + half_stroke_px, py + half_stroke_px],
                fill=255,
            )

    def draw_mark_node(draw_ctx: ImageDraw.ImageDraw, scale: float) -> None:
        center_x = mark.node.cx * scale
        center_y = mark.node.cy * scale
        node_radius = mark.node.r * scale
        draw_ctx.ellipse(
            [center_x - node_radius, center_y - node_radius, center_x + node_radius, center_y + node_radius],
            fill=255,
        )

    strokes_mask = render_coverage_channel(dimension_px, mark.grid_units, draw_mark_strokes)
    node_mask = render_coverage_channel(dimension_px, mark.grid_units, draw_mark_node)

    apply_color_layer(canvas, stroke_and_node_colors[0], strokes_mask)
    apply_color_layer(canvas, stroke_and_node_colors[1], node_mask)
    return canvas


def build_tile_svg_markup(mark: AncillaMarkGeometry, display_dimension: int | None = None) -> str:
    """Generates standalone SVG markup with rounded background tile."""
    grid_str = f"{mark.grid_units:g}"
    stroke_color, node_color = PALETTE_ON_TILE
    cx_s = f"{mark.node.cx:g}"
    cy_s = f"{mark.node.cy:g}"
    r_s = f"{mark.node.r:g}"
    dim_attr = f' width="{display_dimension}" height="{display_dimension}"' if display_dimension else ""

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {grid_str} {grid_str}"{dim_attr}>'
        f'<rect width="{grid_str}" height="{grid_str}" rx="{SVG_CORNER_RADIUS:g}" fill="{BRAND_TILE_BG}"/>'
        f'<path d="{mark.path_data}" fill="none" stroke="{stroke_color}" '
        f'stroke-width="{mark.stroke_thickness:g}" stroke-linecap="round" stroke-linejoin="round"/>'
        f'<circle cx="{cx_s}" cy="{cy_s}" r="{r_s}" fill="{node_color}"/></svg>\n'
    )


def load_typeface(point_size: int, font_weight: int) -> ImageFont.FreeTypeFont:
    """Loads Inter variable font if available, falling back to PIL default font."""
    if INTER_FONT_PATH.is_file():
        try:
            face = ImageFont.truetype(str(INTER_FONT_PATH), point_size)
            face.set_variation_by_axes([font_weight])
            return face
        except OSError:
            pass
    print("warning: Inter not found (run npm ci); using Pillow's default face", file=sys.stderr)
    return ImageFont.load_default(size=point_size)


def generate_hero_banner(mark: AncillaMarkGeometry, is_dark_mode: bool) -> Image.Image:
    """Renders the 1600x480 hero banner for repository documentation."""
    bg_color, secondary_text_color = ("#0D1211", "#ACB3AF") if is_dark_mode else ("#FBFDFC", "#4A524F")
    palette = PALETTE_ON_DARK if is_dark_mode else PALETTE_ON_LIGHT

    banner_surface = Image.new("RGBA", (1600, 480), bg_color)
    banner_draw = ImageDraw.Draw(banner_surface)

    primary_title = "Ancilla"
    subtitle_text = "A desktop companion for Muse Code agent crews"

    title_font = load_typeface(132, 700)
    tagline_font = load_typeface(38, 450)

    cap_height = -banner_draw.textbbox((0, 0), "H", font=title_font, anchor="ls")[1]
    y_coords = [coord[1] for coord in mark.polyline_points]
    ink_vertical_span = (mark.stroke_thickness + max(y_coords) - min(y_coords)) / mark.grid_units

    rendered_art = rasterize_mark(mark, round(cap_height * 1.2 / ink_vertical_span), palette)
    cropped_art = rendered_art.crop(rendered_art.getchannel("A").getbbox())

    element_gap = round(cap_height * 0.42)
    line_spacing = 112
    title_pixel_width = banner_draw.textlength(primary_title, font=title_font)
    total_header_width = cropped_art.width + element_gap + title_pixel_width
    left_margin = round((banner_surface.width - total_header_width) / 2)

    top_offset = cap_height / 2 + cropped_art.height / 2
    bottom_offset = line_spacing + tagline_font.getmetrics()[1]
    baseline_y = round((banner_surface.height - top_offset - bottom_offset) / 2 + top_offset)

    banner_surface.alpha_composite(cropped_art, (left_margin, round(baseline_y - top_offset)))
    banner_draw.text(
        (left_margin + cropped_art.width + element_gap, baseline_y),
        primary_title,
        font=title_font,
        fill=palette[0],
        anchor="ls",
    )
    banner_draw.text(
        (banner_surface.width / 2, baseline_y + line_spacing),
        subtitle_text,
        font=tagline_font,
        fill=secondary_text_color,
        anchor="ms",
    )

    return banner_surface.convert("RGB")


def export_image_artifact(img: Image.Image, relative_dest_parts: Sequence[str]) -> None:
    destination_path = REPO_ROOT.joinpath(*relative_dest_parts)
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(destination_path, optimize=True)
    rel_display_path = "/".join(relative_dest_parts)
    print("wrote", rel_display_path, img.size)


def main() -> int:
    mark_geometry = AncillaMarkGeometry(VECTOR_MARK_PATH)
    desktop_icons_folder = ("apps", "desktop", "src-tauri", "icons")
    cached_tile_images: dict[int, Image.Image] = {}

    def fetch_tile_image(dim: int) -> Image.Image:
        if dim not in cached_tile_images:
            cached_tile_images[dim] = rasterize_mark(mark_geometry, dim, PALETTE_ON_TILE, "tile")
        return cached_tile_images[dim]

    export_image_artifact(
        rasterize_mark(mark_geometry, 2048, PALETTE_ON_LIGHT),
        ("assets", "brand", "ancilla-mark-2048.png"),
    )

    export_image_artifact(fetch_tile_image(512), (*desktop_icons_folder, "icon.png"))

    standard_icon_resolutions = (
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
    )
    for res, filename in standard_icon_resolutions:
        export_image_artifact(fetch_tile_image(res), (*desktop_icons_folder, filename))

    for square_dim in SQUARE_LOGO_SIZES:
        export_image_artifact(
            fetch_tile_image(square_dim),
            (*desktop_icons_folder, f"Square{square_dim}x{square_dim}Logo.png"),
        )

    export_image_artifact(fetch_tile_image(50), (*desktop_icons_folder, "StoreLogo.png"))

    ico_path = REPO_ROOT.joinpath(*desktop_icons_folder, "icon.ico")
    fetch_tile_image(256).save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in WINDOWS_ICO_RESOLUTIONS],
        append_images=[fetch_tile_image(s) for s in WINDOWS_ICO_RESOLUTIONS[:-1]],
    )
    print("wrote icon.ico", WINDOWS_ICO_RESOLUTIONS)

    icns_path = REPO_ROOT.joinpath(*desktop_icons_folder, "icon.icns")
    fetch_tile_image(1024).save(
        icns_path,
        format="ICNS",
        append_images=[fetch_tile_image(s) for s in MACOS_ICNS_RESOLUTIONS],
    )
    print("wrote icon.icns", MACOS_ICNS_RESOLUTIONS)

    desktop_svg_dest = REPO_ROOT / "apps" / "desktop" / "assets" / "icon.svg"
    desktop_svg_dest.parent.mkdir(parents=True, exist_ok=True)
    with open(desktop_svg_dest, "w", newline="\n") as svg_out:
        svg_out.write(build_tile_svg_markup(mark_geometry, 512))
    print("wrote apps/desktop/assets/icon.svg")

    web_public_dest = ("apps", "web", "public")
    web_favicon_svg = REPO_ROOT.joinpath(*web_public_dest, "favicon.svg")
    web_favicon_svg.parent.mkdir(parents=True, exist_ok=True)
    with open(web_favicon_svg, "w", newline="\n") as fav_out:
        fav_out.write(build_tile_svg_markup(mark_geometry))
    print("wrote apps/web/public/favicon.svg")

    web_favicon_ico = REPO_ROOT.joinpath(*web_public_dest, "favicon.ico")
    fetch_tile_image(48).save(
        web_favicon_ico,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[fetch_tile_image(16), fetch_tile_image(32)],
    )
    print("wrote apps/web/public/favicon.ico (16, 32, 48)")

    export_image_artifact(
        rasterize_mark(mark_geometry, 180, PALETTE_ON_TILE, "square").convert("RGB"),
        (*web_public_dest, "apple-touch-icon.png"),
    )

    export_image_artifact(
        generate_hero_banner(mark_geometry, is_dark_mode=False),
        ("docs", "assets", "readme-hero-light.png"),
    )
    export_image_artifact(
        generate_hero_banner(mark_geometry, is_dark_mode=True),
        ("docs", "assets", "readme-hero-dark.png"),
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
