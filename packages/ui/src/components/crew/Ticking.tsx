import { useEffect, useState } from "react";
import { useNow } from "../../app/context.js";
import { aboutText, durationText } from "../../model/crew.js";
import { RollingDigits } from "../ui/sourced.js";

/**
 * Calculates drift elapsed since the reference timestamp on client mounts.
 */
function useTimerOffset(anchorTimestamp: number, active: boolean): number {
  const currentTick = useNow(1000, active);
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  if (!active || !hasHydrated) {
    return 0;
  }
  return Math.max(0, currentTick - anchorTimestamp);
}

/**
 * Renders a dynamically updating wall-clock duration with rolling digit transitions.
 */
export function Ticking(props: {
  ms: number | null;
  at: number;
  live: boolean;
  approx?: boolean;
  className?: string;
}) {
  const { ms, at, live, approx = false, className } = props;
  const driftOffset = useTimerOffset(at, live);

  if (ms === null) {
    return null;
  }

  const netDuration = ms + driftOffset;
  const label = approx ? aboutText(netDuration) : durationText(netDuration);

  return <RollingDigits value={label} className={className} />;
}
