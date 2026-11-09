import type { ReactNode } from "react";
import { touches } from "./parts.js";
import { eyeScale, type Ctx } from "./ctx.js";

/**
 * A figure's face: eyes, brows and mouth, then the markings on its body. Every eye style draws its open eye; the glad arc,
 * the closed arc and the worried brow are shared, so each mood reads the same whichever eyes were chosen. The stylesheet
 * switches them by the mood on the root (`data-mood`), the way it does for the creature among the five forms of light.
 */

interface EyeStyle {
  /** One eye, or one shape that spans the face (a visor, a single lens). */
  single?: boolean;
  /** The open eye, centred on 0,0; `id` reaches the gradients. */
  open: (id: string) => ReactNode;
  /** Path data for the glad and the closed eye, centred on 0,0. */
  happy?: string;
  closed?: string;
  /** Half the gap the glad and closed arcs sit at when the style is `single`. */
  arcDx?: number;
  /** Drawn in a bright colour (it sits on a dark ground, like a visor). */
  hot?: boolean;
}

const ARC_HAPPY = "M-7 3.4 Q0 -7 7 3.4";
const ARC_CLOSED = "M-7 -1.2 Q0 7 7 -1.2";

const EYE_STYLES: Record<string, EyeStyle> = {
  dot: {
    open: () => (
      <g className="fg-pupil">
        <ellipse rx="5.4" ry="6.6" className="fg-ink-fill" />
        <circle cx="-1.7" cy="-2.4" r="1.9" className="fg-spec" />
      </g>
    ),
  },
  oval: {
    open: () => (
      <g className="fg-pupil">
        <ellipse rx="7.2" ry="9.6" className="fg-ink-fill" />
        <circle cx="2.4" cy="-3.6" r="2.7" className="fg-spec" />
        <circle cx="-2.2" cy="3.4" r="1.2" className="fg-spec soft" />
      </g>
    ),
  },
  round: {
    open: (id) => (
      <>
        <circle r="10.6" className="fg-sclera" />
        <g className="fg-pupil">
          <circle r="7.4" fill={`url(#${id}iris)`} />
          <circle r="4" className="fg-ink-fill" />
          <circle cx="2.6" cy="-2.8" r="2.6" className="fg-spec" />
          <circle cx="-2.4" cy="2.6" r="1.2" className="fg-spec soft" />
        </g>
      </>
    ),
  },
  slit: {
    open: () => (
      <>
        <path d="M-9.4 0 Q0 -11.4 9.4 0 Q0 11.4 -9.4 0 Z" className="fg-iris-flat" />
        <g className="fg-pupil">
          <ellipse rx="2.3" ry="8.4" className="fg-ink-fill" />
          <circle cx="1.6" cy="-3" r="1.4" className="fg-spec" />
        </g>
      </>
    ),
  },
  sleepy: {
    open: () => (
      <g className="fg-pupil">
        <path d="M-8.4 0.6 A8.4 8.4 0 0 0 8.4 0.6 Z" className="fg-ink-fill" />
        <path d="M-9.6 0.6 H9.6" className="fg-lidline" />
        <circle cx="2.6" cy="3.6" r="1.7" className="fg-spec" />
      </g>
    ),
  },
  visor: {
    single: true,
    hot: true,
    arcDx: 12,
    open: () => (
      <>
        <rect x="-31" y="-9" width="62" height="18" rx="9" className="fg-visor" />
        <g className="fg-pupil">
          <rect x="-21" y="-3.4" width="11" height="6.8" rx="3.4" className="fg-led" />
          <rect x="10" y="-3.4" width="11" height="6.8" rx="3.4" className="fg-led" />
        </g>
        <rect x="-31" y="-9" width="14" height="18" rx="7" className="fg-scan" />
      </>
    ),
    happy: "M-17.5 3.4 Q-11.5 -5.6 -5.5 3.4 M5.5 3.4 Q11.5 -5.6 17.5 3.4",
    closed: "M-17.5 -1 Q-11.5 5 -5.5 -1 M5.5 -1 Q11.5 5 17.5 -1",
  },
  lens: {
    single: true,
    arcDx: 0,
    open: (id) => (
      <>
        <circle r="14" className="fg-lens-rim" />
        <g className="fg-pupil">
          <circle r="10" fill={`url(#${id}iris)`} />
          <circle r="5" className="fg-ink-fill" />
          <circle cx="3.4" cy="-3.2" r="2.8" className="fg-spec" />
        </g>
      </>
    ),
    happy: "M-9 4 Q0 -9 9 4",
    closed: "M-9 -2 Q0 8 9 -2",
  },
  pixel: {
    hot: true,
    open: () => (
      <g className="fg-pupil">
        <rect x="-5" y="-6.4" width="10" height="12.8" className="fg-ink-fill" />
        <rect x="-5" y="-6.4" width="4" height="4" className="fg-spec" />
      </g>
    ),
    happy: "M-6.4 2.6 H-3.2 V-1.4 H3.2 V2.6 H6.4",
    closed: "M-6.4 -1.8 H-3.2 V2 H3.2 V-1.8 H6.4",
  },
  ring: {
    open: () => (
      <>
        <circle r="7.6" className="fg-ring" />
        <circle r="2.8" className="fg-pupil fg-core" />
      </>
    ),
  },
  owl: {
    open: () => (
      <>
        <circle r="12.4" className="fg-goggle" />
        <g className="fg-pupil">
          <circle r="6.4" className="fg-ink-fill" />
          <circle cx="2.4" cy="-2.6" r="2.4" className="fg-spec" />
        </g>
      </>
    ),
  },
};

