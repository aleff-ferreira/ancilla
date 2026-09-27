# Ancilla brand

The Ancilla mark is an "A" drawn as two round strokes whose crossbar is a single node: the helper
(*ancilla*, Latin for handmaid) holding the agent crew it runs for you. It is original to this
project. Helicon's mark, name and artwork belong to Helicon and are not used here.

Ancilla is an AMAZONIA WORKS product. The forest tile, pale ink and emerald node carry that
family identity while preserving Ancilla's own mark. Blue in the product remains an execution
and operational color, separate from the brand palette.

| File | What it is |
| --- | --- |
| `ancilla-mark.svg` | Vector source on a 32-unit icon grid. Follows the reader's light or dark scheme. |
| `ancilla-mark-2048.png` | Transparent 2048 px master in the light-background colors. |

## Colors

| Use | Strokes | Node | Surface |
| --- | --- | --- | --- |
| App icon, favicon, UI `Logo` | `#EEF5EE` | `#34D399` | forest tile `#0B1F18` |
| On light backgrounds | `#121815` | `#0B7862` (the light UI brand accent) | |
| On dark backgrounds | `#EEF5EE` | `#34D399` | |

Leave at least the node's diameter of clear space around the mark. Keep the node emerald on the tile:
in the stroke color it merges with the legs at small sizes and the mark reads as a plain chevron.

## Regenerating

Every shipped image is painted from `ancilla-mark.svg` by one Pillow script: the mark master
above, the desktop icon set (`apps/desktop/src-tauri/icons`, including `icon.ico` and
`icon.icns`), `apps/desktop/assets/icon.svg`, the web favicons in `apps/web/public` and the README
banners in `docs/assets`.

```bash
npm ci                                  # the banners are set in the UI's own Inter
python3 -m pip install pillow           # Pillow 10.1 or newer
python3 scripts/generate-icons.py
```

The script understands only what the source uses today, an absolute `M`/`L` polyline with round
caps and joins plus one circle, and stops with an error if the stroke grows curves. The UI `Logo`
in `packages/ui/src/components/ui/primitives.tsx` carries a copy of the same geometry, and
`packages/ui/test/logo.test.ts` fails if the two drift apart.

The generator's `TILE`, `ON_TILE`, `ON_LIGHT` and `ON_DARK` constants carry the output colors.
Update those, the source SVG and `Logo` together when the palette changes. README banner
backgrounds and secondary text use the product's neutral palette.
