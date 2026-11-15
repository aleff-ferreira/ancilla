import type { CSSProperties, ReactElement } from "react";
import { cn } from "../ui/primitives.js";

export interface PulseProps {
  readonly bins: readonly number[];
  readonly className?: string;
}

const SPARK_MAX_HEIGHT = 16;
const SPARK_MIN_HEIGHT = 2;

function computeSparkHeight(frequency: number, maximumFrequency: number): number {
  const normalizedFraction = frequency / maximumFrequency;
  return Math.max(SPARK_MIN_HEIGHT, Math.round(normalizedFraction * SPARK_MAX_HEIGHT));
}

/**
 * 16px mini sparkline visualization depicting activity distribution across time bins.
 * Highlights the most recent bin with the active accent color.
 */
export function Pulse({ bins, className }: PulseProps): ReactElement {
  const peakFrequency = bins.reduce((accumMax, val) => (val > accumMax ? val : accumMax), 1);
  const terminusIndex = bins.length - 1;

  return (
    <span aria-hidden="true" className={cn("inline-flex h-4 shrink-0 items-end gap-[2px]", className)}>
      {bins.map((val, position) => {
        const calculatedHeight = computeSparkHeight(val, peakFrequency);
        const isActiveBin = position === terminusIndex;
        const inlineDimension: CSSProperties = { height: `${calculatedHeight}px` };

        return (
          <span
            key={position}
            className={cn("block w-1 rounded-[1px]", isActiveBin ? "bg-accent" : "bg-subtle opacity-40")}
            style={inlineDimension}
          />
        );
      })}
    </span>
  );
}
