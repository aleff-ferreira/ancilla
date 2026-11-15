import type { ReactNode } from "react";
import type { FigureSpec } from "../../../../types.js";
import { Aura } from "./aura.js";
import { bodyDef, type BodyDef, type Shape, type Tone } from "./bodies.js";
import type { Ctx } from "./ctx.js";
import { Eyes, Marks, Mouth } from "./face.js";
import { Gear, gearClipped } from "./gear.js";
import { Pair, Top } from "./tops.js";
import { normalizeFigure } from "./parts.js";

/**
 * A figure, drawn: the body in its finish, the face, the parts the user chose, and the aura around it. This draws the inside
 * of the avatar's `<svg viewBox="0 0 160 160">`; the colours and every motion come from the stylesheet (`.fg` and
 * `data-mood`), so one drawing is every mood and every colour.
 */

function shapeEl(s: Shape, key: number, props: Record<string, unknown>): ReactNode {
  switch (s.t) {
    case "path":
      return <path key={key} d={s.d} {...props} />;
    case "circle":
      return <circle key={key} cx={s.cx} cy={s.cy} r={s.r} {...props} />;
    case "ellipse":
      return <ellipse key={key} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} {...props} />;
    default:
      return <rect key={key} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r ?? 0} {...props} />;
  }
}

/** The fill of a shape of this tone in this finish. */
function fillOf(finish: string, tone: Tone | undefined, id: string): Record<string, unknown> {
  const accent = tone === "accent";
  switch (finish) {
    case "glass":
      return { fill: `url(#${id}${accent ? "gla" : "gl"})` };
    case "metal":
      return { fill: `url(#${id}${accent ? "mea" : "me"})` };
    case "neon":
      return { className: "fg-fill-night" };
    case "ink":
      return { className: accent ? "fg-fill-aflat" : "fg-fill-flat" };
    default:
      return { fill: `url(#${id}${accent ? "ag" : "bg"})` };
  }
}

export function FigureDefs({ id }: { id: string }) {
  const stop = (offset: string, color: string, opacity?: number) => <stop offset={offset} style={{ stopColor: color, ...(opacity === undefined ? {} : { stopOpacity: opacity }) }} />;
  const lin = (name: string, a: string, b: string, c: string) => (
    <linearGradient id={`${id}${name}`} gradientUnits="userSpaceOnUse" x1="80" y1="28" x2="80" y2="144">
      {stop("0%", a)}
      {stop("58%", b)}
      {stop("100%", c)}
    </linearGradient>
  );
  return (
    <defs>
      <radialGradient id={`${id}b`} cx="50%" cy="50%" r="50%">
        {stop("0%", "var(--av-bloom)")}
        {stop("100%", "var(--av-bloom)", 0)}
      </radialGradient>
      {lin("bg", "var(--fg-1)", "var(--fg-2)", "color-mix(in oklab, var(--fg-2) 70%, var(--fg-3))")}
      {lin("ag", "var(--fa-1)", "var(--fa-2)", "color-mix(in oklab, var(--fa-2) 70%, var(--fa-3))")}
      <radialGradient id={`${id}sh`} gradientUnits="userSpaceOnUse" cx="106" cy="132" r="74">
        {stop("0%", "var(--fg-3)", 0.55)}
        {stop("100%", "var(--fg-3)", 0)}
      </radialGradient>
      <radialGradient id={`${id}hi`} gradientUnits="userSpaceOnUse" cx="62" cy="56" r="46">
        {stop("0%", "var(--fg-hi)", 0.62)}
        {stop("100%", "var(--fg-hi)", 0)}
      </radialGradient>
      <radialGradient id={`${id}gl`} gradientUnits="userSpaceOnUse" cx="68" cy="64" r="86">
        {stop("0%", "var(--fg-1)", 0.34)}
        {stop("100%", "var(--fg-2)", 0.7)}
      </radialGradient>
      <radialGradient id={`${id}gla`} gradientUnits="userSpaceOnUse" cx="68" cy="64" r="86">
        {stop("0%", "var(--fa-1)", 0.38)}
        {stop("100%", "var(--fa-2)", 0.72)}
      </radialGradient>
      <linearGradient id={`${id}me`} gradientUnits="userSpaceOnUse" x1="24" y1="0" x2="136" y2="0">
        {stop("0%", "var(--fg-3)")}
        {stop("22%", "var(--fg-1)")}
        {stop("40%", "var(--fg-hi)")}
        {stop("62%", "var(--fg-2)")}
        {stop("100%", "var(--fg-3)")}
      </linearGradient>
      <linearGradient id={`${id}mea`} gradientUnits="userSpaceOnUse" x1="24" y1="0" x2="136" y2="0">
        {stop("0%", "var(--fa-3)")}
        {stop("22%", "var(--fa-1)")}
        {stop("40%", "var(--fg-hi)")}
        {stop("62%", "var(--fa-2)")}
        {stop("100%", "var(--fa-3)")}
      </linearGradient>
      <radialGradient id={`${id}iris`} cx="50%" cy="50%" r="50%">
        {stop("0%", "var(--fa-1)")}
        {stop("100%", "var(--fa-3)")}
      </radialGradient>
      <linearGradient id={`${id}jet`} x1="0" y1="0" x2="0" y2="1">
        {stop("0%", "var(--fa-1)", 0.9)}
        {stop("100%", "var(--fa-1)", 0)}
      </linearGradient>
    </defs>
  );
}

