import type { ReactNode } from "react";
import type { AgentVM } from "../../model/crew.js";
import { ArrowCounterClockwiseIcon, ChatCircleDotsIcon, CheckCircleIcon, CircleDashedIcon, ClockCounterClockwiseIcon, MinusCircleIcon, QuestionIcon, ShieldWarningIcon, StopCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { Spinner, cn } from "../ui/primitives.js";

export interface StateGlyphProps {
  className?: string;
  size?: number;
  stale?: boolean;
  agent: Pick<AgentVM, "state" | "pending" | "skippedBy" | "needs">;
}

interface GlyphDescriptor {
  tone: "mute" | "work" | "input" | "need" | "fail" | "ok";
  content: ReactNode;
}

function HollowDotMarker({ dashed = false }: { dashed?: boolean }) {
  const dotCls = dashed ? "hollow dash" : "hollow";
  return <span className={dotCls} />;
}

function resolveGlyphDescriptor(
  agent: Pick<AgentVM, "state" | "pending" | "skippedBy" | "needs">,
  staleFeed: boolean,
  iconDimension: number,
): GlyphDescriptor {
  if (staleFeed) {
    return { tone: "mute", content: <ClockCounterClockwiseIcon size={iconDimension} /> };
  }

  const { pending, state, skippedBy, needs } = agent;
  const spinnerRadius = iconDimension >= 15 ? 12 : 11;

  if (pending === "retry") {
    return { tone: "work", content: <ArrowCounterClockwiseIcon size={iconDimension} /> };
  }
  if (pending === "stop") {
    return { tone: "work", content: <Spinner size={spinnerRadius} /> };
  }

  if (state === "working" || state === "finishing") {
    return { tone: "work", content: <Spinner size={spinnerRadius} /> };
  }
  if (state === "done") {
    return { tone: "ok", content: <CheckCircleIcon size={iconDimension} /> };
  }
  if (state === "failed") {
    return { tone: "fail", content: <WarningCircleIcon size={iconDimension} /> };
  }
  if (state === "waiting-on-you") {
    const isQuestion = needs?.kind === "input";
    return isQuestion
      ? { tone: "input", content: <ChatCircleDotsIcon size={iconDimension} /> }
      : { tone: "need", content: <ShieldWarningIcon size={iconDimension} /> };
  }
  if (state === "no-update") {
    return { tone: "mute", content: <CircleDashedIcon size={iconDimension} /> };
  }
  if (state === "planned") {
    return { tone: "mute", content: <HollowDotMarker dashed /> };
  }
  if (state === "scheduled") {
    return { tone: "mute", content: <HollowDotMarker /> };
  }
  if (state === "skipped") {
    const skipSymbol = skippedBy === "run"
      ? <StopCircleIcon size={iconDimension} />
      : <MinusCircleIcon size={iconDimension} />;
    return { tone: "mute", content: skipSymbol };
  }

  return { tone: "mute", content: <QuestionIcon size={iconDimension} /> };
}

export function StateGlyph({
  agent,
  stale = false,
  size = 14,
  className,
}: StateGlyphProps) {
  const glyph = resolveGlyphDescriptor(agent, stale, size);

  return (
    <span
      className={cn("crew-g", glyph.tone, className)}
      aria-hidden="true"
    >
      {glyph.content}
    </span>
  );
}
