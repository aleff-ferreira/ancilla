import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { CompanionSprite } from "./CompanionSprite.js";
import { avatarVars, particles, polygon, pointsOf, type AvatarMood, type AvatarSpec } from "./faces.js";
import { accentHue } from "./figure/parts.js";
import { Figure, Overlays } from "./figure/Figure.js";
import { describeLook, packRef, resolveLook, type RenderLook } from "./look.js";
import { usePack } from "./packs.js";
import { ImageSprite, PixelLook } from "./sprite.js";

/**
 * The assistant's face, drawn as SVG and moved by CSS (see `.av` in the stylesheet). One component, whatever it wears: a
 * sigil (five forms of light), a figure built from parts, or something the user drew or brought. It breathes and blinks
 * on its own, looks where the pointer is when asked to, reacts to what the assistant is doing in any of six moods, and a
 * transient mood (delight, concern) plays its burst again each time `burst` changes. Reduced motion holds it still, lit.
 */

export interface AvatarProps {
  spec: AvatarSpec;
  /** The name it goes by, for the reader. */
  name?: string;
  mood?: AvatarMood;
  /** Changes each time a transient mood should play again. */
  burst?: number;
  /** Pixels on a side. */
  size?: number;
  /** Follows the pointer with its eyes. */
  look?: boolean;
  /** A dark disc behind it, so it reads on any background; chips and small marks want one. */
  stage?: boolean;
  className?: string;
  /** Draw this instead of what the spec names: a drawing not yet saved, or a card in the library. */
  render?: RenderLook;
}

/** The pointer's direction from the face, eased, as two numbers from -1 to 1 on the element: the eyes read them. */
function useLook(ref: RefObject<SVGSVGElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    let frame = 0;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    const tick = () => {
      frame = 0;
      x += (tx - x) * 0.16;
      y += (ty - y) * 0.16;
      el.style.setProperty("--lx", x.toFixed(3));
      el.style.setProperty("--ly", y.toFixed(3));
      if (Math.abs(tx - x) > 0.004 || Math.abs(ty - y) > 0.004) frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      const box = el.getBoundingClientRect();
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / 240);
      tx = (dx / distance) * reach;
      ty = (dy / distance) * reach;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, enabled]);
}

export function Avatar({ spec, name = "Assistant", mood = "idle", burst = 0, size = 96, look = false, stage = false, className, render }: AvatarProps) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<SVGSVGElement>(null);
  useLook(ref, look);
  const wanted = render ? null : packRef(spec);
  const pack = usePack(wanted?.id ?? null, wanted?.rev ?? 0);
  const wears: RenderLook = render ?? resolveLook(spec, pack);
  const vars: Record<string, string | number> = { ...avatarVars(spec) };
  if (wears.kind === "figure") vars["--fa"] = accentHue(wears.figure, spec.hue);
  const style = { ...vars, width: size, height: size } as CSSProperties;
  const transient = mood === "delight" || mood === "concern";
  const root = wears.kind === "figure" ? " fg" : wears.kind === "companion" ? " cp" : wears.kind === "pixel" || wears.kind === "image" ? " pk" : "";
  return (
    <svg
      ref={ref}
      viewBox="0 0 160 160"
      role="img"
      aria-label={describeLook(spec, name, mood, wears)}
      className={`av${root}${className ? ` ${className}` : ""}`}
      data-form={wears.kind === "sigil" ? spec.form : wears.kind === "companion" ? wears.companion.id : wears.kind}
      data-look={wears.kind}
      data-mood={mood}
      data-shade={wears.kind === "figure" ? wears.figure.shade : undefined}
      data-finish={wears.kind === "figure" ? wears.figure.finish : undefined}
      style={style}
    >
      {stage ? (
        <>
          <defs>
            <radialGradient id={`${id}stg`} cx="50%" cy="22%" r="82%">
              <stop offset="0%" style={{ stopColor: "oklch(0.3 0.065 var(--h))" }} />
              <stop offset="56%" style={{ stopColor: "oklch(0.19 0.032 var(--h))" }} />
              <stop offset="100%" style={{ stopColor: "oklch(0.13 0.02 var(--h))" }} />
            </radialGradient>
          </defs>
          <circle cx="80" cy="80" r="78" fill={`url(#${id}stg)`} className="av-stage" />
        </>
      ) : null}
      {wears.kind === "sigil" ? <Sigil id={id} spec={spec} /> : null}
      {wears.kind === "companion" ? <CompanionSprite id={id} companion={wears.companion} mood={mood} stage={stage} /> : null}
      {wears.kind === "figure" ? <Figure id={id} figure={wears.figure} seed={spec.seed} /> : null}
      {wears.kind === "image" ? (
        <>
          <ImageSprite data={wears.data} mood={mood} />
          <Overlays />
        </>
      ) : null}
      {wears.kind === "pixel" ? (
        <>
          <PixelLook data={wears.data} mood={mood} />
          <Overlays />
        </>
      ) : null}
      {transient ? <Burst key={burst} mood={mood} /> : null}
    </svg>
  );
}

