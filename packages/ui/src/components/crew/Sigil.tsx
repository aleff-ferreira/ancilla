import { forwardRef, type ReactNode } from "react";
import { CheckIcon, MinusIcon, ShieldWarningIcon, WarningIcon } from "../ui/icons.js";
import { cn } from "../ui/primitives.js";
import { sigilGrid, type AgentState } from "../../model/crew.js";

export type SigilSize = 18 | 24 | 28 | 36;

export interface SigilProps {
  className?: string;
  still?: boolean;
  badge?: boolean;
  stale?: boolean;
  state?: AgentState;
  size?: SigilSize;
  name: string;
}

const CANVAS_DIMENSIONS: Record<SigilSize, number> = {
  18: 11,
  24: 15,
  28: 17,
  36: 22,
};

function resolveTileTone(agentState: AgentState): string | undefined {
  switch (agentState) {
    case "working":
      return "work";
    case "finishing":
      return "finishing";
    case "no-update":
      return "quiet";
    case "waiting-on-you":
      return "need";
    case "failed":
      return "fail";
    case "skipped":
      return "stop";
    case "planned":
      return "planned";
    case "scheduled":
      return "pending";
    case "unknown":
      return "unknown";
    default:
      return undefined;
  }
}

interface BadgeDescriptor {
  markerKind: "fail" | "stop" | "ok" | "need";
  markerIcon: ReactNode;
}

function resolveAgentBadge(currentState: AgentState, explicitlyRequested: boolean): BadgeDescriptor | null {
  if (currentState === "failed") {
    return { markerKind: "fail", markerIcon: <WarningIcon size={10} weight="fill" /> };
  }
  if (currentState === "skipped") {
    return { markerKind: "stop", markerIcon: <MinusIcon size={8} weight="bold" /> };
  }
  if (currentState === "done" && explicitlyRequested) {
    return { markerKind: "ok", markerIcon: <CheckIcon size={8} weight="bold" /> };
  }
  if (currentState === "waiting-on-you" && explicitlyRequested) {
    return { markerKind: "need", markerIcon: <ShieldWarningIcon size={8} weight="fill" /> };
  }
  return null;
}

function SigilBadgeSlot({ badgeInfo }: { badgeInfo: BadgeDescriptor | null }) {
  if (!badgeInfo) {
    return null;
  }
  const badgeCls = cn("crew-badge", badgeInfo.markerKind);
  const symbolElement = <span>{badgeInfo.markerIcon}</span>;
  return <span className={badgeCls}>{symbolElement}</span>;
}

function SigilMatrixSvg({ agentName, pixelResolution }: { agentName: string; pixelResolution: number }) {
  const binaryGrid = sigilGrid(agentName);
  const renderedPixels: ReactNode[] = [];

  for (let y = 0; y < binaryGrid.length; y++) {
    const row = binaryGrid[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x]) {
        renderedPixels.push(
          <rect
            key={`px-${x}-${y}`}
            x={x + 0.1}
            y={y + 0.1}
            width={0.8}
            height={0.8}
            rx={0.14}
          />,
        );
      }
    }
  }

  return (
    <svg width={pixelResolution} height={pixelResolution} viewBox="0 0 5 5" shapeRendering="crispEdges">
      {renderedPixels}
    </svg>
  );
}

export const Sigil = forwardRef<HTMLSpanElement, SigilProps>(function Sigil(props, ref) {
  const { name, size = 18, state = "done", stale = false, badge = false, still = false, className } = props;
  const canvasSide = CANVAS_DIMENSIONS[size];
  const activeBadge = resolveAgentBadge(state, badge);
  const sizeVariantClass = size !== 18 ? `s${size}` : undefined;
  const tileTone = resolveTileTone(state);
  const containerClasses = cn(
    "crew-sigil",
    sizeVariantClass,
    tileTone,
    stale && "stale",
    still && "still",
    className,
  );

  return (
    <span
      ref={ref}
      className={containerClasses}
      data-agent={name}
      aria-hidden={true}
    >
      <SigilMatrixSvg agentName={name} pixelResolution={canvasSide} />
      <SigilBadgeSlot badgeInfo={activeBadge} />
    </span>
  );
});
