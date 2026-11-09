import type { ReactNode } from "react";
import type { Ctx } from "./ctx.js";

/**
 * What a figure wears or grows on top: ears, horns, antennae, hats. A top is drawn in the left half and mirrored where it
 * comes in pairs, from the body's own anchors, so the same ear sits right on a round body and on a wide one. Ears and
 * antennae sit behind the body (their roots hide under it); hats and crowns sit in front.
 */

/** Which layer each top is drawn in: behind the body, or in front of it. */
const LAYER: Record<string, "back" | "front"> = {
  round: "back", cat: "back", fox: "back", bunny: "back", horns: "back", antenna: "back", twin: "back", sprout: "back", tuft: "back",
  crown: "front", halo: "front", beanie: "front", wizard: "front", flame: "front", mohawk: "front", bow: "front",
};

/** A shape drawn on the left and again, mirrored, on the right. */
export function Pair({ children }: { children: ReactNode }) {
  return (
    <>
      <g>{children}</g>
      <g transform="translate(160 0) scale(-1 1)">{children}</g>
    </>
  );
}

const star4 = (cx: number, cy: number, s: number): string =>
  `M${cx} ${cy - s} L${cx + s * 0.28} ${cy - s * 0.28} L${cx + s} ${cy} L${cx + s * 0.28} ${cy + s * 0.28} L${cx} ${cy + s} L${cx - s * 0.28} ${cy + s * 0.28} L${cx - s} ${cy} L${cx - s * 0.28} ${cy - s * 0.28} Z`;