/** One of the five forms of light, with the gradients and clips they share. */
function Sigil({ id, spec }: { id: string; spec: AvatarSpec }) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}b`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: "var(--av-bloom)" }} />
          <stop offset="100%" style={{ stopColor: "var(--av-bloom)", stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}c`} cx="50%" cy="46%" r="55%">
          <stop offset="0%" style={{ stopColor: "var(--av-hot)" }} />
          <stop offset="55%" style={{ stopColor: "var(--av-1)" }} />
          <stop offset="100%" style={{ stopColor: "var(--av-2)" }} />
        </radialGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--av-2)", stopOpacity: 0.34 }} />
          <stop offset="100%" style={{ stopColor: "var(--av-2)", stopOpacity: 0.02 }} />
        </linearGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: "var(--av-1)" }} />
          <stop offset="100%" style={{ stopColor: "var(--av-2)" }} />
        </linearGradient>
        <radialGradient id={`${id}l`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: "oklch(0.1 0.02 var(--h))" }} />
          <stop offset="70%" style={{ stopColor: "var(--av-d)" }} />
          <stop offset="100%" style={{ stopColor: "var(--av-3)" }} />
        </radialGradient>
        <radialGradient id={`${id}i`} cx="50%" cy="50%" r="50%">
          <stop offset="30%" style={{ stopColor: "var(--av-3)" }} />
          <stop offset="75%" style={{ stopColor: "var(--av-2)" }} />
          <stop offset="100%" style={{ stopColor: "var(--av-1)" }} />
        </radialGradient>
        <clipPath id={`${id}k`}>
          <circle cx="80" cy="80" r="45" />
        </clipPath>
        <clipPath id={`${id}h`}>
          <ellipse cx="80" cy="62" rx="24" ry="29" />
          <path d="M28 136 C30 114 54 104 70 100 L90 100 C106 104 130 114 132 136 Z" />
        </clipPath>
        <pattern id={`${id}p`} width="4" height="3.4" patternUnits="userSpaceOnUse">
          <rect width="4" height="1" style={{ fill: "var(--av-1)", fillOpacity: 0.34 }} />
        </pattern>
      </defs>
      {spec.form === "halo" ? <Halo id={id} spec={spec} /> : null}
      {spec.form === "optic" ? <Optic id={id} spec={spec} /> : null}
      {spec.form === "hologram" ? <Hologram id={id} spec={spec} /> : null}
      {spec.form === "critter" ? <Critter id={id} spec={spec} /> : null}
      {spec.form === "cipher" ? <Cipher id={id} spec={spec} /> : null}
    </>
  );
}

/** A few rays and sparks, once: glad for delight, a shiver for concern. */
function Burst({ mood }: { mood: AvatarMood }) {
  const rays = Array.from({ length: 10 }, (_, i) => (i * 36 * Math.PI) / 180);
  return (
    <g className={`av-burst ${mood}`} aria-hidden="true">
      {rays.map((a, i) => (
        <line key={i} x1={80 + Math.cos(a) * 58} y1={80 + Math.sin(a) * 58} x2={80 + Math.cos(a) * 70} y2={80 + Math.sin(a) * 70} style={{ animationDelay: `${(i % 3) * 40}ms` }} />
      ))}
    </g>
  );
}

