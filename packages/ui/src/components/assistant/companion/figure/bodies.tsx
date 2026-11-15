import type { ReactNode } from "react";

/**
 * The bodies a figure can have. Each is a silhouette in the 160-unit box plus the places the other parts attach to it: where
 * the eyes and mouth go, where an ear's base sits, how wide the head is at the hat's band, where the neck is. A body is one
 * or more shapes; when there are several (a cloud, a mushroom) they are drawn as one outline, so the overlap does not show.
 */

export type Tone = "body" | "accent";

export type Shape =
  | { t: "path"; d: string; tone?: Tone }
  | { t: "circle"; cx: number; cy: number; r: number; tone?: Tone }
  | { t: "ellipse"; cx: number; cy: number; rx: number; ry: number; tone?: Tone }
  | { t: "rect"; x: number; y: number; w: number; h: number; r?: number; tone?: Tone };

/** What a body's own extra drawing is given: the prefix that makes this figure's gradient and clip ids its own. */
export interface DrawContext {
  id: string;
}

export interface BodyDef {
  id: string;
  shapes: readonly Shape[];
  /** The eyes' midline, half the gap between two eyes, and the mouth's line. */
  cy: number;
  eyeDx: number;
  mouthY: number;
  /** The base of the left ear on the outline (the right one mirrors about x = 80), and the crown's height at x = 80. */
  ear: readonly [number, number];
  crown: number;
  /** Where a hat's band sits and how wide the head is there, half-width. */
  hat: { y: number; hw: number };
  /** Where things reach the side (headphones, wings, arms): a height and the body's half-width at it. */
  side: { y: number; hw: number };
  /** The neck, where a scarf or a bow tie goes. */
  neck: number;
  /** The lowest point. */
  bottom: number;
  /** The belly patch: cx, cy, rx, ry. */
  belly: readonly [number, number, number, number] | null;
  /** Where spots and stripes may fall: x, y, width, height. */
  zone: readonly [number, number, number, number];
  /** Where the highlight sits on the body, when the default (upper left of the head) falls outside it. */
  shine?: readonly [number, number];
  /** Has little arms and feet. */
  limbs?: boolean;
  /** Floats instead of standing: it drifts up and down over a small shadow. */
  float?: boolean;
  /** Spots on this body are light on a dark ground (a mushroom's cap) rather than dark. */
  lightSpots?: boolean;
  /** Drawn behind the body: tentacles, a jet. */
  back?: (ctx: DrawContext) => ReactNode;
  /** Drawn on the body, clipped to it: facets, an inner flame. */
  detail?: (ctx: DrawContext) => ReactNode;
}

const GHOST_HEM = "L122 132 Q113.6 150 105.2 132 Q96.8 150 88.4 132 Q80 150 71.6 132 Q63.2 150 54.8 132 Q46.4 150 38 132 Z";

