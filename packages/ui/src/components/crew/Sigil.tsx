import { forwardRef, type ReactNode } from "react";
import { CheckIcon, MinusIcon, ShieldWarningIcon, WarningIcon } from "../ui/icons.js";
import { cn } from "../ui/primitives.js";
import { sigilGrid, type AgentState } from "../../model/crew.js";

export type SigilSize = 18 | 24 | 28 | 36;

export interface SigilProps {
  name: string;
  /** The tile's side; the pixel grid inside scales with it (SPEC §8). */
  size?: SigilSize;
  state?: AgentState;
  /** The view is last known, not live: the tile drops its state colour and nothing breathes. */
  stale?: boolean;
  /** Also badge done and waiting (the inspector and the drawer). Failed and skipped always carry theirs. */
  badge?: boolean;
  /** Hold the mark still: it is out of view or over the breathing budget (SPEC §10: twelve at once). */
  still?: boolean;
  className?: string;
}

/** Tile side to the pixel grid's side, so each of the five cells lands on whole pixels. */
const PIXELS: Record<SigilSize, number> = { 18: 11, 24: 15, 28: 17, 36: 22 };

/** The tile carries the state; the ink never carries hue. Done is the plain tile. */
const TILE: Partial<Record<AgentState, string>> = {
  working: "work",
  finishing: "finishing",
  "no-update": "quiet",
  "waiting-on-you": "need",
  failed: "fail",
  skipped: "stop",
  planned: "planned",
  scheduled: "pending",
  unknown: "unknown",
};

/**
 * An agent's mark: a deterministic, mirrored 5×5 pixel grid from its name, the same wherever the agent
 * appears. Decorative, because the name is always beside it. The ref reaches the tile, for the breathing gate.
 */
export const Sigil = forwardRef<HTMLSpanElement, SigilProps>(function Sigil(props, ref) {
  const size = props.size ?? 18;
  const state = props.state ?? "done";
  const pixels = PIXELS[size];
  const badge = badgeFor(state, props.badge ?? false);
  return (
    <span
      ref={ref}
      className={cn("crew-sigil", size !== 18 && `s${size}`, TILE[state], props.stale && "stale", props.still && "still", props.className)}
      data-agent={props.name}
      aria-hidden="true"
    >
      <svg width={pixels} height={pixels} viewBox="0 0 5 5" shapeRendering="crispEdges">
        {sigilGrid(props.name).flatMap((row, y) =>
          row.map((lit, x) => (lit ? <rect key={`${x}-${y}`} x={x + 0.1} y={y + 0.1} width={0.8} height={0.8} rx={0.14} /> : null)),
        )}
      </svg>
      {badge ? (
        <span className={cn("crew-badge", badge.kind)}>
          <span>{badge.icon}</span>
        </span>
      ) : null}
    </span>
  );
});

function badgeFor(state: AgentState, wanted: boolean): { kind: string; icon: ReactNode } | null {
  switch (state) {
    case "failed":
      return { kind: "fail", icon: <WarningIcon size={10} weight="fill" /> };
    case "skipped":
      return { kind: "stop", icon: <MinusIcon size={8} weight="bold" /> };
    case "done":
      return wanted ? { kind: "ok", icon: <CheckIcon size={8} weight="bold" /> } : null;
    case "waiting-on-you":
      return wanted ? { kind: "need", icon: <ShieldWarningIcon size={8} weight="fill" /> } : null;
    default:
      return null;
  }
}