interface FormProps {
  id: string;
  spec: AvatarSpec;
}

// ------------------------------------------------------------------------------------------------ halo

function Halo({ id, spec }: FormProps) {
  const rings = spec.detail === 0 ? 2 : spec.detail === 3 ? 4 : 3;
  return (
    <g className="av-halo">
      <circle cx="80" cy="80" r="70" fill={`url(#${id}b)`} className="av-bloom" />
      <g className="av-o av-spin-a">
        <circle cx="80" cy="80" r="58" className="av-ring a" />
      </g>
      {spec.detail >= 2 ? (
        <g className="av-o av-spin-t">
          <circle cx="80" cy="80" r="65" className="av-ticks" />
        </g>
      ) : null}
      <g className="av-o av-spin-b">
        <circle cx="80" cy="80" r="46" className="av-ring b" />
        <circle cx="126" cy="80" r="3.6" className="av-bead" />
      </g>
      {rings >= 3 ? (
        <g className="av-o av-spin-c">
          <circle cx="80" cy="80" r="34" className="av-ring c" />
        </g>
      ) : null}
      {rings >= 4 ? (
        <g className="av-o av-spin-d">
          <circle cx="80" cy="80" r="24" className="av-ring d" />
        </g>
      ) : null}
      <circle cx="80" cy="80" r="21" className="av-corehalo" />
      <circle cx="80" cy="80" r="13" fill={`url(#${id}c)`} className="av-core" />
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ optic

function Optic({ id, spec }: FormProps) {
  const blades = [6, 8, 10, 12][spec.detail] ?? 8;
  return (
    <g className="av-optic">
      <circle cx="80" cy="80" r="72" fill={`url(#${id}b)`} className="av-bloom" />
      <circle cx="80" cy="80" r="64" className="av-bezel" />
      <circle cx="80" cy="80" r="60" className="av-groove" />
      <circle cx="80" cy="80" r="61" pathLength="60" className="av-notches" />
      <circle cx="80" cy="80" r="46" fill={`url(#${id}l)`} />
      <g clipPath={`url(#${id}k)`}>
        <g className="av-iris-wrap">
          <g className="av-o av-iris">
            <circle cx="80" cy="80" r="33" fill={`url(#${id}i)`} className="av-irisdisc" />
            {Array.from({ length: blades }, (_, i) => (
              <line key={i} x1="80" y1="52" x2="80" y2="66" transform={`rotate(${(i * 360) / blades} 80 80)`} className="av-blade" />
            ))}
            <circle cx="80" cy="80" r="33" className="av-irisrim" />
          </g>
          <g className="av-pupilwrap">
            <circle cx="80" cy="80" r="12.5" className="av-pupil" />
            <circle cx="75.5" cy="75.2" r="3.4" className="av-spec" />
            <circle cx="86" cy="85" r="1.4" className="av-spec2" />
          </g>
        </g>
        <rect x="30" y="38" width="100" height="3" className="av-scan" />
        <g className="av-lid top">
          <rect x="30" y="20" width="100" height="62" />
          <line x1="30" y1="82" x2="130" y2="82" />
        </g>
        <g className="av-lid bottom">
          <rect x="30" y="78" width="100" height="62" />
          <line x1="30" y1="78" x2="130" y2="78" />
        </g>
      </g>
      <circle cx="80" cy="80" r="46" className="av-lensrim" />
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ hologram

function Hologram({ id, spec }: FormProps) {
  const dots = particles(spec.seed, 7);
  const outline = "M28 136 C30 114 54 104 70 100 L90 100 C106 104 130 114 132 136";
  return (
    <g className="av-holo">
      <ellipse cx="80" cy="140" rx="46" ry="12" fill={`url(#${id}b)`} className="av-bloom" />
      <path d="M46 140 L58 84 L102 84 L114 140 Z" className="av-cone" />
      <ellipse cx="80" cy="140" rx="36" ry="7" className="av-base" />
      <ellipse cx="80" cy="140" rx="26" ry="4.6" className="av-base2" />
      <g className="av-figure">
        <ellipse cx="80" cy="62" rx="24" ry="29" fill={`url(#${id}f)`} />
        <path d={`${outline} Z`} fill={`url(#${id}f)`} />
        <g clipPath={`url(#${id}h)`}>
          <rect x="20" y="20" width="120" height="120" fill={`url(#${id}p)`} className="av-lines" />
          <rect x="20" y="0" width="120" height="14" className="av-band" />
        </g>
        <ellipse cx="80" cy="62" rx="24" ry="29" className="av-edge" />
        <path d="M70 90 L70 100 M90 90 L90 100" className="av-edge" />
        <path d={outline} className="av-edge" />
        {spec.detail === 2 || spec.detail === 3 ? <path d="M55 47 C61 30 99 30 105 47" className="av-edge strong" /> : null}
        {spec.detail === 3 ? (
          <>
            <circle cx="55" cy="64" r="5.4" className="av-edge strong cup" />
            <circle cx="105" cy="64" r="5.4" className="av-edge strong cup" />
          </>
        ) : null}
        <g className="av-eyes">
          {spec.detail === 1 ? (
            <rect x="61" y="55" width="38" height="8.5" rx="4.2" className="av-visor" />
          ) : (
            <>
              <rect x="66" y="58" width="9" height="3.6" rx="1.8" className="av-eye" />
              <rect x="85" y="58" width="9" height="3.6" rx="1.8" className="av-eye" />
              <path d="M66 61.4 Q70.5 55.6 75 61.4 M85 61.4 Q89.5 55.6 94 61.4" className="av-eyearc" />
            </>
          )}
        </g>
      </g>
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy="138" r={d.size} className="av-dot" style={{ animationDelay: `${d.delay}s`, animationDuration: `${d.duration}s` }} />
      ))}
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ critter

function Critter({ id, spec }: FormProps) {
  const ears: ReactNode =
    spec.detail === 1 ? (
      <>
        <path d="M44 66 L46 32 L70 48 Z" className="av-ear" fill={`url(#${id}s)`} />
        <path d="M116 66 L114 32 L90 48 Z" className="av-ear" fill={`url(#${id}s)`} />
        <path d="M50 58 L51 41 L63 49 Z" className="av-earin" />
        <path d="M110 58 L109 41 L97 49 Z" className="av-earin" />
      </>
    ) : spec.detail === 2 ? (
      <>
        <g className="av-twitch l">
          <ellipse cx="62" cy="28" rx="8.5" ry="26" transform="rotate(-9 62 50)" className="av-ear" fill={`url(#${id}s)`} />
          <ellipse cx="62" cy="30" rx="4" ry="17" transform="rotate(-9 62 50)" className="av-earin" />
        </g>
        <g className="av-twitch r">
          <ellipse cx="98" cy="28" rx="8.5" ry="26" transform="rotate(9 98 50)" className="av-ear" fill={`url(#${id}s)`} />
          <ellipse cx="98" cy="30" rx="4" ry="17" transform="rotate(9 98 50)" className="av-earin" />
        </g>
      </>
    ) : spec.detail === 3 ? (
      <>
        <path d="M80 42 L80 20" className="av-stalk" />
        <circle cx="80" cy="16" r="5.6" className="av-bulb" />
        <path d="M66 46 L58 30" className="av-stalk thin" />
        <circle cx="57" cy="28" r="3.2" className="av-bulb small" />
      </>
    ) : (
      <>
        <circle cx="50" cy="52" r="10" className="av-ear" fill={`url(#${id}s)`} />
        <circle cx="110" cy="52" r="10" className="av-ear" fill={`url(#${id}s)`} />
      </>
    );
  return (
    <g className="av-critter">
      <ellipse cx="80" cy="140" rx="40" ry="7" className="av-shadow" />
      <circle cx="80" cy="96" r="66" fill={`url(#${id}b)`} className="av-bloom" />
      <g className="av-hop">
        <g className="av-body">
          <ellipse cx="40" cy="106" rx="8" ry="11" className="av-arm l" fill={`url(#${id}s)`} />
          <ellipse cx="120" cy="106" rx="8" ry="11" className="av-arm r" fill={`url(#${id}s)`} />
          {ears}
          <path d="M38 100 C38 62 56 38 80 38 C104 38 122 62 122 100 C122 124 104 138 80 138 C56 138 38 124 38 100 Z" fill={`url(#${id}s)`} className="av-shell" />
          <ellipse cx="80" cy="112" rx="24" ry="19" className="av-belly" />
          <circle cx="55" cy="99" r="5.6" className="av-cheek" />
          <circle cx="105" cy="99" r="5.6" className="av-cheek" />
          <g className="av-face">
            <g className="av-eyes">
              <g className="av-eye-l">
                <ellipse cx="63" cy="86" rx="7.4" ry="9.6" className="av-ball" />
                <circle cx="65.4" cy="82.6" r="2.6" className="av-spec" />
              </g>
              <g className="av-eye-r">
                <ellipse cx="97" cy="86" rx="7.4" ry="9.6" className="av-ball" />
                <circle cx="99.4" cy="82.6" r="2.6" className="av-spec" />
              </g>
            </g>
            <path d="M58 91 Q63 84 68 91 M92 91 Q97 84 102 91" className="av-closed" />
            <g className="av-mouth">
              <path d="M72 104 Q80 111 88 104" className="m-idle" />
              <path d="M75 106.5 L85 106.5" className="m-work" />
              <ellipse cx="80" cy="108" rx="4" ry="5" className="m-o" />
              <path d="M68 102 Q80 122 92 102 Z" className="m-glad" />
              <path d="M72 109 Q80 102 88 109" className="m-sad" />
            </g>
            <path d="M54 79 L70 72 M106 79 L90 72" className="av-brows" />
          </g>
        </g>
      </g>
      <g className="av-think">
        <circle cx="118" cy="40" r="2.2" />
        <circle cx="127" cy="31" r="3" />
        <circle cx="138" cy="21" r="4" />
      </g>
      <text x="116" y="34" className="av-z a">z</text>
      <text x="128" y="22" className="av-z b">Z</text>
      <path d="M112 44 L112 54 M112 58 L112 60" className="av-bang" />
    </g>
  );
}

// ------------------------------------------------------------------------------------------------ cipher

function Cipher({ id, spec }: FormProps) {
  const sides = [3, 4, 5, 6][spec.detail] ?? 5;
  const outer = polygon(sides, 56);
  const inner = polygon(sides, 33, Math.PI / sides);
  return (
    <g className="av-cipher">
      <circle cx="80" cy="80" r="70" fill={`url(#${id}b)`} className="av-bloom" />
      <circle cx="80" cy="80" r="66" pathLength="72" className="av-ticks fine" />
      <g className="av-o av-spin-slow">
        <polygon points={pointsOf(outer)} className="av-poly ghost" />
        <polygon points={pointsOf(outer)} className="av-poly" />
        {outer.map(([x, y], i) => (
          <line key={`s${i}`} x1="80" y1="80" x2={x} y2={y} className="av-spoke" />
        ))}
        {outer.map(([x, y], i) => (
          <circle key={`n${i}`} cx={x} cy={y} r="3.4" className="av-node" style={{ animationDelay: `${i * 0.22}s` }} />
        ))}
      </g>
      <g className="av-o av-spin-rev">
        <polygon points={pointsOf(inner)} className="av-poly inner" />
        {inner.map(([x, y], i) => (
          <circle key={`i${i}`} cx={x} cy={y} r="2" className="av-node small" style={{ animationDelay: `${i * 0.18 + 0.4}s` }} />
        ))}
      </g>
      <circle cx="80" cy="80" r="12" className="av-pupilring" />
      <circle cx="80" cy="80" r="5" fill={`url(#${id}c)`} className="av-core" />
    </g>
  );
}
