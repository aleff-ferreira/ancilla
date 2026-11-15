import type { JSX } from "react";
import { ChatCircleDotsIcon, ShieldWarningIcon, WarningCircleIcon } from "./icons.js";
import type { ThreadStatus } from "../../model/status.js";
import { Spinner, cn } from "./primitives.js";

export interface StatusGlyphProps {
  status: ThreadStatus;
  className?: string;
}

/**
 * Visual status indicator for thread state in navigation sidebars and command palettes.
 * Provides accessible icon rendering paired with textual status labels.
 */
export function StatusGlyph({ status, className }: StatusGlyphProps): JSX.Element | null {
  if (status === "running") {
    return <Spinner size={12} className={cn("text-accent-text", className)} />;
  }

  if (status === "approval") {
    return (
      <ShieldWarningIcon
        size={14}
        className={cn("attention-pulse text-warn", className)}
        aria-hidden="true"
      />
    );
  }

  if (status === "input") {
    return (
      <ChatCircleDotsIcon
        size={14}
        className={cn("attention-pulse text-warn", className)}
        aria-hidden="true"
      />
    );
  }

  if (status === "failed") {
    return (
      <WarningCircleIcon
        size={14}
        className={cn("text-danger", className)}
        aria-hidden="true"
      />
    );
  }

  if (status === "unread") {
    return (
      <span
        className={cn("block size-[7px] rounded-full bg-accent", className)}
        aria-hidden="true"
      />
    );
  }

  return null;
}