const styleOf = (id: string): EyeStyle => EYE_STYLES[id] ?? (EYE_STYLES["oval"] as EyeStyle);

export function Eyes({ c }: { c: Ctx }) {
  const { body, figure, id } = c;
  const style = styleOf(figure.eyes);
  const k = eyeScale(body);
  const cy = body.cy;
  const spots: number[] = style.single ? [80] : [80 - body.eyeDx, 80 + body.eyeDx];
  const arcAt: number[] = style.single ? (style.arcDx ? [80 - style.arcDx, 80 + style.arcDx] : [80]) : spots;
  const hot = style.hot ? " hot" : "";
  // A single-shape style (a visor, a lens) carries its own glad and closed shapes at its own width, so those are placed once.
  const happy = style.happy ?? ARC_HAPPY;
  const closed = style.closed ?? ARC_CLOSED;
  const arcPlaces = style.single && style.happy ? [80] : arcAt;
  return (
    <g className="fg-face" data-eyes={figure.eyes}>
      <g className="fg-eyes">
        {spots.map((x, i) => (
          <g key={i} transform={`translate(${x} ${cy}) scale(${k})`}>
            <g className="fg-eye">{style.open(id)}</g>
          </g>
        ))}
      </g>
      {arcPlaces.map((x, i) => (
        <g key={`a${i}`} transform={`translate(${x} ${cy}) scale(${k})`}>
          <path d={happy} className={`fg-happy${hot}`} />
          <path d={closed} className={`fg-closed${hot}`} />
        </g>
      ))}
      <path
        className="fg-brows"
        d={`M${80 - body.eyeDx - 8 * k} ${cy - 10 * k} L${80 - body.eyeDx + 7 * k} ${cy - 16 * k} M${80 + body.eyeDx - 7 * k} ${cy - 16 * k} L${80 + body.eyeDx + 8 * k} ${cy - 10 * k}`}
      />
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ mouths

/** Styles whose mouth does not change with the mood: a beak, a grille, and none at all. */
const FIXED_MOUTHS = new Set(["beak", "grille", "none"]);

function mouthShape(style: string): ReactNode {
  switch (style) {
    case "cat":
      return <path d="M-9.4 -1 Q-4.7 5.2 0 0 Q4.7 5.2 9.4 -1" />;
    case "flat":
      return <path d="M-5.4 1.2 H5.4" />;
    case "tiny":
      return <ellipse cy="1.2" rx="2.4" ry="2.8" className="fg-ink-fill" />;
    case "grin":
      return (
        <>
          <path d="M-11 -2 Q0 12.4 11 -2 Z" className="fg-ink-fill" />
          <path d="M-5 5.2 Q0 8 5 5.2 Q0 3.2 -5 5.2 Z" className="fg-tongue" />
        </>
      );
    case "fang":
      return (
        <>
          <path d="M-7 -1 Q0 6 7 -1" />
          <path d="M-4.8 1.8 L-3.4 6.6 L-1.8 2.8 Z M1.8 2.8 L3.4 6.6 L4.8 1.8 Z" className="fg-fang" />
        </>
      );
    case "tongue":
      return (
        <>
          <path d="M-7 -1 Q0 6 7 -1" />
          <path d="M1 3 Q0.4 9.6 5.2 8.8 Q8.6 7.8 6.4 1.8 Z" className="fg-tongue" />
        </>
      );
    case "beak":
      return (
        <>
          <path d="M-7.4 -5 Q0 -10 7.4 -5 Q4.4 4.4 0 8 Q-4.4 4.4 -7.4 -5 Z" className="fg-beak" />
          <path d="M-3.4 -5.4 Q0 -7.6 3.4 -5.4" className="fg-beak-shine" />
        </>
      );
    case "grille":
      return (
        <>
          <rect x="-12.6" y="-4.8" width="25.2" height="9.6" rx="3.2" className="fg-ink-fill" />
          <path d="M-7.6 -2.6 V2.6 M-2.5 -2.6 V2.6 M2.5 -2.6 V2.6 M7.6 -2.6 V2.6" className="fg-grille" />
        </>
      );
    case "none":
      return null;
    default:
      return <path d="M-7.4 -1 Q0 6.4 7.4 -1" />;
  }
}

export function Mouth({ c }: { c: Ctx }) {
  const { body, figure } = c;
  const fixed = FIXED_MOUTHS.has(figure.mouth);
  const y = figure.mouth === "beak" ? body.mouthY - 7 : body.mouthY;
  return (
    <g className="fg-mouth" data-mouth={figure.mouth} transform={`translate(80 ${y})`}>
      <g className={fixed ? "m-fixed" : "m-idle"}>{mouthShape(figure.mouth)}</g>
      {fixed ? null : (
        <>
          <path className="m-work" d="M-4.4 1.4 H4.4" />
          <ellipse className="m-o" cy="1.6" rx="3.6" ry="4.6" />
          <path className="m-glad" d="M-9.4 -2 Q0 13.6 9.4 -2 Z" />
          <path className="m-sad" d="M-6.4 4.4 Q0 -2 6.4 4.4" />
          <path className="m-sleep" d="M-3.2 1.6 H3.2" />
        </>
      )}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ marks

/** Markings on the body, drawn clipped to it. */
export function Marks({ c }: { c: Ctx }) {
  const { body, figure, seed } = c;
  const left = 80 - body.eyeDx;
  const right = 80 + body.eyeDx;
  const cy = body.cy;
  switch (figure.mark) {
    case "blush":
      return (
        <g className="fg-blush">
          <ellipse cx={left - 12} cy={cy + 14} rx="7.6" ry="4.6" />
          <ellipse cx={right + 12} cy={cy + 14} rx="7.6" ry="4.6" />
        </g>
      );
    case "freckles":
      return (
        <g className="fg-freckles">
          {[-1, 1].flatMap((s) => [
            <circle key={`a${s}`} cx={80 + s * (body.eyeDx + 9)} cy={cy + 12} r="1.5" />,
            <circle key={`b${s}`} cx={80 + s * (body.eyeDx + 14)} cy={cy + 9} r="1.4" />,
            <circle key={`c${s}`} cx={80 + s * (body.eyeDx + 14.5)} cy={cy + 15.5} r="1.4" />,
          ])}
        </g>
      );
    case "stripes": {
      const t = body.crown;
      return (
        <g className="fg-stripes">
          <path d={`M70 ${t + 4} L72.4 ${t + 20} M80 ${t + 2} L80 ${t + 22} M90 ${t + 4} L87.6 ${t + 20}`} />
          <path d={`M${left - 24} ${cy + 4} L${left - 9} ${cy + 7} M${left - 25} ${cy + 14} L${left - 10} ${cy + 14}`} />
          <path d={`M${right + 24} ${cy + 4} L${right + 9} ${cy + 7} M${right + 25} ${cy + 14} L${right + 10} ${cy + 14}`} />
        </g>
      );
    }
    case "spots": {
      const [zx, zy, zw, zh] = body.zone;
      return (
        <g className={`fg-spots${body.lightSpots ? " light" : ""}`}>
          {touches(seed, 7).map((p, i) => (
            <circle key={i} cx={zx + 8 + p.a * (zw - 16)} cy={zy + 8 + p.b * (zh - 16)} r={body.lightSpots ? 4 + p.c * 6 : 2.4 + p.c * 4.4} />
          ))}
        </g>
      );
    }
    case "belly":
      return body.belly ? <ellipse className="fg-belly" cx={body.belly[0]} cy={body.belly[1]} rx={body.belly[2]} ry={body.belly[3]} /> : <ellipse className="fg-belly" cx="80" cy={body.bottom - 22} rx="22" ry="14" />;
    case "mask":
      return <path className="fg-mask" d={`M${left - 17} ${cy - 3} Q80 ${cy - 17} ${right + 17} ${cy - 3} Q${right + 14} ${cy + 13} 80 ${cy + 4} Q${left - 14} ${cy + 13} ${left - 17} ${cy - 3} Z`} />;
    case "gem":
      return (
        <g className="fg-gem">
          <path d={`M80 ${body.crown + 10} L86.4 ${body.crown + 19} L80 ${body.crown + 28} L73.6 ${body.crown + 19} Z`} />
          <path d={`M73.6 ${body.crown + 19} H86.4 M80 ${body.crown + 10} L80 ${body.crown + 28}`} className="cut" />
        </g>
      );
    case "bolt":
      return <path className="fg-bolt" d={`M83 ${body.crown + 8} L74 ${body.crown + 21} H80.4 L77 ${body.crown + 33} L88 ${body.crown + 18} H81.6 Z`} />;
    case "circuit":
      return (
        <g className="fg-circuit">
          <path d={`M${left - 22} ${cy + 4} H${left - 14} L${left - 10} ${cy + 10} H${left - 3}`} />
          <path d={`M${right + 22} ${cy + 4} H${right + 14} L${right + 10} ${cy + 10} H${right + 3}`} />
          <path d={`M80 ${body.crown + 6} V${body.crown + 14} L${86} ${body.crown + 20} H${92}`} />
          <circle cx={left - 22} cy={cy + 4} r="1.9" />
          <circle cx={right + 22} cy={cy + 4} r="1.9" />
          <circle cx="92" cy={body.crown + 20} r="1.9" />
        </g>
      );
    default:
      return null;
  }
}