export const BODY_DEFS: Record<string, BodyDef> = {
  blob: {
    id: "blob",
    shapes: [{ t: "path", d: "M38 100 C38 62 56 38 80 38 C104 38 122 62 122 100 C122 124 104 138 80 138 C56 138 38 124 38 100 Z" }],
    cy: 90, eyeDx: 17, mouthY: 109,
    ear: [50, 54.7], crown: 38,
    hat: { y: 60, hw: 35 }, side: { y: 98, hw: 42 }, neck: 120, bottom: 138,
    belly: [80, 114, 24, 19], zone: [40, 42, 80, 94],
    limbs: true,
  },
  egg: {
    id: "egg",
    shapes: [{ t: "path", d: "M80 28 C104 28 122 64 122 100 C122 124 104 140 80 140 C56 140 38 124 38 100 C38 64 56 28 80 28 Z" }],
    cy: 92, eyeDx: 15, mouthY: 111,
    ear: [50, 50.5], crown: 28,
    hat: { y: 54, hw: 30 }, side: { y: 98, hw: 42 }, neck: 122, bottom: 140,
    belly: [80, 118, 23, 20], zone: [40, 34, 80, 102],
    limbs: true,
  },
  wide: {
    id: "wide",
    shapes: [{ t: "path", d: "M26 98 C26 66 50 48 80 48 C110 48 134 66 134 98 C134 124 110 138 80 138 C50 138 26 124 26 98 Z" }],
    cy: 95, eyeDx: 23, mouthY: 113,
    ear: [42, 61], crown: 48,
    hat: { y: 68, hw: 44 }, side: { y: 100, hw: 54 }, neck: 124, bottom: 138,
    belly: [80, 118, 32, 16], zone: [28, 50, 104, 86],
    limbs: true,
  },
  bean: {
    id: "bean",
    shapes: [{ t: "path", d: "M26 112 C26 80 48 58 80 58 C112 58 134 80 134 112 C134 128 122 138 106 138 L54 138 C38 138 26 128 26 112 Z" }],
    cy: 104, eyeDx: 21, mouthY: 122,
    ear: [41, 73], crown: 58,
    hat: { y: 78, hw: 42 }, side: { y: 112, hw: 54 }, neck: 132, bottom: 138,
    belly: null, zone: [28, 60, 104, 76],
    limbs: true,
    detail: ({ id }) => (
      <g aria-hidden="true">
        <ellipse cx="54" cy="76" rx="14" ry="6" transform="rotate(-24 54 76)" fill="#fff" opacity="0.34" className="fg-glint" />
        <circle cx="38" cy="96" r="3" fill="#fff" opacity="0.22" />
        <circle cx={112} cy={124} r={5} fill={`url(#${id}sh)`} opacity="0.6" />
      </g>
    ),
  },
  pill: {
    id: "pill",
    shapes: [{ t: "path", d: "M46 74 C46 48 60 30 80 30 C100 30 114 48 114 74 L114 98 C114 122 100 140 80 140 C60 140 46 122 46 98 Z" }],
    cy: 78, eyeDx: 14, mouthY: 97,
    ear: [55.5, 42.3], crown: 30,
    hat: { y: 52, hw: 29 }, side: { y: 84, hw: 34 }, neck: 108, bottom: 140,
    belly: [80, 118, 20, 16], zone: [48, 32, 64, 104],
    limbs: true,
  },
  box: {
    id: "box",
    shapes: [{ t: "path", d: "M54 42 H106 A22 22 0 0 1 128 64 V116 A22 22 0 0 1 106 138 H54 A22 22 0 0 1 32 116 V64 A22 22 0 0 1 54 42 Z" }],
    cy: 90, eyeDx: 20, mouthY: 112,
    ear: [46, 49], crown: 42,
    hat: { y: 60, hw: 40 }, side: { y: 92, hw: 48 }, neck: 122, bottom: 138,
    belly: null, zone: [34, 44, 92, 92],
    limbs: true,
    detail: () => (
      <g aria-hidden="true" className="fg-seams">
        <path d="M32 64 H128" />
        <circle cx="42" cy="53" r="2.2" />
        <circle cx="118" cy="53" r="2.2" />
      </g>
    ),
  },
  ghost: {
    id: "ghost",
    shapes: [{ t: "path", d: `M38 98 C38 62 56 36 80 36 C104 36 122 62 122 98 ${GHOST_HEM}` }],
    cy: 88, eyeDx: 17, mouthY: 108,
    ear: [50, 53.5], crown: 36,
    hat: { y: 58, hw: 33 }, side: { y: 96, hw: 42 }, neck: 119, bottom: 141,
    belly: null, zone: [40, 38, 80, 92],
    float: true,
  },
  drop: {
    id: "drop",
    shapes: [{ t: "path", d: "M80 22 C84 44 122 72 122 102 C122 126 104 142 80 142 C56 142 38 126 38 102 C38 72 76 44 80 22 Z" }],
    cy: 104, eyeDx: 16, mouthY: 123,
    ear: [57.5, 59.3], crown: 22,
    hat: { y: 70, hw: 22 }, side: { y: 108, hw: 42 }, neck: 134, bottom: 142,
    belly: null, zone: [42, 56, 76, 84],
    float: true,
    detail: () => (
      <g aria-hidden="true">
        <path d="M54 92 C52 102 56 112 62 118" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" opacity="0.4" />
        <circle cx="52" cy="82" r="2" fill="#fff" opacity="0.5" />
      </g>
    ),
  },
  gem: {
    id: "gem",
    shapes: [{ t: "path", d: "M80 24 L124 58 L124 108 L80 144 L36 108 L36 58 Z" }],
    cy: 92, eyeDx: 17, mouthY: 111,
    ear: [56, 42.7], crown: 24,
    hat: { y: 54, hw: 28 }, side: { y: 84, hw: 44 }, neck: 122, bottom: 144,
    belly: null, zone: [38, 40, 84, 98],
    float: true,
    detail: () => (
      <g aria-hidden="true" className="fg-facets">
        <path d="M36 58 L58 78 L60 50 L80 24" />
        <path d="M124 58 L102 78 L100 50 L80 24" />
        <path d="M36 108 L56 100 L58 78" />
        <path d="M124 108 L104 100 L102 78" />
        <path d="M56 100 L80 144 L104 100" />
      </g>
    ),
  },
  cloud: {
    id: "cloud",
    shapes: [
      { t: "circle", cx: 52, cy: 106, r: 26 },
      { t: "circle", cx: 82, cy: 86, r: 34 },
      { t: "circle", cx: 112, cy: 108, r: 24 },
      { t: "rect", x: 50, y: 100, w: 64, h: 32, r: 16 },
    ],
    cy: 102, eyeDx: 18, mouthY: 120,
    ear: [60, 66], crown: 52,
    hat: { y: 72, hw: 30 }, side: { y: 106, hw: 54 }, neck: 131, bottom: 132,
    belly: null, zone: [28, 54, 106, 78], shine: [64, 70],
    float: true,
  },
  shroom: {
    id: "shroom",
    shapes: [
      { t: "path", d: "M56 88 L104 88 C104 108 108 126 116 138 C100 144 60 144 44 138 C52 126 56 108 56 88 Z" },
      { t: "path", d: "M22 88 C22 54 48 30 80 30 C112 30 138 54 138 88 C138 95 130 97 122 97 L38 97 C30 97 22 95 22 88 Z", tone: "accent" },
    ],
    cy: 114, eyeDx: 12, mouthY: 129,
    ear: [34, 60], crown: 30,
    hat: { y: 54, hw: 44 }, side: { y: 110, hw: 30 }, neck: 139, bottom: 142,
    belly: null, zone: [24, 32, 112, 64], lightSpots: true, shine: [52, 52],
  },
  saucer: {
    id: "saucer",
    shapes: [
      { t: "path", d: "M52 94 C52 64 64 46 80 46 C96 46 108 64 108 94 Z" },
      { t: "path", d: "M20 106 C20 95 44 89 80 89 C116 89 140 95 140 106 C140 118 116 126 80 126 C44 126 20 118 20 106 Z" },
    ],
    cy: 72, eyeDx: 13, mouthY: 106,
    ear: [60, 58], crown: 46,
    hat: { y: 58, hw: 22 }, side: { y: 106, hw: 60 }, neck: 116, bottom: 126,
    belly: null, zone: [22, 48, 116, 76], shine: [66, 62],
    float: true,
    back: ({ id }) => (
      <g aria-hidden="true">
        <path d="M60 122 L100 122 L90 144 L70 144 Z" fill={`url(#${id}jet)`} className="fg-jet" />
      </g>
    ),
    detail: () => (
      <g aria-hidden="true" className="fg-lights">
        <circle cx="42" cy="107" r="2.6" />
        <circle cx="62" cy="113" r="2.6" />
        <circle cx="80" cy="115" r="2.6" />
        <circle cx="98" cy="113" r="2.6" />
        <circle cx="118" cy="107" r="2.6" />
      </g>
    ),
  },
  flame: {
    id: "flame",
    shapes: [{ t: "path", d: "M80 22 C84 44 114 56 118 92 C122 122 104 142 80 142 C56 142 38 122 42 92 C44 80 52 72 60 64 C62 72 66 76 72 74 C80 62 74 42 80 22 Z" }],
    cy: 106, eyeDx: 14, mouthY: 124,
    ear: [60, 70], crown: 22,
    hat: { y: 78, hw: 24 }, side: { y: 104, hw: 38 }, neck: 134, bottom: 142,
    belly: null, zone: [44, 60, 72, 80], shine: [62, 86],
    float: true,
    detail: () => (
      <path aria-hidden="true" d="M80 70 C84 86 100 94 100 112 C100 128 91 138 80 138 C69 138 60 128 60 112 C60 96 76 90 80 70 Z" className="fg-inner" />
    ),
  },
  jelly: {
    id: "jelly",
    shapes: [{ t: "path", d: "M34 86 C34 54 54 34 80 34 C106 34 126 54 126 86 C126 94 120 98 112 98 L48 98 C40 98 34 94 34 86 Z" }],
    cy: 72, eyeDx: 17, mouthY: 90,
    ear: [46, 52], crown: 34,
    hat: { y: 54, hw: 34 }, side: { y: 82, hw: 46 }, neck: 100, bottom: 142,
    belly: null, zone: [36, 36, 88, 62], shine: [58, 52],
    float: true,
    back: () => (
      <g aria-hidden="true" className="fg-tentacles">
        <path className="fg-tentacle a" d="M48 94 C42 108 54 118 46 140" />
        <path className="fg-tentacle b" d="M64 96 C60 112 70 122 64 144" />
        <path className="fg-tentacle c" d="M80 96 C84 110 76 124 82 146" />
        <path className="fg-tentacle d" d="M96 96 C100 112 90 122 96 144" />
        <path className="fg-tentacle e" d="M112 94 C118 108 106 118 114 140" />
      </g>
    ),
  },
};

export const bodyDef = (id: string): BodyDef => BODY_DEFS[id] ?? (BODY_DEFS["blob"] as BodyDef);
