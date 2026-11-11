import type { CompanionInfo } from "./companions/catalog.js";
import type { AvatarMood } from "./faces.js";
import { Overlays } from "./figure/Figure.js";

/**
 * Draws a built-in studio companion inside `<Avatar />` (160x160 viewBox):
 * - Ambient radial halo tinted by `--av-bloom` (`--h`, `--g`) so colour & glow controls light the chassis and stage.
 * - Synchronized hover shadow on the floor.
 * - Subtle 2.5D pointer-tracking lean (`--lx`, `--ly`) + optical specular glint & telemetry ring for active moods.
 */
export function CompanionSprite(props: { id: string; companion: CompanionInfo; mood: AvatarMood; stage?: boolean }) {
  const { id, companion, mood, stage = false } = props;
  const { cx, cy, r } = companion.optic;
  const box = stage ? { x: 11, y: 11, size: 138 } : { x: 15, y: 14, size: 130 };
  return (
    <g className="av-companion" clipPath={stage ? `url(#${id}cc)` : undefined}>
      <defs>
        {stage ? (
          <clipPath id={`${id}cc`}>
            <circle cx="80" cy="80" r="76.5" />
          </clipPath>
        ) : null}
        <radialGradient id={`${id}cb`} cx="50%" cy="48%" r="50%">
          <stop offset="0%" style={{ stopColor: "var(--av-bloom)" }} />
          <stop offset="62%" style={{ stopColor: "var(--av-2)", stopOpacity: 0.16 }} />
          <stop offset="100%" style={{ stopColor: "var(--av-bloom)", stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}cg`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: "var(--av-hot)", stopOpacity: 0.72 }} />
          <stop offset="55%" style={{ stopColor: "var(--av-1)", stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: "var(--av-1)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>

      {stage ? null : <ellipse cx="80" cy="148" rx="34" ry="5.2" className="cp-ground" />}
      <circle cx="80" cy={stage ? "80" : "78"} r={stage ? "72" : "68"} fill={`url(#${id}cb)`} className="av-bloom cp-aura" />

      {mood === "working" ? (
        <g className="av-o cp-orbit" aria-hidden="true">
          <circle cx="80" cy="79" r="63" className="cp-ring" />
        </g>
      ) : null}

      <g className="cp-motion">
        <g className="cp-lean">
          <image href={companion.src} x={box.x} y={box.y} width={box.size} height={box.size} preserveAspectRatio="xMidYMid meet" className="cp-img" />
          <g className="cp-optic" style={{ transformOrigin: `${cx}px ${cy}px` }} aria-hidden="true">
            <circle cx={cx} cy={cy} r={r * 1.45} fill={`url(#${id}cg)`} className="cp-glint" />
            {mood === "attention" ? <circle cx={cx} cy={cy} r={r * 1.35} className="cp-beacon" /> : null}
          </g>
        </g>
      </g>

      <Overlays />
    </g>
  );
}
