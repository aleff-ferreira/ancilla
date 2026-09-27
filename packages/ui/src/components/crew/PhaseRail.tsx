import type { PhaseVM } from "../../model/crew.js";
import { CheckCircleIcon, ClockCounterClockwiseIcon, MinusCircleIcon, WarningCircleIcon } from "../ui/icons.js";
import { Spinner, cn } from "../ui/primitives.js";
import { rolling } from "./CrewLine.js";
import { Strip } from "./Strip.js";

export interface PhaseRailProps {
  phases: PhaseVM[];
  /** Exactly one phase open, or none. */
  openPhase: string | null;
  /** The run ended: done cells turn ok and the labels may add what did not land. */
  finale: boolean;
  stale: boolean;
  /** Play the one sheen along the done cells (the finale, once). */
  sheen?: boolean;
  /** The id of the rows region a segment controls. */
  rowsId?: string;
  onOpen: (name: string | null) => void;
}

/** What a segment's label says beside the phase's name: `4 of 4`, `1 planned`, in the finale `2 of 3 · 1 skipped`. */
export function railCount(phase: PhaseVM, finale: boolean): string {
  const { counts } = phase;
  if (counts.total > 0 && counts.planned === counts.total) return `${counts.planned} planned`;
  let text = `${counts.done} of ${counts.total}`;
  if (finale) {
    if (counts.skipped > 0) text += ` · ${counts.skipped} skipped`;
    if (counts.failed > 0) text += ` · ${counts.failed} failed`;
    if (counts.unknown > 0) text += ` · ${counts.unknown} not reported`;
  }
  return text;
}

function Glyph({ phase, stale }: { phase: PhaseVM; stale: boolean }) {
  const { counts, state } = phase;
  if (state === "planned") return <span className="crew-g mute" aria-hidden="true"><span className="hollow dash" /></span>;
  if (state === "live") {
    return stale ? (
      <span className="crew-g mute" aria-hidden="true"><ClockCounterClockwiseIcon size={13} /></span>
    ) : (
      <span className="crew-g work" aria-hidden="true"><Spinner size={10} /></span>
    );
  }
  if (counts.failed > 0) return <span className="crew-g fail" aria-hidden="true"><WarningCircleIcon size={13} /></span>;
  if (counts.skipped + counts.unknown > 0) return <span className="crew-g mute" aria-hidden="true"><MinusCircleIcon size={13} /></span>;
  return <span className="crew-g ok" aria-hidden="true"><CheckCircleIcon size={13} /></span>;
}

/**
 * The phase rail: the strip stretched into equal-width segments, one per phase, each a tab of an accordion that
 * opens that phase's rows below the attention list. There is no caret; the open segment sits on a plate with a
 * pointer under it (SPEC §4 PhaseRailProps).
 */
export function PhaseRail({ phases, openPhase, finale, stale, sheen = false, rowsId, onOpen }: PhaseRailProps) {
  return (
    <div className="crew-rail" role="tablist" aria-label="Phases">
      {phases.map((phase) => {
        const open = openPhase === phase.name;
        const segmentClass = phase.state === "planned" ? "planned" : phase.state === "live" ? "live" : "done";
        const count = railCount(phase, finale);
        return (
          <button
            key={phase.name}
            type="button"
            role="tab"
            aria-selected={open}
            aria-controls={open ? rowsId : undefined}
            aria-label={`${phase.name}, ${count}${phase.state === "planned" ? "" : " done"}`}
            tabIndex={open ? 0 : -1}
            data-crew-focus="seg"
            data-phase={phase.name}
            className={cn("crew-seg", segmentClass, open && "open")}
            onClick={() => onOpen(open ? null : phase.name)}
          >
            <span className="lbl">
              <Glyph phase={phase} stale={stale} />
              <b>{phase.name}</b>
              <span>{rolling(count)}</span>
            </span>
            <Strip groups={[phase.agents.map((agent) => agent.state)]} size="rail" finale={finale} sheen={sheen} stale={stale} decorative />
          </button>
        );
      })}
    </div>
  );
}
