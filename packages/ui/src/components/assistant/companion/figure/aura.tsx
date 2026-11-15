import type { ReactNode } from "react";
import { touches } from "./parts.js";
import type { Ctx } from "./ctx.js";

/**
 * What surrounds a figure: a glow, sparkles, drifting petals. Auras sit behind it and are all slow, small and quiet, so a
 * busy one still leaves the face the loudest thing. Where each speck is comes from the avatar's seed, so two draws of one
 * figure agree.
 */

const star4 = (s: number): string => `M0 ${-s} L${s * 0.28} ${-s * 0.28} L${s} 0 L${s * 0.28} ${s * 0.28} L0 ${s} L${-s * 0.28} ${s * 0.28} L${-s} 0 L${-s * 0.28} ${-s * 0.28} Z`;

export function Aura({ c }: { c: Ctx }) {
  const { id, seed, figure } = c;
  const bloom = <circle cx="80" cy="90" r="72" fill={`url(#${id}b)`} className="av-bloom" />;
  let body: ReactNode = null;
  switch (figure.aura) {
    case "glow":
      body = <circle cx="80" cy="90" r="64" className="fg-glowring" />;
      break;
    case "sparkle":
      body = (
        <g>
          {touches(seed, 7).map((p, i) => {
            const a = p.a * Math.PI * 2;
            const x = 80 + Math.cos(a) * (62 + p.b * 10);
            const y = 86 + Math.sin(a) * (58 + p.b * 8);
            return <path key={i} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`} d={star4(3 + p.c * 3.4)} className="fg-spark" style={{ animationDelay: `${(p.d * 4).toFixed(2)}s` }} />;
          })}
        </g>
      );
      break;
    case "orbit":
      body = (
        <g className="fg-orbit">
          <circle cx="80" cy="90" r="70" className="fg-orbit-ring" />
          {[0, 1, 2].map((i) => {
            const a = (i * 2 * Math.PI) / 3 + 0.4;
            return <circle key={i} cx={80 + Math.cos(a) * 70} cy={90 + Math.sin(a) * 70} r={i === 0 ? 4.6 : 3} className="fg-orbit-dot" />;
          })}
        </g>
      );
      break;
    case "embers":
      body = (
        <g>
          {touches(seed, 9).map((p, i) => (
            <circle key={i} cx={42 + p.a * 76} cy="138" r={0.9 + p.b * 1.8} className="fg-ember" style={{ animationDelay: `${(p.c * 6).toFixed(2)}s`, animationDuration: `${(4 + p.d * 4).toFixed(2)}s` }} />
          ))}
        </g>
      );
      break;
    case "bubbles":
      body = (
        <g>
          {touches(seed, 7).map((p, i) => (
            <circle key={i} cx={30 + p.a * 100} cy="140" r={2.4 + p.b * 5.4} className="fg-bubble" style={{ animationDelay: `${(p.c * 7).toFixed(2)}s`, animationDuration: `${(6 + p.d * 5).toFixed(2)}s` }} />
          ))}
        </g>
      );
      break;
    case "petals":
      body = (
        <g>
          {touches(seed, 7).map((p, i) => (
            <g key={i} transform={`translate(${(20 + p.a * 120).toFixed(1)} 6)`}>
              <path d="M0 0 C4 -5 10 -3 9 3 C5 4 1 3 0 0 Z" className="fg-petal" style={{ animationDelay: `${(p.c * 8).toFixed(2)}s`, animationDuration: `${(7 + p.d * 5).toFixed(2)}s` }} />
            </g>
          ))}
        </g>
      );
      break;
    case "data":
      body = (
        <g>
          {touches(seed, 12).map((p, i) => (
            <rect key={i} x={(i % 2 === 0 ? 18 + p.a * 24 : 118 + p.a * 24).toFixed(1)} y="4" width="2.2" height={3 + p.b * 6} rx="1" className="fg-bit" style={{ animationDelay: `${(p.c * 5).toFixed(2)}s`, animationDuration: `${(2.4 + p.d * 2.6).toFixed(2)}s` }} />
          ))}
        </g>
      );
      break;
    case "notes":
      body = (
        <g>
          {touches(seed, 4).map((p, i) => (
            <g key={i} transform={`translate(${(i % 2 === 0 ? 26 + p.a * 14 : 120 + p.a * 14).toFixed(1)} 118)`}>
              <g className="fg-note" style={{ animationDelay: `${(p.c * 6).toFixed(2)}s`, animationDuration: `${(5 + p.d * 3).toFixed(2)}s` }}>
                <ellipse cx="0" cy="0" rx="3.6" ry="2.7" transform="rotate(-22)" />
                <path d="M3.2 -1 V-13 Q8 -11 8.6 -6" />
              </g>
            </g>
          ))}
        </g>
      );
      break;
    case "hearts":
      body = (
        <g>
          {touches(seed, 5).map((p, i) => (
            <g key={i} transform={`translate(${(46 + p.a * 68).toFixed(1)} 44) scale(${(0.6 + p.b * 0.5).toFixed(2)})`}>
              <path d="M0 4 C-7 -2 -7 -9 0 -6 C7 -9 7 -2 0 4 Z" className="fg-heart" style={{ animationDelay: `${(p.c * 6).toFixed(2)}s`, animationDuration: `${(4 + p.d * 3).toFixed(2)}s` }} />
            </g>
          ))}
        </g>
      );
      break;
    default:
      break;
  }
  return (
    <g className="fg-aura" data-aura={figure.aura} aria-hidden="true">
      {bloom}
      {body}
    </g>
  );
}