/** The union of a body's shapes, as a clip for what is drawn on it. */
function BodyClip({ c }: { c: Ctx }) {
  return <clipPath id={`${c.id}k`}>{c.body.shapes.map((s, i) => shapeEl(s, i, {}))}</clipPath>;
}

/** The body itself: its fill in the chosen finish, and its outline. A body of several shapes is outlined once, around them all. */
function BodyLayer({ c }: { c: Ctx }) {
  const { body, figure, id } = c;
  const multi = body.shapes.length > 1;
  return (
    <g className="fg-bodyshape">
      {multi ? body.shapes.map((s, i) => shapeEl(s, i, { className: "fg-outline wide", fill: "none" })) : null}
      {body.shapes.map((s, i) => {
        const fill = fillOf(figure.finish, s.tone, id);
        const className = [multi ? "" : "fg-outline", fill["className"] as string | undefined].filter(Boolean).join(" ");
        return shapeEl(s, i + 10, { ...fill, className: className || undefined });
      })}
    </g>
  );
}

/** Light and shade on the body, by finish, clipped to it. */
function Shading({ c }: { c: Ctx }) {
  const { body, figure, id } = c;
  const [sx, sy] = body.shine ?? [80 - body.side.hw * 0.52, body.crown + 18];
  const rim = body.bottom - 6;
  const base = (
    <>
      <ellipse className="fg-shade-b" cx="104" cy="128" rx="64" ry="48" fill={`url(#${id}sh)`} />
    </>
  );
  switch (figure.finish) {
    case "matte":
      return (
        <>
          {base}
          <ellipse cx="64" cy="58" rx="40" ry="26" fill={`url(#${id}hi)`} opacity="0.55" />
        </>
      );
    case "plush":
      return (
        <>
          {base}
          <ellipse cx="64" cy="58" rx="40" ry="26" fill={`url(#${id}hi)`} opacity="0.45" />
          <g className="fg-stitch" transform="translate(80 90) scale(0.9) translate(-80 -90)">
            {body.shapes.slice(0, 1).map((s, i) => shapeEl(s, i, {}))}
          </g>
        </>
      );
    case "glass":
      return (
        <>
          <path d={`M${sx - 14} ${sy + 10} Q${sx - 4} ${sy - 12} ${sx + 22} ${sy - 8}`} className="fg-glass-hi" />
          <ellipse cx={sx + 26} cy={sy + 12} rx="2.4" ry="2.4" className="fg-glass-dot" />
          <path d={`M${80 - body.side.hw * 0.6} ${rim} Q80 ${rim + 12} ${80 + body.side.hw * 0.6} ${rim}`} className="fg-glass-rim" />
        </>
      );
    case "metal":
      return (
        <>
          <rect x={sx - 6} y="20" width="9" height="130" className="fg-streak" transform={`rotate(14 ${sx} 80)`} />
          <path d={`M${80 - body.side.hw * 0.7} ${body.cy - 24} H${80 + body.side.hw * 0.7}`} className="fg-metal-seam" />
        </>
      );
    case "neon":
      return <g className="fg-neon-inner" transform="translate(80 90) scale(0.86) translate(-80 -90)">{body.shapes.slice(0, 1).map((s, i) => shapeEl(s, i, {}))}</g>;
    case "ink":
      return <ellipse className="fg-ink-shade" cx="108" cy="124" rx="54" ry="44" />;
    default:
      return (
        <>
          {base}
          <ellipse cx="64" cy="58" rx="40" ry="26" fill={`url(#${id}hi)`} opacity="0.7" />
          <ellipse cx={sx} cy={sy} rx="13" ry="6.4" transform={`rotate(-28 ${sx} ${sy})`} className="fg-spec-hi" />
          <circle cx={sx + 15} cy={sy + 9} r="2.3" className="fg-spec-hi dot" />
          <path d={`M${80 - body.side.hw * 0.6} ${rim} Q80 ${rim + 8} ${80 + body.side.hw * 0.6} ${rim}`} className="fg-rim-light" />
        </>
      );
  }
}