function drawTop(c: Ctx): ReactNode {
  const { id, body, figure } = c;
  const [ex, ey] = body.ear;
  const bg = `url(#${id}bg)`;
  const ag = `url(#${id}ag)`;
  const crown = body.crown;
  const hat = body.hat;
  switch (figure.top) {
    case "round":
      return (
        <Pair>
          <g className="fg-ear">
            <circle cx={ex - 2} cy={ey - 5} r="11.5" fill={bg} className="fg-part" />
            <circle cx={ex - 2} cy={ey - 5} r="6" className="fg-ear-in" />
          </g>
        </Pair>
      );
    case "cat":
      return (
        <Pair>
          <g className="fg-ear">
            <path d={`M${ex - 12} ${ey + 11} L${ex - 9} ${ey - 27} L${ex + 19} ${ey - 3} Z`} fill={bg} className="fg-part" />
            <path d={`M${ex - 7} ${ey + 5} L${ex - 6} ${ey - 18} L${ex + 10} ${ey - 4} Z`} className="fg-ear-in" />
          </g>
        </Pair>
      );
    case "fox":
      return (
        <Pair>
          <g className="fg-ear">
            <path d={`M${ex - 10} ${ey + 11} L${ex - 13} ${ey - 38} L${ex + 21} ${ey - 5} Z`} fill={bg} className="fg-part" />
            <path d={`M${ex - 6} ${ey + 4} L${ex - 8} ${ey - 24} L${ex + 9} ${ey - 5} Z`} className="fg-ear-in" />
            <path d={`M${ex - 13} ${ey - 38} L${ex - 12.4} ${ey - 25} L${ex + 3.6} ${ey - 21.6} Z`} className="fg-tip" />
          </g>
        </Pair>
      );
    case "bunny":
      return (
        <Pair>
          <g className="fg-ear">
            <g transform={`rotate(-9 ${ex} ${ey})`}>
              <ellipse cx={ex + 1} cy={ey - 24} rx="8.6" ry="27" fill={bg} className="fg-part" />
              <ellipse cx={ex + 1} cy={ey - 22} rx="4" ry="19" className="fg-ear-in" />
            </g>
          </g>
        </Pair>
      );
    case "horns":
      return (
        <Pair>
          <path
            d={`M${ex + 4} ${ey + 4} C${ex - 10} ${ey - 4} ${ex - 12} ${ey - 18} ${ex - 4} ${ey - 28} C${ex - 2} ${ey - 16} ${ex + 8} ${ey - 10} ${ex + 14} ${ey - 4} Z`}
            fill={ag}
            className="fg-part-a"
          />
        </Pair>
      );
    case "antenna":
      return (
        <g className="fg-antenna">
          <path d={`M80 ${crown + 8} L80 ${crown - 16}`} className="fg-stalk" />
          <circle cx="80" cy={crown - 21} r="6" className="fg-bulb" />
        </g>
      );
    case "twin":
      return (
        <g className="fg-antenna">
          <Pair>
            <path d={`M66 ${crown + 6} Q58 ${crown - 6} 56 ${crown - 17}`} className="fg-stalk" />
            <circle cx="55.6" cy={crown - 21} r="4.6" className="fg-bulb" />
          </Pair>
        </g>
      );
    case "sprout":
      return (
        <g className="fg-sprout">
          <path d={`M80 ${crown + 6} Q79 ${crown - 6} 82 ${crown - 13}`} className="fg-stalk thin" />
          <ellipse cx="91" cy={crown - 16} rx="9.4" ry="4.6" transform={`rotate(-26 91 ${crown - 16})`} fill={ag} className="fg-part-a" />
          <ellipse cx="72" cy={crown - 14} rx="8.6" ry="4.2" transform={`rotate(28 72 ${crown - 14})`} fill={ag} className="fg-part-a" />
        </g>
      );
    case "tuft":
      return (
        <g className="fg-tuft">
          <path d={`M80 ${crown + 4} C76 ${crown - 8} 86 ${crown - 13} 93 ${crown - 9}`} className="fg-hair" />
          <path d={`M76 ${crown + 3} C70 ${crown - 4} 71 ${crown - 11} 65 ${crown - 11}`} className="fg-hair thin" />
        </g>
      );
    case "crown": {
      const b = crown + 7;
      return (
        <g className="fg-crown">
          <path d={`M58 ${b} L57 ${b - 18} L68.5 ${b - 9} L80 ${b - 22} L91.5 ${b - 9} L103 ${b - 18} L102 ${b} Z`} fill={ag} className="fg-part-a" />
          <path d={`M58.4 ${b - 4} H101.6`} className="fg-band" />
          <circle cx="57" cy={b - 19.5} r="2.6" className="fg-jewel" />
          <circle cx="80" cy={b - 23.5} r="2.8" className="fg-jewel" />
          <circle cx="103" cy={b - 19.5} r="2.6" className="fg-jewel" />
        </g>
      );
    }
    case "halo":
      return <ellipse cx="80" cy={crown - 11} rx="22" ry="6.4" className="fg-halo" />;
    case "beanie": {
      const x0 = 80 - hat.hw - 2;
      const x1 = 80 + hat.hw + 2;
      const yb = hat.y + 6;
      return (
        <g className="fg-beanie">
          <path d={`M${x0} ${yb} C${x0} ${crown - 17} ${x1} ${crown - 17} ${x1} ${yb} Z`} fill={ag} className="fg-part-a" />
          <rect x={x0 - 3} y={yb - 9} width={x1 - x0 + 6} height="13" rx="5.5" className="fg-cuff" />
          <path d={`M${x0 + 6} ${yb - 7} V${yb + 2} M${x0 + 18} ${yb - 7} V${yb + 2} M80 ${yb - 7} V${yb + 2} M${x1 - 18} ${yb - 7} V${yb + 2} M${x1 - 6} ${yb - 7} V${yb + 2}`} className="fg-rib" />
          <circle cx="80" cy={crown - 12} r="7" className="fg-pom" />
        </g>
      );
    }
    case "wizard": {
      const y = hat.y;
      const hw = hat.hw;
      return (
        <g className="fg-wizard">
          <path d={`M${80 - hw + 3} ${y} C${80 - hw + 8} ${y - 24} 78 ${y - 34} 91 ${y - 52} C96 ${y - 34} ${80 + hw - 6} ${y - 18} ${80 + hw - 3} ${y} Z`} fill={ag} className="fg-part-a" />
          <ellipse cx="80" cy={y + 1} rx={hw + 11} ry="6.6" className="fg-brim" />
          <path d={`M${80 - hw + 4} ${y - 4} Q80 ${y + 3} ${80 + hw - 4} ${y - 4}`} className="fg-band" />
          <path d={star4(82, y - 24, 5.4)} className="fg-jewel" />
        </g>
      );
    }
    case "flame":
      return (
        <g className="fg-hat-flame">
          <path d={`M80 ${crown + 3} C73 ${crown - 6} 82 ${crown - 10} 79 ${crown - 22} C88 ${crown - 14} 91 ${crown - 5} 87 ${crown + 3} Z`} className="fg-fire" />
          <path d={`M80.6 ${crown + 2} C77 ${crown - 3} 82 ${crown - 6} 81 ${crown - 11} C85 ${crown - 7} 86 ${crown - 2} 83.6 ${crown + 2} Z`} className="fg-fire hot" />
        </g>
      );
    case "mohawk":
      return (
        <g>
          {[-2, -1, 0, 1, 2].map((i) => {
            const x = 80 + i * 9;
            const h = [11, 16, 21, 16, 11][i + 2] as number;
            const y = crown + Math.abs(i) * 2.6 + 2;
            return <path key={i} d={`M${x - 5.4} ${y + 5} L${x} ${y - h} L${x + 5.4} ${y + 5} Z`} fill={ag} className="fg-part-a" />;
          })}
        </g>
      );
    case "bow": {
      const bx = 160 - ex + 2;
      const by = ey - 2;
      return (
        <g className="fg-bow">
          <path d={`M${bx} ${by} L${bx + 16} ${by - 10} L${bx + 16} ${by + 10} Z`} fill={ag} className="fg-part-a" />
          <path d={`M${bx} ${by} L${bx - 16} ${by - 10} L${bx - 16} ${by + 10} Z`} fill={ag} className="fg-part-a" />
          <circle cx={bx} cy={by} r="4.2" className="fg-jewel" />
        </g>
      );
    }
    default:
      return null;
  }
}

/** The top, in the layer that was asked for: nothing when it belongs to the other one. */
export function Top({ c, layer }: { c: Ctx; layer: "back" | "front" }) {
  const top = c.figure.top;
  if (top === "none" || (LAYER[top] ?? "front") !== layer) return null;
  return (
    <g className="fg-top" data-top={top}>
      {drawTop(c)}
    </g>
  );
}
