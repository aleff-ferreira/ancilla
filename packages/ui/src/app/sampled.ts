import { useEffect, useRef, useState } from "react";

/**
 * Throttles high-frequency text updates during live streaming.
 * Periodically updates an internal snapshot every `intervalMs` when `active`,
 * preventing excessive re-parsing of large markdown documents. Immediately
 * synchronizes with latest text once streaming becomes inactive.
 */
export function useSampledText(text: string, active: boolean, intervalMs: number): string {
  const latestRef = useRef<string>(text);
  latestRef.current = text;

  const [snapshot, setSnapshot] = useState<string>(text);

  useEffect(() => {
    setSnapshot(latestRef.current);
    if (!active) {
      return;
    }

    const timer = setInterval(() => {
      setSnapshot(latestRef.current);
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs]);

  return active ? snapshot : text;
}

/**
 * Periodically samples a rapidly changing numerical metric (e.g., token throughput or speed)
 * on a stable 1000ms cadence while `enabled` to prevent UI flicker.
 */
export function useSampled(read: () => number | null, enabled: boolean): number | null {
  const readRef = useRef(read);
  readRef.current = read;

  const [metric, setMetric] = useState<number | null>(() => (enabled ? read() : null));

  useEffect(() => {
    if (!enabled) {
      setMetric(null);
      return;
    }

    setMetric(readRef.current());
    const intervalId = setInterval(() => {
      setMetric(readRef.current());
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [enabled]);

  return metric;
}
