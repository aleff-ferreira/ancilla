import type { ReactNode } from "react";
import type { PhaseVM } from "../../model/crew.js";
import { CheckCircleIcon, ClockCounterClockwiseIcon, MinusCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { Spinner, cn } from "../ui/primitives.js";
import { rolling } from "./CrewLine.js";
import { Strip } from "./Strip.js";

export interface PhaseRailProps {
  readonly phases: PhaseVM[];
  readonly openPhase: string | null;
  readonly finale: boolean;
  readonly stale: boolean;
  readonly sheen?: boolean;
  readonly rowsId?: string;
  onOpen: (name: string | null) => void;
}

export function railCount(phase: PhaseVM, finale: boolean): string {
  const countsTally = phase.counts;
  const allPlanned = countsTally.total > 0 && countsTally.planned === countsTally.total;
  if (allPlanned) {
    return `${countsTally.planned} planned`;
  }

  let textSummary = `${countsTally.done} of ${countsTally.total}`;
  if (finale) {
    if (countsTally.skipped > 0) textSummary += ` · ${countsTally.skipped} skipped`;
    if (countsTally.failed > 0) textSummary += ` · ${countsTally.failed} failed`;
    if (countsTally.unknown > 0) textSummary += ` · ${countsTally.unknown} not reported`;
  }
  return textSummary;
}

function PhaseIndicatorSymbol({ phase, stale }: { phase: PhaseVM; stale: boolean }) {
  const { counts, state } = phase;

  let glyphClass = "crew-g mute";
  let glyphContent: ReactNode = null;

  if (state === "planned") {
    glyphContent = <span className="hollow dash" />;
  } else if (state === "live") {
    if (stale) {
      glyphContent = <ClockCounterClockwiseIcon size={13} />;
    } else {
      glyphClass = "crew-g work";
      glyphContent = <Spinner size={10} />;
    }
  } else if (counts.failed > 0) {
    glyphClass = "crew-g fail";
    glyphContent = <WarningCircleIcon size={13} />;
  } else if (counts.skipped + counts.unknown > 0) {
    glyphContent = <MinusCircleIcon size={13} />;
  } else {
    glyphClass = "crew-g ok";
    glyphContent = <CheckCircleIcon size={13} />;
  }

  return (
    <span aria-hidden="true" className={glyphClass}>
      {glyphContent}
    </span>
  );
}

export function PhaseRail(props: PhaseRailProps) {
  const { phases, openPhase, finale, stale, sheen = false, rowsId, onOpen } = props;

  return (
    <div role="tablist" aria-label="Phases" className="crew-rail">
      {phases.map((entry) => {
        const isCurrentOpen = openPhase === entry.name;
        const segmentStatus = entry.state === "planned" ? "planned" : entry.state === "live" ? "live" : "done";
        const tallyText = railCount(entry, finale);
        const doneTag = entry.state === "planned" ? "" : " done";
        const screenReaderLabel = `${entry.name}, ${tallyText}${doneTag}`;
        const onTabClick = () => onOpen(isCurrentOpen ? null : entry.name);
        const matrixGroups = [entry.agents.map((ag) => ag.state)];

        return (
          <button
            key={entry.name}
            type="button"
            role="tab"
            aria-selected={isCurrentOpen}
            aria-label={screenReaderLabel}
            aria-controls={isCurrentOpen ? rowsId : undefined}
            tabIndex={isCurrentOpen ? 0 : -1}
            data-crew-focus="seg"
            data-phase={entry.name}
            onClick={onTabClick}
            className={cn("crew-seg", segmentStatus, isCurrentOpen && "open")}
          >
            <span className="lbl">
              <PhaseIndicatorSymbol phase={entry} stale={stale} />
              <b>{entry.name}</b>
              <span>{rolling(tallyText)}</span>
            </span>
            <Strip decorative size="rail" finale={finale} sheen={sheen} stale={stale} groups={matrixGroups} />
          </button>
        );
      })}
    </div>
  );
}