function Limbs({ c }: { c: Ctx }) {
  const { body, id } = c;
  if (!body.limbs) return null;
  const bg = `url(#${id}bg)`;
  return (
    <>
      <Pair>
        <g className="fg-arm">
          <ellipse cx={80 - body.side.hw - 2} cy={body.side.y + 8} rx="7.4" ry="11.4" transform={`rotate(16 ${80 - body.side.hw - 2} ${body.side.y + 8})`} fill={bg} className="fg-part" />
        </g>
      </Pair>
      <Pair>
        <ellipse cx="60" cy={body.bottom - 0.5} rx="12.4" ry="6.6" className="fg-foot" />
      </Pair>
    </>
  );
}

/** What it shows of what it is doing, apart from the face: "!" when it wants you, thought dots while it works, z's asleep, a drop when worried. */
export function Overlays({ sweat }: { sweat?: [number, number] }) {
  const [sx, sy] = sweat ?? [112, 46];
  return (
    <g className="fg-overlays" aria-hidden="true">
      <g className="av-think">
        <circle cx="118" cy="40" r="2.2" />
        <circle cx="127" cy="31" r="3" />
        <circle cx="138" cy="21" r="4" />
      </g>
      <text x="116" y="34" className="av-z a">z</text>
      <text x="128" y="22" className="av-z b">Z</text>
      <path d="M118 16 L118 31 M118 37 L118 40" className="av-bang" />
      <g transform={`translate(${sx} ${sy})`}>
        <path className="av-sweat" d="M0 -7 C-4 0 -5 3 0 6 C5 3 4 0 0 -7 Z" />
      </g>
    </g>
  );
}

export interface FigureProps {
  id: string;
  figure: FigureSpec;
  seed: number;
}

export function Figure({ id, figure: raw, seed }: FigureProps) {
  const figure = normalizeFigure(raw);
  const body: BodyDef = bodyDef(figure.body);
  const c: Ctx = { id, body, figure, seed };
  return (
    <g className="fg-root" data-body={figure.body}>
      <FigureDefs id={id} />
      <defs>
        <BodyClip c={c} />
      </defs>
      <Aura c={c} />
      <ellipse cx="80" cy="147" rx={body.float ? 28 : 38} ry={body.float ? 4.4 : 6} className={body.float ? "fg-ground floaty" : "fg-ground"} />
      <g className={body.float ? "fg-float" : "fg-stand"}>
        <g className="fg-hop">
          <g className="fg-body-wrap">
            <Gear c={c} layer="back" />
            <Top c={c} layer="back" />
            <Limbs c={c} />
            {body.back ? body.back({ id }) : null}
            <BodyLayer c={c} />
            <g clipPath={`url(#${id}k)`}>
              <Shading c={c} />
              <Marks c={c} />
              {body.detail ? body.detail({ id }) : null}
              {gearClipped(figure.gear) ? <Gear c={c} layer="front" /> : null}
            </g>
            <Eyes c={c} />
            <Mouth c={c} />
            {gearClipped(figure.gear) ? null : <Gear c={c} layer="front" />}
            <Top c={c} layer="front" />
          </g>
        </g>
      </g>
      <Overlays sweat={[80 + body.eyeDx + 16, body.cy - 22]} />
    </g>
  );
}
