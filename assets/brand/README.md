# Ancilla brand

The Ancilla mark is an "A" drawn as two round strokes whose crossbar is a single node: the helper
(*ancilla*, Latin for handmaid) holding the agent swarm it runs for you. It is original to this
project. Helicon's mark, name and artwork belong to Helicon and are not used here.

| File | What it is |
| --- | --- |
| `ancilla-mark.svg` | Vector source on a 32-unit icon grid. Follows the reader's light or dark scheme. |
| `ancilla-mark-2048.png` | Transparent 2048 px master in the light-background colors. |

## Colors

| Use | Strokes | Node | Surface |
| --- | --- | --- | --- |
| App icon, favicon, UI `Logo` | `#EFF0F2` | `#5FA7FF` | navy tile `#1A1A2E` |
| On light backgrounds | `#13161B` | `#0A6DDD` (the UI accent) | |
| On dark backgrounds | `#EFF0F2` | `#5FA7FF` | |

Leave at least the node's diameter of clear space around the mark. Keep the node blue on the tile:
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
