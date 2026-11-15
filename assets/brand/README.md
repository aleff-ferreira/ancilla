# Ancilla Brand Assets

The Ancilla logomark renders an architectural `"A"` formed by two rounded diagonal legs bridged by a circular crossbar node, representing the workspace guiding its background agent crew (*ancilla*).

As part of the AMAZONIA WORKS suite, the icon pairs a deep forest backdrop (`#0B1F18`) with pale mineral strokes (`#EEF5EE`) and an emerald node (`#34D399` dark / `#0B7862` light), keeping blue reserved strictly for live execution states inside the interface.

## Asset Inventory

- `ancilla-mark.svg`: Canonical `32x32` vector mark with `prefers-color-scheme` dark/light rules.
- `ancilla-mark-2048.png`: High-resolution transparent PNG export (`2048x2048`).

## Color Specification

| Context | Stroke Color | Center Node | Tile Fill |
| --- | --- | --- | --- |
| App icon, favicon, UI `Logo` | `#EEF5EE` | `#34D399` | `#0B1F18` |
| Light surface emblem | `#121815` | `#0B7862` | None |
| Dark surface emblem | `#EEF5EE` | `#34D399` | None |

Maintain minimum padding equal to the node's diameter around the mark, and always preserve the emerald node contrast on tiled icons so the glyph reads as an `"A"` rather than a plain chevron.

## Regenerating Icons & Banners

All platform icons (`apps/desktop/src-tauri/icons/{icon.ico,icon.icns,...}`), web favicons (`apps/web/public`), desktop SVG, and README banners (`docs/assets`) derive programmatically from `ancilla-mark.svg` using Pillow:

```bash
npm ci
python3 -m pip install pillow
python3 scripts/generate-icons.py
```

`scripts/generate-icons.py` expects exact `M`/`L` stroke geometry plus a single `<circle>`. Any geometry update must stay synchronized with `Logo` in `packages/ui/src/components/ui/primitives.tsx`—verified automatically by `packages/ui/test/logo.test.ts`.
