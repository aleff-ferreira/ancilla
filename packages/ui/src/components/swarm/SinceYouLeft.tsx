import { formatClock } from "../../model/format.js";
import type { SinceYouLeftVM } from "../../model/swarm.js";
import { ClockCounterClockwiseIcon, XCircleIcon } from "../ui/icons.js";
import { IconButton } from "../ui/primitives.js";
import { plural } from "./cardCopy.js";

export interface SinceYouLeftProps {
  recap: SinceYouLeftVM;
  /** The clock the times are read against, for today-or-not in the clock text. */
  clockAt: number;
  onDismiss: () => void;
}

/** The recap's sentence, plain, for tests and the accessible name. */
export function recapText(recap: SinceYouLeftVM, clockAt: number): string {
  return `Since you left at ${formatClock(recap.leftAt, clockAt)} · ${recapParts(recap, clockAt).join(", ")}`;
}

function recapParts(recap: SinceYouLeftVM, clockAt: number): string[] {
  const parts: string[] = [];
  if (recap.finished > 0) parts.push(`${plural(recap.finished, "agent")} finished`);
  if (recap.failed > 0) parts.push(`${plural(recap.failed, "agent")} failed`);
  if (recap.phasesStarted.length > 0) parts.push(`${joinNames(recap.phasesStarted)} ran`);
  if (recap.runFinishedAt !== null) parts.push(`the run finished at ${formatClock(recap.runFinishedAt, clockAt)}`);
  return parts;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What happened while the user was away five minutes or more, above the card, until dismissed (SPEC §14). */
export function SinceYouLeft({ recap, clockAt, onDismiss }: SinceYouLeftProps) {
  const parts = recapParts(recap, clockAt);
  return (
    <div className="swarm-recap enter-up" data-swarm-recap="" aria-label={recapText(recap, clockAt)}>
      <ClockCounterClockwiseIcon size={13} aria-hidden="true" />
      <span>
        Since you left at {formatClock(recap.leftAt, clockAt)} ·{" "}
        {parts.map((part, index) => {
          const strong = (index === 0 && recap.finished > 0) || part.startsWith("the run finished");
          const node = strong ? <b>{part.replace(/^the run /, "")}</b> : part;
          return (
            <span key={part}>
              {index > 0 ? ", " : ""}
              {part.startsWith("the run finished") ? <>the run {node}</> : node}
            </span>
          );
        })}
      </span>
      <IconButton size="xs" label="Dismiss the recap" onClick={onDismiss}>
        <XCircleIcon size={13} />
      </IconButton>
    </div>
  );
}
