import type { ReactNode } from "react";
import type { AgentVM } from "../../model/crew.js";
import {
  ArrowCounterClockwiseIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  ClockCounterClockwiseIcon,
  MinusCircleIcon,
  QuestionIcon,
  ShieldWarningIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "../ui/icons.js";
import { Spinner, cn } from "../ui/primitives.js";

export interface StateGlyphProps {
  agent: Pick<AgentVM, "state" | "pending" | "skippedBy" | "needs">;
  /** The feed is not live: every glyph is the history one, and nothing spins. */
  stale?: boolean;
  /** Icon size in px; the ring is 11 px at 14 and 12 px at 15. */
  size?: number;
  className?: string;
}

/**
 * The status glyph beside a row: every state has its own shape, so colour never stands alone (SPEC §5.2). Decorative;
 * the row's words carry the state.
 */
export function StateGlyph({ agent, stale = false, size = 14, className }: StateGlyphProps) {
  const ring = size >= 15 ? 12 : 11;
  const glyph = (tone: string, node: ReactNode) => (
    <span className={cn("crew-g", tone, className)} aria-hidden="true">
      {node}
    </span>
  );
  if (stale) return glyph("mute", <ClockCounterClockwiseIcon size={size} />);
  if (agent.pending === "retry") return glyph("work", <ArrowCounterClockwiseIcon size={size} />);
  if (agent.pending === "stop") return glyph("work", <Spinner size={ring} />);
  switch (agent.state) {
    case "working":
    case "finishing":
      return glyph("work", <Spinner size={ring} />);
    case "no-update":
      return glyph("mute", <CircleDashedIcon size={size} />);
    case "waiting-on-you":
      return agent.needs?.kind === "input" ? glyph("input", <ChatCircleDotsIcon size={size} />) : glyph("need", <ShieldWarningIcon size={size} />);
    case "failed":
      return glyph("fail", <WarningCircleIcon size={size} />);
    case "skipped":
      return glyph("mute", agent.skippedBy === "run" ? <StopCircleIcon size={size} /> : <MinusCircleIcon size={size} />);
    case "done":
      return glyph("ok", <CheckCircleIcon size={size} />);
    case "planned":
      return glyph("mute", <span className="hollow dash" />);
    case "scheduled":
      return glyph("mute", <span className="hollow" />);
    case "unknown":
      return glyph("mute", <QuestionIcon size={size} />);
  }
}
