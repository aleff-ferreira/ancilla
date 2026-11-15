import { formatClock } from "../../model/format.js";
import type { SinceYouLeftVM } from "../../model/crew.js";
import { ClockCounterClockwiseIcon, XCircleIcon } from "../ui/icons.js";
import { IconButton } from "../ui/primitives.js";
import { plural } from "./cardCopy.js";

export interface SinceYouLeftProps {
  onDismiss: () => void;
  clockAt: number;
  recap: SinceYouLeftVM;
}

function assemblePhaseList(phaseIdentifiers: readonly string[]): string {
  const count = phaseIdentifiers.length;
  if (count === 0) return "";
  if (count === 1) return phaseIdentifiers[0];
  const head = phaseIdentifiers.slice(0, -1).join(", ");
  const tail = phaseIdentifiers[count - 1];
  return `${head} and ${tail}`;
}

function compileRecapEntries(summary: SinceYouLeftVM, referenceClock: number): string[] {
  const segments: string[] = [];
  const { finished, failed, phasesStarted, runFinishedAt } = summary;

  if (finished > 0) {
    segments.push(`${plural(finished, "agent")} finished`);
  }
  if (failed > 0) {
    segments.push(`${plural(failed, "agent")} failed`);
  }
  if (phasesStarted.length > 0) {
    segments.push(`${assemblePhaseList(phasesStarted)} ran`);
  }
  if (runFinishedAt !== null) {
    const formattedEnd = formatClock(runFinishedAt, referenceClock);
    segments.push(`the run finished at ${formattedEnd}`);
  }
  return segments;
}

export function recapText(recap: SinceYouLeftVM, clockAt: number): string {
  const timeHeader = formatClock(recap.leftAt, clockAt);
  const narrative = compileRecapEntries(recap, clockAt).join(", ");
  return `Since you left at ${timeHeader} · ${narrative}`;
}

function RecapContentBody({
  entries,
  departureTime,
  hasFinishedAgents,
}: {
  entries: readonly string[];
  departureTime: string;
  hasFinishedAgents: boolean;
}) {
  return (
    <span>
      Since you left at {departureTime} ·{" "}
      {entries.map((entryText, itemIndex) => {
        const isRunFinish = entryText.startsWith("the run finished");
        const shouldEmphasize = (itemIndex === 0 && hasFinishedAgents) || isRunFinish;
        const renderedNode = shouldEmphasize ? <b>{entryText.replace(/^the run /, "")}</b> : entryText;
        const prefixComma = itemIndex > 0 ? ", " : "";

        return (
          <span key={entryText}>
            {prefixComma}
            {isRunFinish ? <>the run {renderedNode}</> : renderedNode}
          </span>
        );
      })}
    </span>
  );
}

function RecapDismissAction({ handleDismiss }: { handleDismiss: () => void }) {
  return (
    <IconButton size="xs" label="Dismiss the recap" onClick={handleDismiss}>
      <XCircleIcon size={13} />
    </IconButton>
  );
}

export function SinceYouLeft({ recap, clockAt, onDismiss }: SinceYouLeftProps) {
  const recapEntries = compileRecapEntries(recap, clockAt);
  const departureTimestamp = formatClock(recap.leftAt, clockAt);
  const accessibleSummary = recapText(recap, clockAt);

  return (
    <div
      className="crew-recap enter-up"
      data-crew-recap=""
      aria-label={accessibleSummary}
    >
      <ClockCounterClockwiseIcon size={13} aria-hidden="true" />
      <RecapContentBody
        entries={recapEntries}
        departureTime={departureTimestamp}
        hasFinishedAgents={recap.finished > 0}
      />
      <RecapDismissAction handleDismiss={onDismiss} />
    </div>
  );
}
