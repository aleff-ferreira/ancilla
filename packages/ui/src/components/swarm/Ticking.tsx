import { useEffect, useState } from "react";
import { useNow } from "../../app/context.js";
import { aboutText, durationText } from "../../model/swarm.js";
import { RollingDigits } from "../ui/sourced.js";

/**
 * A running duration. The view-model reads every clock once, at `at`; this adds the seconds since, on the one
 * 1 s timer the card allows itself, so only the clock nodes re-render each tick. A frozen clock (the feed is
 * stale, the run ended) shows the value as read, and so does a server render, which has no clock to add.
 */
export function Ticking(props: { ms: number | null; at: number; live: boolean; approx?: boolean; className?: string }) {
  const now = useNow(1000, props.live);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (props.ms === null) return null;
  const drift = props.live && mounted ? Math.max(0, now - props.at) : 0;
  const total = props.ms + drift;
  const text = props.approx ? aboutText(total) : durationText(total);
  return <RollingDigits value={text} className={props.className} />;
}
