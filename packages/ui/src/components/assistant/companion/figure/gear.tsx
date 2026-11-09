import type { ReactNode } from "react";
import { eyeScale, type Ctx } from "./ctx.js";
import { Pair } from "./tops.js";

/**
 * What a figure wears or carries: glasses, headphones, a scarf, wings, a tail. Anything that goes on the face or the neck is
 * drawn in front of the body; wings, a tail and a cape are drawn behind it and peek out at the sides.
 */

const BEHIND = new Set(["wings", "tail", "cape"]);

function drawGear(c: Ctx): ReactNode {
  const { id, body, figure } = c;
  const bg = `url(#${id}bg)`;
  const ag = `url(#${id}ag)`;
  const k = eyeScale(body);
  const cy = body.cy;
  const L = 80 - body.eyeDx;
  const R = 80 + body.eyeDx;
  const sx = 80 - body.side.hw;
  const sy = body.side.y;
  switch (figure.gear) {
    case "glasses": {
      const r = 12.6 * k;
      return (
        <g className="fg-glasses">
          <circle cx={L} cy={cy} r={r} className="fg-lensfill" />
          <circle cx={R} cy={cy} r={r} className="fg-lensfill" />
          <circle cx={L} cy={cy} r={r} className="fg-frame" />
          <circle cx={R} cy={cy} r={r} className="fg-frame" />
          <path d={`M${L + r} ${cy - 1} Q80 ${cy - 6} ${R - r} ${cy - 1}`} className="fg-frame" />
          <path d={`M${L - r} ${cy - 2} L${L - r - 7} ${cy - 4} M${R + r} ${cy - 2} L${R + r + 7} ${cy - 4}`} className="fg-frame" />
        </g>
      );
    }
    case "shades": {
      const w = 29 * k;
      const h = 17 * k;
      return (
        <g className="fg-shades">
          <rect x={L - w / 2} y={cy - h / 2 - 1} width={w} height={h} rx={6.5 * k} className="fg-shade" />
          <rect x={R - w / 2} y={cy - h / 2 - 1} width={w} height={h} rx={6.5 * k} className="fg-shade" />
          <path d={`M${L + w / 2} ${cy - 4} H${R - w / 2}`} className="fg-bridge" />
          <path d={`M${L - w / 2 + 3} ${cy - h / 2 + 2} l${6 * k} ${-0.5} M${R - w / 2 + 3} ${cy - h / 2 + 2} l${6 * k} ${-0.5}`} className="fg-glint-line" />
          <path d={`M${L - w / 2} ${cy - 3} L${L - w / 2 - 6} ${cy - 5} M${R + w / 2} ${cy - 3} L${R + w / 2 + 6} ${cy - 5}`} className="fg-bridge" />
        </g>
      );
    }
    case "monocle": {
      const r = 13.4 * k;
      return (
        <g className="fg-monocle">
          <circle cx={R} cy={cy} r={r} className="fg-lensfill" />
          <circle cx={R} cy={cy} r={r} className="fg-rim" />
          <path d={`M${R + r * 0.7} ${cy + r * 0.72} Q${R + 16} ${cy + 30} ${R + 6} ${body.neck}`} className="fg-chain" />
        </g>
      );
    }
    case "headphones": {
      const top = body.crown - 22;
      return (
        <g className="fg-headphones">
          <path d={`M${sx - 3} ${sy - 12} C${sx - 3} ${top} ${160 - sx + 3} ${top} ${160 - sx + 3} ${sy - 12}`} className="fg-band-arc" />
          <Pair>
            <rect x={sx - 11} y={sy - 17} width="15" height="28" rx="7" fill={ag} className="fg-part-a" />
            <rect x={sx - 7} y={sy - 11} width="7" height="16" rx="3.5" className="fg-cushion" />
          </Pair>
        </g>
      );
    }
    case "headset": {
      const top = body.crown - 18;
      return (
        <g className="fg-headset">
          <path d={`M${sx - 3} ${sy - 12} C${sx - 3} ${top} ${160 - sx + 3} ${top} ${160 - sx + 3} ${sy - 12}`} className="fg-band-arc thin" />
          <rect x={sx - 11} y={sy - 17} width="15" height="28" rx="7" fill={ag} className="fg-part-a" />
          <path d={`M${sx - 4} ${sy + 11} C${sx - 4} ${sy + 34} ${80 - 18} ${body.mouthY + 8} ${80 - 8} ${body.mouthY + 5}`} className="fg-boom" />
          <circle cx={80 - 8} cy={body.mouthY + 5} r="3.4" className="fg-mic" />
        </g>
      );
    }
    case "scarf": {
      const n = body.neck;
      const w = body.side.hw + 6;
      return (
        <g className="fg-scarf">
          <path d={`M${80 - w} ${n - 6} Q80 ${n + 8} ${80 + w} ${n - 6} L${80 + w} ${n + 6} Q80 ${n + 20} ${80 - w} ${n + 6} Z`} fill={ag} className="fg-part-a" />
          <path d={`M${80 + w * 0.42} ${n + 4} L${80 + w * 0.42 + 11} ${n + 28} L${80 + w * 0.42 + 1} ${n + 31} L${80 + w * 0.42 - 8} ${n + 8} Z`} fill={ag} className="fg-part-a" />
          <path d={`M${80 - w + 4} ${n} Q80 ${n + 12} ${80 + w - 4} ${n}`} className="fg-fold" />
        </g>
      );
    }
    case "bowtie": {
      const y = body.neck + 5;
      return (
        <g className="fg-bowtie">
          <path d={`M80 ${y} L65 ${y - 8} L65 ${y + 8} Z`} fill={ag} className="fg-part-a" />
          <path d={`M80 ${y} L95 ${y - 8} L95 ${y + 8} Z`} fill={ag} className="fg-part-a" />
          <rect x="76" y={y - 5.4} width="8" height="10.8" rx="3" className="fg-jewel" />
        </g>
      );
    }
    case "wings": {
      const x = sx + 6;
      const y = sy - 4;
      return (
        <Pair>
          <g className="fg-wing" style={{ transformOrigin: `${x}px ${y}px` }}>
            <path
              d={`M${x} ${y} C${x - 22} ${y - 30} ${x - 40} ${y - 14} ${x - 36} ${y + 8} C${x - 30} ${y + 2} ${x - 25} ${y + 8} ${x - 20} ${y + 15} C${x - 14} ${y + 8} ${x - 8} ${y + 12} ${x - 2} ${y + 16} Z`}
              fill={ag}
              className="fg-part-a"
            />
            <path d={`M${x - 6} ${y + 2} C${x - 16} ${y - 8} ${x - 26} ${y - 4} ${x - 30} ${y + 4}`} className="fg-fold" />
          </g>
        </Pair>
      );
    }
    case "tail": {
      const x0 = 80 + body.side.hw - 12;
      const y0 = body.bottom - 14;
      return (
        <g className="fg-tail" style={{ transformOrigin: `${x0}px ${y0}px` }}>
          <path d={`M${x0} ${y0} C${x0 + 28} ${y0 + 4} ${x0 + 42} ${y0 - 28} ${x0 + 24} ${y0 - 48} C${x0 + 22} ${y0 - 30} ${x0 + 10} ${y0 - 17} ${x0 - 8} ${y0 - 13} Z`} fill={bg} className="fg-part" />
          <path d={`M${x0 + 24} ${y0 - 48} C${x0 + 22} ${y0 - 36} ${x0 + 17} ${y0 - 28} ${x0 + 11} ${y0 - 22} C${x0 + 20} ${y0 - 26} ${x0 + 30} ${y0 - 36} ${x0 + 24} ${y0 - 48} Z`} fill={ag} className="fg-tailtip" />
        </g>
      );
    }
    case "cape": {
      const w = body.side.hw * 0.74;
      const top = body.neck - 22;
      return (
        <g className="fg-cape">
          <path d={`M${80 - w} ${top} L${80 + w} ${top} L${80 + w + 16} ${body.bottom + 4} Q80 ${body.bottom + 14} ${80 - w - 16} ${body.bottom + 4} Z`} fill={ag} className="fg-part-a" />
          <path d={`M${80 - w * 0.4} ${top + 8} L${80 - w * 0.5} ${body.bottom + 6} M${80 + w * 0.4} ${top + 8} L${80 + w * 0.5} ${body.bottom + 6}`} className="fg-fold" />
        </g>
      );
    }
    default:
      return null;
  }
}

export function Gear({ c, layer }: { c: Ctx; layer: "back" | "front" }) {
  const gear = c.figure.gear;
  if (gear === "none") return null;
  const behind = BEHIND.has(gear);
  if ((layer === "back") !== behind) return null;
  return (
    <g className="fg-gear" data-gear={gear}>
      {drawGear(c)}
    </g>
  );
}

/** Whether this gear needs the body's clip (a scarf or a bow tie must not hang off a narrow body). */
export const gearClipped = (gear: string): boolean => gear === "scarf";
