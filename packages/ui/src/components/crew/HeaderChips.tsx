import { useEffect, useRef, useState } from "react";
import { useNow } from "../../app/context.js";
import { durationText, runLive, type RunVM, type CrewVM } from "../../model/crew.js";
import { ClockCounterClockwiseIcon, GitForkIcon, SealCheckIcon, ShieldWarningIcon } from "../ui/icons.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, MOD, Spinner } from "../ui/primitives.js";
import { RollingDigits } from "../ui/sourced.js";

export const LANDED_MS = 5000;
const DOCK_REQUEST_SELECTORS = 'section[aria-label="Approval needed"], section[aria-label="Muse has a question"]';

export function focusRequestPanel(requestId: string | null = null): boolean {
  if (typeof document === "undefined") return false;
  const targetedNode = requestId
    ? document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`)
    : null;
  const matchedSection = targetedNode ?? document.querySelector<HTMLElement>(DOCK_REQUEST_SELECTORS);
  if (!matchedSection) return false;

  matchedSection.scrollIntoView({ block: "nearest" });
  matchedSection.querySelector<HTMLElement>("button, textarea, input")?.focus();
  matchedSection.classList.remove("crew-flash");
  void matchedSection.offsetWidth;
  matchedSection.classList.add("crew-flash");
  window.setTimeout(() => matchedSection.classList.remove("crew-flash"), 400);
  return true;
}

export function NeedsYouChip(props: { count: number; onClick: () => void }) {
  const { count, onClick } = props;
  if (count <= 0) return null;
  const noun = count === 1 ? "request" : "requests";
  return (
    <button
      type="button"
      className="crew-need-chip"
      aria-label={`Needs you: ${count} ${noun}`}
      onClick={onClick}
    >
      <ShieldWarningIcon size={13} aria-hidden="true" />
      <span aria-hidden="true">
        Needs you · <RollingDigits value={String(count)} />
      </span>
    </button>
  );
}

export type CrewStatusKind = "waiting" | "working" | "landed" | "stale" | "done";

export interface CrewStatusProps {
  readonly kind: CrewStatusKind;
  readonly ms?: number | null;
  readonly live?: boolean;
  readonly at?: number;
}

export function CrewStatus(props: CrewStatusProps) {
  const nowTicks = useNow(1000, props.live === true);
  const statusState = props.kind;

  let statusClass = "crew-status";
  let statusIcon: React.ReactNode = null;
  let statusText = "";
  let durationElement: React.ReactNode = null;

  switch (statusState) {
    case "waiting":
      statusClass = "crew-status warn";
      statusIcon = <span aria-hidden="true" className="wdot attention-pulse" />;
      statusText = "Waiting for you";
      break;
    case "working": {
      const liveDelta = props.live && props.at !== undefined ? Math.max(0, nowTicks - props.at) : 0;
      const computedRunningMs = props.ms !== null && props.ms !== undefined ? props.ms + liveDelta : null;
      statusIcon = <Spinner size={12} className="text-accent-text" />;
      statusText = "Working";
      if (computedRunningMs !== null) {
        durationElement = <span className="t">{durationText(computedRunningMs)}</span>;
      }
      break;
    }
    case "landed": {
      statusClass = "crew-status ok";
      statusIcon = <SealCheckIcon size={14} aria-hidden="true" />;
      statusText = "Crew landed";
      if (props.ms !== null && props.ms !== undefined) {
        durationElement = <span className="t">{durationText(props.ms)}</span>;
      }
      break;
    }
    case "stale":
      statusIcon = <ClockCounterClockwiseIcon size={14} aria-hidden="true" className="text-subtle" />;
      statusText = "Last known";
      if (props.ms !== null && props.ms !== undefined) {
        durationElement = <span className="t">{durationText(props.ms)}</span>;
      }
      break;
    default:
      statusIcon = <SealCheckIcon className="text-subtle" size={14} aria-hidden="true" />;
      statusText = "Done";
      break;
  }

  return (
    <span className={statusClass}>
      {statusIcon}
      <span className="@max-[420px]:hidden">{statusText}</span>
      {durationElement}
    </span>
  );
}

export function CrewToggle(props: { active: boolean; count: number | null; onClick: () => void }) {
  const buttonLabel = props.active ? "Hide the Crew panel" : "Show the Crew panel";
  const agentBadge = props.count !== null && props.count > 0 ? (
    <span className="n @max-[700px]:hidden" aria-hidden="true">
      {props.count}
    </span>
  ) : null;

  const innerToggle = (
    <IconButton active={props.active} label={buttonLabel} className="crew-tog" onClick={props.onClick}>
      <GitForkIcon size={15} />
      {agentBadge}
    </IconButton>
  );

  return (
    <Tip label="Crew panel" shortcut={[MOD, "Shift", "M"]}>
      {innerToggle}
    </Tip>
  );
}

export function headerRun(view: CrewVM | null): RunVM | null {
  if (!view || !view.runs.length) return null;
  const runningRuns = view.runs.filter(runLive);
  const mostRecentLive = runningRuns[runningRuns.length - 1];
  if (mostRecentLive) return mostRecentLive;
  const allRuns = view.runs;
  return allRuns[allRuns.length - 1] ?? null;
}

export function useLanded(run: RunVM | null): boolean {
  const getInitialExpiry = () => {
    if (!run || runLive(run) || run.endedAt === null) return 0;
    const timeSinceEnd = run.clockAt - run.endedAt;
    return timeSinceEnd < LANDED_MS ? run.endedAt + LANDED_MS : 0;
  };

  const [landingExpiry, setLandingExpiry] = useState<number>(getInitialExpiry);
  const previouslyRunning = useRef(run ? runLive(run) : false);
  const stateIdentifier = run ? `${run.itemId}:${runLive(run) ? "live" : "ended"}` : "";

  useEffect(() => {
    const isLiveNow = run ? runLive(run) : false;
    if (previouslyRunning.current && !isLiveNow && run) {
      setLandingExpiry(Date.now() + LANDED_MS);
    }
    previouslyRunning.current = isLiveNow;
  }, [stateIdentifier, run]);

  const clockTime = useNow(1000, landingExpiry > Date.now());
  return landingExpiry > clockTime;
}

export function staleAge(run: RunVM, now: number): number | null {
  const staleTimestamp = run.staleAt;
  if (staleTimestamp === null) return null;
  return Math.max(0, now - staleTimestamp);
}
