import { CircleDashedIcon, ShieldWarningIcon, TerminalWindowIcon, WarningCircleIcon } from "../ui/icons.js";
import { useMemo, type ReactNode } from "react";
import { useApp } from "../../app/context.js";
import type { ThreadFold } from "../../model/fold.js";
import type { ThreadStatus } from "../../model/status.js";
import type { AppState, ThreadState } from "../../model/store.js";
import { sidebarSwarmSummary, swarmBusy, type SidebarSwarmSummary } from "../../model/swarm.js";
import type { SessionSummary } from "../../types.js";
import { cn } from "../ui/primitives.js";
import { Strip } from "./Strip.js";

export interface SidebarSwarmRowProps {
  summary: SidebarSwarmSummary | null;
}

/** Past this many agents the sidebar strip becomes one bar, this wide. */
export const SIDEBAR_BIN_AT = 24;
export const SIDEBAR_BIN_WIDTH = 72;

function Count(props: { n: number; word: string; icon: ReactNode; className: string }) {
  if (props.n === 0) {
    return null;
  }
  return (
    <span className={cn("flex shrink-0 items-center gap-[3px] font-medium", props.className)}>
      {props.icon}
      {props.n}
      <span className="sr-only"> {props.word}</span>
    </span>
  );
}

/**
 * The second line of a thread row while its agents run or have just landed: the micro strip, the phase and the
 * counts, or a background task's command when that is all the thread has. The glyph and the word on the row's
 * first line keep saying what the thread needs; this line says how far along it is.
 */
export function SidebarSwarmRow({ summary }: SidebarSwarmRowProps) {
  if (!summary) {
    return null;
  }
  const hasStrip = summary.groups.some((cells) => cells.length > 0);
  const landed = !summary.live && summary.endedAt !== null;
  const task = summary.task ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <TerminalWindowIcon size={11} className="shrink-0" aria-hidden="true" />
      <span className="truncate font-mono">{summary.task}</span>
    </span>
  ) : null;
  return (
    <span data-swarm-row="" className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs leading-4 whitespace-nowrap text-subtle tabular-nums">
      {hasStrip ? (
        <>
          <Strip
            groups={summary.groups}
            size="xs"
            bin="run"
            binAt={SIDEBAR_BIN_AT}
            binWidth={SIDEBAR_BIN_WIDTH}
            finale={landed}
            stale={summary.stale}
          />
          <span className="truncate">{summary.text}</span>
          {/* The row's glyph and word already say one request waits; the count adds something past that. */}
          <Count n={summary.needs > 1 ? summary.needs : 0} word="need you" icon={<ShieldWarningIcon size={10} aria-hidden="true" />} className="text-warn-text" />
          <Count n={summary.failed} word="failed" icon={<WarningCircleIcon size={10} aria-hidden="true" />} className="text-danger-text" />
          <Count n={summary.noUpdate} word="no update" icon={<CircleDashedIcon size={10} aria-hidden="true" />} className="text-subtle" />
          {task}
        </>
      ) : (
        task ?? <span className="truncate">{summary.text}</span>
      )}
    </span>
  );
}

/** The line shows while a run or task is live, and once one has landed until the thread is looked at. */
export function sidebarLineShown(summary: SidebarSwarmSummary, status: ThreadStatus, busy: boolean): boolean {
  return summary.live || busy || ((status === "unread" || status === "failed") && summary.endedAt !== null);
}

interface SwarmParts {
  fold: ThreadFold;
  agentItems: ThreadFold["agentItems"];
  swarm: ThreadFold["swarm"];
  approvals: ThreadFold["approvals"];
  userInputs: ThreadFold["userInputs"];
  researchRuns: ThreadState["researchRuns"];
  busy: boolean;
  stale: boolean;
}

/** Whether the fold stands for what the thread is doing now, rather than what it last saw. */
function foldLive(state: AppState, thread: ThreadState): boolean {
  return (thread.load === "ready" || thread.fold.order.length > 0) && thread.stale !== true && !thread.fold.closed && state.connection === "open";
}

/** The fold changes identity on every delta of any item; the summary only depends on these parts of it. */
function sameParts(a: SwarmParts | null, b: SwarmParts | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.agentItems === b.agentItems &&
    a.swarm === b.swarm &&
    a.approvals === b.approvals &&
    a.userInputs === b.userInputs &&
    a.researchRuns === b.researchRuns &&
    a.busy === b.busy &&
    a.stale === b.stale
  );
}

/**
 * The thread's summary for its sidebar row, null when the row has nothing to add. Only threads this client folds
 * have one (v1); the rest keep the word the server gives them. Computed again only when the fold's agent items,
 * traces or requests change, or the clock ticks.
 */
export function useSidebarSwarm(session: SessionSummary, status: ThreadStatus, now: number): SidebarSwarmSummary | null {
  const parts = useApp((s): SwarmParts | null => {
    const thread = s.threads[session.sessionId];
    if (!thread) {
      return null;
    }
    const fold = thread.fold;
    const busy = swarmBusy(fold, thread.researchRuns);
    return {
      fold,
      agentItems: fold.agentItems,
      swarm: fold.swarm,
      approvals: fold.approvals,
      userInputs: fold.userInputs,
      researchRuns: thread.researchRuns,
      busy,
      stale: busy && !foldLive(s, thread),
    };
  }, sameParts);
  const live = session.live;
  const sessionId = session.sessionId;
  return useMemo(() => {
    if (!parts) {
      return null;
    }
    const summary = sidebarSwarmSummary(parts.fold, live, now, { sessionId, stale: parts.stale, researchRuns: parts.researchRuns });
    return summary && sidebarLineShown(summary, status, parts.busy) ? summary : null;
  }, [parts, live, sessionId, status, now]);
}
