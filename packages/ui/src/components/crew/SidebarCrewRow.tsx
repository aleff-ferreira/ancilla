import { CircleDashedIcon, ShieldWarningIcon, TerminalWindowIcon, WarningCircleIcon } from "../ui/icons.js";
import { useMemo, type ReactNode } from "react";
import { useApp } from "../../app/context.js";
import type { ThreadFold } from "../../model/fold.js";
import type { ThreadStatus } from "../../model/status.js";
import type { AppState, ThreadState } from "../../model/store.js";
import { sidebarCrewSummary, crewBusy, crewTurnKey, type SidebarCrewSummary } from "../../model/crew.js";
import type { SessionSummary } from "../../types.js";
import { cn } from "../ui/primitives.js";
import { Strip } from "./Strip.js";

export interface SidebarCrewRowProps {
  summary: SidebarCrewSummary | null;
}

export const SIDEBAR_BIN_AT = 24;
export const SIDEBAR_BIN_WIDTH = 72;

function MetricCounterBadge({
  countValue,
  narrativeDescription,
  indicatorSymbol,
  toneClass,
}: {
  countValue: number;
  narrativeDescription: string;
  indicatorSymbol: ReactNode;
  toneClass: string;
}) {
  if (countValue <= 0) {
    return null;
  }
  return (
    <span className={cn("flex shrink-0 items-center gap-[3px] font-medium", toneClass)}>
      {indicatorSymbol}
      {countValue}
      <span className="sr-only"> {narrativeDescription}</span>
    </span>
  );
}

function TaskCommandLabel({ commandString }: { commandString: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TerminalWindowIcon size={11} className="shrink-0" aria-hidden="true" />
      <span className="truncate font-mono">{commandString}</span>
    </span>
  );
}

function SidebarStripTelemetry({
  groups,
  isLanded,
  stale,
}: {
  groups: SidebarCrewSummary["groups"];
  isLanded: boolean;
  stale: boolean;
}) {
  return (
    <Strip
      groups={groups}
      binWidth={SIDEBAR_BIN_WIDTH}
      binAt={SIDEBAR_BIN_AT}
      bin="run"
      size="xs"
      finale={isLanded}
      stale={stale}
    />
  );
}

export function SidebarCrewRow({ summary }: SidebarCrewRowProps) {
  if (!summary) {
    return null;
  }

  const hasAnyStripCells = summary.groups.some((phaseCells) => phaseCells.length > 0);
  const isLandedExecution = !summary.live && summary.endedAt !== null;
  const taskElement = summary.task ? <TaskCommandLabel commandString={summary.task} /> : null;

  return (
    <span
      data-crew-row=""
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs leading-4 whitespace-nowrap text-subtle tabular-nums"
    >
      {hasAnyStripCells ? (
        <>
          <SidebarStripTelemetry
            groups={summary.groups}
            isLanded={isLandedExecution}
            stale={summary.stale}
          />
          <span className="truncate">{summary.text}</span>
          <MetricCounterBadge
            countValue={summary.needs > 1 ? summary.needs : 0}
            narrativeDescription="need you"
            indicatorSymbol={<ShieldWarningIcon size={10} aria-hidden="true" />}
            toneClass="text-warn-text"
          />
          <MetricCounterBadge
            countValue={summary.failed}
            narrativeDescription="failed"
            indicatorSymbol={<WarningCircleIcon size={10} aria-hidden="true" />}
            toneClass="text-danger-text"
          />
          <MetricCounterBadge
            countValue={summary.noUpdate}
            narrativeDescription="no update"
            indicatorSymbol={<CircleDashedIcon size={10} aria-hidden="true" />}
            toneClass="text-subtle"
          />
          {taskElement}
        </>
      ) : (
        taskElement ?? <span className="truncate">{summary.text}</span>
      )}
    </span>
  );
}

export function sidebarLineShown(
  summary: SidebarCrewSummary,
  status: ThreadStatus,
  busy: boolean,
): boolean {
  if (summary.live || busy) {
    return true;
  }
  const hasEnded = summary.endedAt !== null;
  const isUnseenOrBroken = status === "unread" || status === "failed";
  return isUnseenOrBroken && hasEnded;
}

interface ThreadCrewStateSubset {
  foldSnapshot: ThreadFold;
  agentItemsList: ThreadFold["agentItems"];
  crewMap: ThreadFold["crew"];
  approvalsList: ThreadFold["approvals"];
  userInputsList: ThreadFold["userInputs"];
  researchRunsCollection: ThreadState["researchRuns"];
  isActivelyBusy: boolean;
  isStaleFeed: boolean;
  computedTurnKey: string;
}

function verifyFoldLiveness(rootState: AppState, activeThread: ThreadState): boolean {
  const isNetworkConnected = rootState.connection === "open";
  const isFoldOpen = !activeThread.fold.closed;
  const hasLoadedItems = activeThread.load === "ready" || activeThread.fold.order.length > 0;
  return isNetworkConnected && isFoldOpen && activeThread.stale !== true && hasLoadedItems;
}

function areSubsetPartsIdentical(
  first: ThreadCrewStateSubset | null,
  second: ThreadCrewStateSubset | null,
): boolean {
  if (first === second) return true;
  if (!first || !second) return false;

  return (
    first.agentItemsList === second.agentItemsList &&
    first.crewMap === second.crewMap &&
    first.approvalsList === second.approvalsList &&
    first.userInputsList === second.userInputsList &&
    first.researchRunsCollection === second.researchRunsCollection &&
    first.isActivelyBusy === second.isActivelyBusy &&
    first.computedTurnKey === second.computedTurnKey &&
    first.isStaleFeed === second.isStaleFeed
  );
}

export function useSidebarCrew(
  session: SessionSummary,
  status: ThreadStatus,
  now: number,
): SidebarCrewSummary | null {
  const currentSessionId = session.sessionId;
  const isSessionLive = session.live;

  const crewStateParts = useApp((stateSnapshot): ThreadCrewStateSubset | null => {
    const threadRecord = stateSnapshot.threads[currentSessionId];
    if (!threadRecord) {
      return null;
    }

    const threadFold = threadRecord.fold;
    const isThreadBusy = crewBusy(threadFold, threadRecord.researchRuns);
    const isFeedStale = isThreadBusy && !verifyFoldLiveness(stateSnapshot, threadRecord);

    return {
      foldSnapshot: threadFold,
      agentItemsList: threadFold.agentItems,
      crewMap: threadFold.crew,
      approvalsList: threadFold.approvals,
      userInputsList: threadFold.userInputs,
      researchRunsCollection: threadRecord.researchRuns,
      isActivelyBusy: isThreadBusy,
      computedTurnKey: crewTurnKey(threadFold),
      isStaleFeed: isFeedStale,
    };
  }, areSubsetPartsIdentical);

  return useMemo(() => {
    if (!crewStateParts) {
      return null;
    }

    const calculatedSummary = sidebarCrewSummary(
      crewStateParts.foldSnapshot,
      isSessionLive,
      now,
      {
        sessionId: currentSessionId,
        stale: crewStateParts.isStaleFeed,
        researchRuns: crewStateParts.researchRunsCollection,
      },
    );

    if (calculatedSummary && sidebarLineShown(calculatedSummary, status, crewStateParts.isActivelyBusy)) {
      return calculatedSummary;
    }
    return null;
  }, [crewStateParts, isSessionLive, currentSessionId, status, now]);
}
