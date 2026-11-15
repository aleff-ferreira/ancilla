import { useState, type ReactNode, type ReactElement } from "react";
import {
  ArrowCounterClockwiseIcon,
  ChatCircleDotsIcon,
  CircleDashedIcon,
  ClockIcon,
  CodeIcon,
  EyeIcon,
  EyeSlashIcon,
  SkipForwardIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "../ui/icons.js";
import { formatTokens } from "../../model/format.js";
import {
  canStopAgent,
  durationText,
  researchCounters,
  runLive,
  usageTotal,
  type AgentVM,
  type AttemptEventVM,
  type RunVM,
} from "../../model/crew.js";
import { Button, cn } from "../ui/primitives.js";
import { RESEARCH_NO_REASON, RESEARCH_OWN } from "./cardCopy.js";
import { Sigil } from "./Sigil.js";
import {
  clockSeconds,
  longestFinished,
  measureOf,
  mostTokens,
  silenceText,
  skippedWord,
  stateTone,
  stateWord,
} from "./panel.js";
import { AgentName, RowGlyph, type RowAction, type RowConfirm } from "./RosterRow.js";

/** Copy used when Muse does not communicate a specific datum. */
export const NOT_REPORTED = "Not reported";
export const AT_RUN_END = "At run end";
export const NEAR_END = "Reported near the end of the agent";

// ============================================================================
// Lifecycle Timeline
// ============================================================================

export interface LifeItem {
  readonly key: string;
  readonly glyph: AgentVM["state"] | "retry" | "usage";
  readonly title: string;
  readonly sub: string | null;
  /** Milliseconds epoch timestamp, null if not recorded, or "now" for active tail. */
  readonly at: number | null | "now";
  readonly approx: boolean;
  readonly mute: boolean;
  readonly attempt: number;
}

function resolveAgentClassification(agent: Pick<AgentVM, "kind" | "taskInfo">): string {
  if (agent.kind === "lead") {
    return "Lead agent";
  }
  if (agent.kind === "task") {
    return agent.taskInfo?.background === false ? "Foreground tool" : "Background task";
  }
  if (agent.kind === "subagent") {
    return "Subagent";
  }
  if (agent.kind === "research") {
    return "Research worker";
  }
  return "Workflow agent";
}

function produceResearchLifeItems(agent: AgentVM): LifeItem[] {
  const researchData = agent.research;
  if (!researchData) {
    return [];
  }
  const metricCounters = researchCounters(researchData);
  if (agent.state === "scheduled") {
    return [
      {
        key: "queued",
        glyph: "scheduled",
        title: "Queued",
        sub: `${agent.phase} · waiting for a slot`,
        at: null,
        approx: false,
        mute: false,
        attempt: 1,
      },
    ];
  }

  const entries: LifeItem[] = [
    {
      key: "start",
      glyph: "working",
      title: "Started",
      sub: `${agent.phase}${researchData.discovery ? " · discovery" : ""}`,
      at: agent.startedAt,
      approx: false,
      mute: false,
      attempt: 1,
    },
  ];

  if (agent.state === "done") {
    const elapsedSuffix = agent.durationMs !== null ? ` after ${durationText(agent.durationMs)}` : "";
    entries.push({
      key: "end",
      glyph: "done",
      title: `Done${elapsedSuffix}`,
      sub: metricCounters,
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else if (agent.state === "failed") {
    const isTimeout = researchData.wireState === "timed_out";
    entries.push({
      key: "end",
      glyph: "failed",
      title: isTimeout ? "Timed out" : "Failed",
      sub: agent.failure?.text ?? RESEARCH_NO_REASON,
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else if (agent.state === "skipped") {
    entries.push({
      key: "end",
      glyph: "skipped",
      title: skippedWord(agent),
      sub: metricCounters,
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else {
    entries.push({
      key: "tail",
      glyph: "no-update",
      title: `Working · ${metricCounters}`,
      sub: "The counters move as the worker calls its tools",
      at: "now",
      approx: false,
      mute: true,
      attempt: 1,
    });
  }

  return entries;
}

function produceNonWorkflowLifeItems(agent: AgentVM): LifeItem[] {
  const resultList: LifeItem[] = [];
  const info = agent.taskInfo;
  const isForeground = info?.background === false;

  let provenanceNote: string | null = null;
  if (!isForeground) {
    if (info?.initiator === "timeout") {
      provenanceNote = "Muse backgrounded it after a timeout";
    } else if (info?.initiator === "user") {
      provenanceNote = "You sent it to the background";
    }
  }

  let initialHeading = "Spawned";
  if (agent.kind === "lead" || isForeground) {
    initialHeading = "Started";
  } else if (agent.kind === "task") {
    initialHeading = "Task started";
  }

  resultList.push({
    key: "start",
    glyph: "working",
    title: initialHeading,
    sub: provenanceNote,
    at: agent.startedAt,
    approx: agent.approx,
    mute: false,
    attempt: 1,
  });

  if (agent.kind === "task" && info?.lastOutputAt !== null && info?.lastOutputAt !== undefined) {
    resultList.push({
      key: "output",
      glyph: "usage",
      title: "Last output",
      sub: info.tail,
      at: info.lastOutputAt,
      approx: false,
      mute: true,
      attempt: 1,
    });
  }

  if (agent.state === "done") {
    let doneCaption = "Done";
    if (agent.kind === "task") {
      doneCaption = info?.exitCode === 0 ? "Finished · exit code 0" : "Finished · no failure reported";
    }
    resultList.push({
      key: "end",
      glyph: "done",
      title: doneCaption,
      sub: null,
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else if (agent.state === "failed") {
    resultList.push({
      key: "end",
      glyph: "failed",
      title: "Failed",
      sub: agent.failure?.text ?? "Muse has not reported a reason yet",
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else if (agent.state === "skipped") {
    resultList.push({
      key: "end",
      glyph: "skipped",
      title: skippedWord(agent),
      sub: null,
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else if (agent.state === "no-update") {
    resultList.push({
      key: "quiet",
      glyph: "no-update",
      title: `No output for ${silenceText(agent)}`,
      sub: "The task printed nothing in that time",
      at: "now",
      approx: false,
      mute: true,
      attempt: 1,
    });
  } else if (agent.state === "waiting-on-you") {
    resultList.push({
      key: "need",
      glyph: "waiting-on-you",
      title: "Waiting for you",
      sub: agent.needs?.command ?? null,
      at: agent.needs?.askedAt ?? null,
      approx: false,
      mute: false,
      attempt: 1,
    });
  } else if (agent.state === "unknown") {
    resultList.push({
      key: "end",
      glyph: "unknown",
      title: "Outcome not reported",
      sub: null,
      at: agent.endedAt,
      approx: false,
      mute: false,
      attempt: 1,
    });
  }

  if (agent.pending === "stop") {
    resultList.push({
      key: "pending",
      glyph: "working",
      title: "Stopping…",
      sub: "Muse has not confirmed yet",
      at: "now",
      approx: false,
      mute: true,
      attempt: 1,
    });
  }

  return resultList;
}

function processWorkflowAttemptEvent(
  event: AttemptEventVM,
  attemptNumber: number,
  isFirstAttempt: boolean,
  isTerminalAttempt: boolean,
  hasMultipleAttempts: boolean,
  agent: AgentVM,
  siblingCount: number,
  subsequentAttempt: { attempt: number } | undefined,
): LifeItem {
  const itemIdentifier = `${attemptNumber}:${event.kind}`;
  const isEstimated = event.detail === "about";

  switch (event.kind) {
    case "scheduled": {
      const scheduleTitle = isFirstAttempt ? "Scheduled" : `Attempt ${attemptNumber} scheduled`;
      let scheduleSubtitle = "A retry with the same task";
      if (isFirstAttempt) {
        const countSuffix = siblingCount > 0 ? `, with ${siblingCount} other ${siblingCount === 1 ? "agent" : "agents"}` : "";
        scheduleSubtitle = `${agent.phase} phase${countSuffix}`;
      }
      return {
        key: itemIdentifier,
        glyph: "scheduled",
        attempt: attemptNumber,
        at: event.at,
        approx: isEstimated,
        mute: false,
        title: scheduleTitle,
        sub: scheduleSubtitle,
      };
    }
    case "started":
      return {
        key: itemIdentifier,
        glyph: "working",
        attempt: attemptNumber,
        at: event.at,
        approx: false,
        mute: false,
        title: hasMultipleAttempts ? `Attempt ${attemptNumber} started` : "Started",
        sub: null,
      };
    case "usage": {
      const finishingNote = isTerminalAttempt && agent.state === "finishing" ? "completion follows" : null;
      const combinedUsageSub = [event.detail, finishingNote].filter(Boolean).join(" · ") || null;
      return {
        key: itemIdentifier,
        glyph: "usage",
        attempt: attemptNumber,
        at: event.at,
        approx: false,
        mute: true,
        title: "Usage reported",
        sub: combinedUsageSub,
      };
    }
    case "completed":
      return {
        key: itemIdentifier,
        glyph: "done",
        attempt: attemptNumber,
        at: event.at,
        approx: false,
        mute: false,
        title: event.detail ? `Done ${event.detail}` : "Done",
        sub: null,
      };
    case "failed": {
      const baseFailTitle = hasMultipleAttempts ? `Attempt ${attemptNumber} failed` : "Failed";
      const failureTitle = `${baseFailTitle}${event.detail ? ` ${event.detail}` : ""}`;
      let failureReason: string | null = null;
      if (isTerminalAttempt) {
        failureReason = agent.failure?.text ?? "Muse has not reported a reason yet";
      } else if (subsequentAttempt) {
        failureReason = `Retried as attempt ${subsequentAttempt.attempt}`;
      }
      return {
        key: itemIdentifier,
        glyph: "failed",
        attempt: attemptNumber,
        at: event.at,
        approx: false,
        mute: false,
        title: failureTitle,
        sub: failureReason,
      };
    }
    case "cancelled": {
      const cancelTitle = isTerminalAttempt ? skippedWord(agent) : `Attempt ${attemptNumber} cancelled`;
      const cancelDetail = event.detail && event.detail !== "about" ? event.detail : null;
      return {
        key: itemIdentifier,
        glyph: "skipped",
        attempt: attemptNumber,
        at: event.at,
        approx: false,
        mute: false,
        title: cancelTitle,
        sub: cancelDetail,
      };
    }
    case "unknown":
      return {
        key: itemIdentifier,
        glyph: "unknown",
        attempt: attemptNumber,
        at: event.at,
        approx: false,
        mute: false,
        title: "Outcome not reported",
        sub: event.detail,
      };
  }
}

/**
 * Builds chronological list of lifecycle steps for an agent across all recorded attempts.
 */
export function lifecycleItems(agent: AgentVM, run: RunVM | null): LifeItem[] {
  if (agent.kind === "research") {
    return produceResearchLifeItems(agent);
  }
  if (agent.kind !== "workflow") {
    return produceNonWorkflowLifeItems(agent);
  }
  if (agent.state === "planned") {
    return [
      {
        key: "planned",
        glyph: "planned",
        title: "Planned",
        sub: "In the workflow script, not scheduled yet",
        at: null,
        approx: false,
        mute: false,
        attempt: 0,
      },
    ];
  }

  const generatedSteps: LifeItem[] = [];
  const multipleAttemptsPresent = agent.attempts.length > 1;
  const phaseEntry = run?.phases.find((phase) => phase.name === agent.phase);
  const totalSiblings = phaseEntry ? Math.max(0, phaseEntry.agents.length - 1) : 0;

  agent.attempts.forEach((attemptRecord, attemptIndex) => {
    const currentAttemptNumber = attemptRecord.attempt;
    const isLastAttempt = attemptIndex === agent.attempts.length - 1;
    const nextAttempt = agent.attempts[attemptIndex + 1];

    for (const rawEvent of attemptRecord.events) {
      generatedSteps.push(
        processWorkflowAttemptEvent(
          rawEvent,
          currentAttemptNumber,
          attemptIndex === 0,
          isLastAttempt,
          multipleAttemptsPresent,
          agent,
          totalSiblings,
          nextAttempt,
        ),
      );
    }
  });

  if (agent.pending === "retry") {
    generatedSteps.push({
      key: "pending",
      glyph: "retry",
      attempt: agent.attempt + 1,
      at: "now",
      approx: false,
      mute: false,
      title: `Retrying · attempt ${agent.attempt + 1} starting`,
      sub: "Muse has not confirmed yet",
    });
  } else if (agent.pending === "stop") {
    generatedSteps.push({
      key: "pending",
      glyph: "working",
      attempt: agent.attempt,
      at: "now",
      approx: false,
      mute: false,
      title: "Stopping…",
      sub: "Muse has not confirmed yet",
    });
  } else if (agent.state === "working" || agent.state === "no-update") {
    generatedSteps.push({
      key: "tail",
      glyph: "no-update",
      attempt: agent.attempt,
      at: "now",
      approx: false,
      mute: true,
      title: "No revision from Muse since",
      sub: "Muse only reports lifecycle changes for workflow agents",
    });
  } else if (agent.state === "scheduled") {
    generatedSteps.push({
      key: "tail",
      glyph: "scheduled",
      attempt: agent.attempt,
      at: "now",
      approx: false,
      mute: true,
      title: "Waiting for a slot",
      sub: null,
    });
  }

  return generatedSteps;
}

function formatTimelineTimestamp(entry: LifeItem): string {
  if (entry.at === "now") {
    return "now";
  }
  if (entry.at === null) {
    return "time not recorded";
  }
  const formattedSeconds = clockSeconds(entry.at);
  return entry.approx ? `about ${formattedSeconds}` : formattedSeconds;
}

function TimelineGlyphIcon({ glyph }: { readonly glyph: LifeItem["glyph"] }): ReactElement {
  if (glyph === "retry") {
    return (
      <span className="flex size-4 items-center justify-center text-accent-text">
        <ArrowCounterClockwiseIcon size={14} />
      </span>
    );
  }
  if (glyph === "usage") {
    return (
      <span className="flex size-4 items-center justify-center text-subtle">
        <span className="size-[9px] rounded-full bg-[var(--cell-done)]" />
      </span>
    );
  }
  return <RowGlyph state={glyph} />;
}

/** Renders ordered step-by-step lifecycle entries with timeline spine. */
export function LifecycleList(props: { items: LifeItem[]; className?: string }): ReactElement {
  return (
    <ul className={cn("m-0 mt-0.5 list-none p-0", props.className)}>
      {props.items.map((stepItem, stepIndex) => (
        <li
          key={stepItem.key}
          className="relative grid grid-cols-[16px_1fr_auto] items-start gap-2.5 py-[5px]"
        >
          {stepIndex < props.items.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute top-[22px] -bottom-1.5 left-[7.5px] w-px bg-line-strong"
            />
          ) : null}
          <TimelineGlyphIcon glyph={stepItem.glyph} />
          <div className="min-w-0">
            <div className={cn("text-sm leading-5", stepItem.mute ? "text-muted" : "text-fg")}>
              {stepItem.title}
            </div>
            {stepItem.sub ? (
              <div className="text-xs leading-[18px] text-subtle [overflow-wrap:anywhere]">
                {stepItem.sub}
              </div>
            ) : null}
          </div>
          <span className="font-mono text-[11.5px] leading-5 whitespace-nowrap text-subtle tabular-nums">
            {formatTimelineTimestamp(stepItem)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ============================================================================
// Facts Catalog Builders
// ============================================================================

export interface Fact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** True when the figure is not reported, stating the reason. */
  readonly nr?: boolean;
  readonly mono?: boolean;
}

function computeTokenUsageFact(agent: AgentVM, isLive: boolean): Fact {
  const tokenRecord = agent.tokens;
  if (tokenRecord && (usageTotal(tokenRecord) > 0 || agent.kind === "lead")) {
    const totalCount = usageTotal(tokenRecord);
    const fragments: string[] = [formatTokens(totalCount)];
    if (tokenRecord.inputTokens !== undefined) {
      fragments.push(`in ${formatTokens(tokenRecord.inputTokens)}`);
    }
    if (tokenRecord.outputTokens !== undefined) {
      fragments.push(`out ${formatTokens(tokenRecord.outputTokens)}`);
    }
    if (tokenRecord.reasoningTokens !== undefined && tokenRecord.reasoningTokens > 0) {
      fragments.push(`incl. reasoning ${formatTokens(tokenRecord.reasoningTokens)}`);
    }
    return {
      key: "tokens",
      label: "Tokens",
      value: fragments.join(" · "),
    };
  }

  if (agent.kind === "task") {
    const toolMsg = agent.taskInfo?.background === false
      ? "Not reported for individual tools"
      : "Not reported for background tasks";
    return { key: "tokens", label: "Tokens", value: toolMsg, nr: true };
  }
  if (agent.kind === "research") {
    return {
      key: "tokens",
      label: "Tokens",
      value: "Not reported per worker · the run counts its own",
      nr: true,
    };
  }
  if (agent.kind === "lead") {
    return {
      key: "tokens",
      label: "Tokens",
      value: isLive ? "Not reported yet" : NOT_REPORTED,
      nr: true,
    };
  }
  return {
    key: "tokens",
    label: "Tokens",
    value: isLive ? NEAR_END : NOT_REPORTED,
    nr: true,
  };
}

function resolveExecutionStatusText(
  agent: AgentVM,
  runGoing: boolean,
  longest: AgentVM | null,
): string {
  if (agent.state === "working" && agent.runningMs !== null && agent.kind !== "workflow") {
    const prefix = agent.kind === "task" ? "Running" : "Working";
    return `${prefix} · ${durationText(agent.runningMs)}`;
  }
  if (agent.state === "working" && agent.runningMs !== null) {
    const isQuiet = agent.lastEventAt !== null && agent.startedAt !== null && agent.lastEventAt <= agent.startedAt;
    const quietSuffix = isQuiet ? " · no update since it started" : "";
    const noFinishSuffix = isQuiet && longest === null ? " · no agent has finished yet" : "";
    return `Working · running ${durationText(agent.runningMs)}${quietSuffix}${noFinishSuffix}`;
  }
  if (agent.state === "no-update") {
    const prefix = agent.kind === "task" ? "Running" : "Working";
    const silenceType = agent.kind === "task" ? "no output" : "no update";
    return `${prefix} · ${silenceType} for ${silenceText(agent)}`;
  }
  if (agent.state === "finishing") {
    return "Finishing · usage reported, completion follows";
  }
  if (agent.state === "failed") {
    if (agent.kind === "lead") {
      return "Turn failed";
    }
    return `Failed, terminal${runGoing ? " · the run went on without it" : ""}`;
  }
  if (agent.state === "done" && agent.durationMs !== null) {
    return `Done · ${durationText(agent.durationMs)}`;
  }
  return stateWord(agent);
}

function appendWorkflowAttemptFacts(agent: AgentVM, catalog: Fact[]): void {
  if (agent.kind === "workflow" && agent.state !== "planned") {
    const durations = agent.attempts.map((att) => {
      if (att.startedAt !== null && att.endedAt !== null) {
        return durationText(att.endedAt - att.startedAt);
      }
      return null;
    });
    const allKnown = durations.every((d) => d !== null) && durations.length > 0;
    const countValue = Math.max(1, agent.attempts.length);
    catalog.push({
      key: "attempts",
      label: "Attempts",
      value: `${countValue}${allKnown ? ` · ${durations.join(" + ")}` : ""}`,
    });
  }
}

function appendTaskInitiatorFacts(agent: AgentVM, catalog: Fact[]): void {
  if (agent.kind === "task" && agent.taskInfo) {
    const isForeground = agent.taskInfo.background === false;
    catalog.push({
      key: "command",
      label: isForeground ? "Operation" : "Command",
      value: agent.taskInfo.command,
      mono: true,
    });
    if (isForeground) {
      catalog.push({ key: "execution", label: "Execution", value: "Foreground" });
    } else {
      let initiatorDesc = "Not reported";
      if (agent.taskInfo.initiator === "timeout") {
        initiatorDesc = "Muse, after a timeout";
      } else if (agent.taskInfo.initiator === "user") {
        initiatorDesc = "You";
      }
      catalog.push({
        key: "initiator",
        label: "Sent by",
        value: initiatorDesc,
        nr: agent.taskInfo.initiator === null,
      });
    }
  }
}

function appendTimelineStartEndFacts(agent: AgentVM, run: RunVM | null, isLive: boolean, catalog: Fact[]): void {
  if (agent.state !== "planned") {
    let runElapsedOffset = "";
    if (agent.startedAt !== null && run?.startedAt !== null && run !== null) {
      runElapsedOffset = ` · ${durationText(Math.max(0, agent.startedAt - run.startedAt))} into the run`;
    }
    if (agent.startedAt !== null) {
      const approxPrefix = agent.approx ? "about " : "";
      catalog.push({
        key: "started",
        label: "Started",
        value: `${approxPrefix}${clockSeconds(agent.startedAt)}${runElapsedOffset}`,
      });
    } else {
      catalog.push({ key: "started", label: "Started", value: "Not recorded", nr: true });
    }

    if (!isLive) {
      if (agent.endedAt !== null) {
        catalog.push({ key: "ended", label: "Ended", value: clockSeconds(agent.endedAt) });
      } else {
        catalog.push({ key: "ended", label: "Ended", value: "Not recorded", nr: true });
      }
    }
  }
}

function appendTaskOutputFact(agent: AgentVM, isLive: boolean, catalog: Fact[]): void {
  if (agent.kind === "task" && agent.taskInfo) {
    if (agent.taskInfo.lastOutputAt !== null) {
      catalog.push({
        key: "output",
        label: "Last output",
        value: clockSeconds(agent.taskInfo.lastOutputAt),
      });
    } else {
      let absentMsg = isLive ? "No output yet" : "No output reported";
      if (agent.taskInfo.tail) {
        absentMsg = "Time not reported";
      }
      catalog.push({ key: "output", label: "Last output", value: absentMsg, nr: true });
    }
  }
}

function appendLongestSiblingFact(agent: AgentVM, longest: AgentVM | null, catalog: Fact[]): void {
  if (agent.kind === "workflow" && (agent.state === "no-update" || agent.state === "working")) {
    if (longest && longest.durationMs !== null) {
      catalog.push({
        key: "longest",
        label: "Longest finished",
        value: `${longest.name} · ${durationText(longest.durationMs)}`,
      });
    } else {
      catalog.push({
        key: "longest",
        label: "Longest finished",
        value: "None yet · no agent has finished",
        nr: true,
      });
    }
  }
}

function appendResearchMetricsFacts(agent: AgentVM, catalog: Fact[]): void {
  if (agent.kind === "research" && agent.research) {
    const research = agent.research;
    catalog.push({ key: "searches", label: "Searches", value: String(research.searches) });
    catalog.push({ key: "reads", label: "Reads", value: String(research.reads) });
    catalog.push({ key: "saved", label: "Saved", value: String(research.saved) });
    catalog.push({ key: "tool-calls", label: "Tool calls", value: String(agent.toolCalls ?? 0) });
    catalog.push(
      research.model !== null
        ? { key: "model", label: "Model", value: research.model }
        : { key: "model", label: "Model", value: "Not named in the run's config", nr: true },
    );
    catalog.push({
      key: "result",
      label: "Result",
      value: "Its findings go into the run's report",
      nr: true,
    });
    catalog.push({
      key: "round",
      label: "Round",
      value: `${research.round}${research.discovery ? " · discovery worker" : ""}`,
    });
  }
}

function appendGeneralToolModelFacts(
  agent: AgentVM,
  runGoing: boolean,
  model: string | null,
  catalog: Fact[],
): void {
  if (agent.kind === "research" && agent.research) {
    return;
  }
  if (agent.kind !== "task") {
    if (agent.toolCalls !== null) {
      catalog.push({ key: "tool-calls", label: "Tool calls", value: String(agent.toolCalls) });
    } else {
      const toolFallback = agent.kind === "workflow" && runGoing ? AT_RUN_END : NOT_REPORTED;
      catalog.push({ key: "tool-calls", label: "Tool calls", value: toolFallback, nr: true });
    }

    if (agent.kind === "lead") {
      catalog.push({
        key: "model",
        label: "Model",
        value: model ?? NOT_REPORTED,
        nr: model === null,
      });
    } else {
      const agentTarget = agent.kind === "workflow" ? "workflow agents" : "subagents";
      const modelDetail = model ? ` · the lead runs ${model}` : "";
      catalog.push({
        key: "model",
        label: "Model",
        value: `Not reported for ${agentTarget}${modelDetail}`,
        nr: true,
      });
    }
  } else {
    const exitCode = agent.taskInfo?.exitCode;
    const exitSignal = agent.taskInfo?.exitSignal;
    const hasValidExitCode = typeof exitCode === "number" && Number.isFinite(exitCode);
    const hasValidSignal = typeof exitSignal === "number" && Number.isFinite(exitSignal);

    if (hasValidExitCode) {
      catalog.push({ key: "exit", label: "Exit code", value: String(exitCode) });
    } else {
      catalog.push({
        key: "exit",
        label: "Exit code",
        value: agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "waiting-on-you" || agent.state === "scheduled" ? "Not finished" : NOT_REPORTED,
        nr: true,
      });
    }

    if (hasValidSignal) {
      catalog.push({ key: "signal", label: "Exit signal", value: String(exitSignal) });
    }
  }
}

function appendWorkflowResultFacts(agent: AgentVM, catalog: Fact[]): void {
  if (agent.kind === "workflow") {
    let outcomeText = AT_RUN_END;
    if (agent.state === "failed") {
      outcomeText = "None · this agent did not finish";
    } else if (agent.state === "skipped") {
      outcomeText = "None · it was skipped";
    } else if (agent.state === "unknown") {
      outcomeText = "Not reported";
    } else if (agent.state === "done") {
      outcomeText = "Not shared · the run's report cites it";
    } else if (agent.state === "planned") {
      outcomeText = "None yet · not scheduled";
    }
    catalog.push({ key: "result", label: "Result", value: outcomeText, nr: true });
    if (agent.state !== "planned") {
      catalog.push({ key: "child-id", label: "Child id", value: agent.id, mono: true });
    }
  }
}

/**
 * Compiles exhaustive facts catalog for an agent, ensuring every property is populated.
 */
export function factsOf(agent: AgentVM, run: RunVM | null, model: string | null): Fact[] {
  const catalog: Fact[] = [];
  const isAgentActive = agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "waiting-on-you" || agent.state === "scheduled";
  const isRunActive = run ? runLive(run) : isAgentActive;
  const longestAgent = run ? longestFinished(run) : null;

  catalog.push({
    key: "status",
    label: "Status",
    value: resolveExecutionStatusText(agent, isRunActive, longestAgent),
  });

  appendWorkflowAttemptFacts(agent, catalog);
  appendTaskInitiatorFacts(agent, catalog);
  appendTimelineStartEndFacts(agent, run, isAgentActive, catalog);
  appendTaskOutputFact(agent, isAgentActive, catalog);
  appendLongestSiblingFact(agent, longestAgent, catalog);
  catalog.push(computeTokenUsageFact(agent, isAgentActive));
  appendResearchMetricsFacts(agent, catalog);
  appendGeneralToolModelFacts(agent, isRunActive, model, catalog);
  appendWorkflowResultFacts(agent, catalog);

  return catalog;
}

function FactEntryRow({ entry }: { readonly entry: Fact }): ReactElement {
  return (
    <div key={entry.key} className="contents" data-fact={entry.key}>
      <dt className="text-subtle">{entry.label}</dt>
      <dd
        className={cn(
          "m-0 min-w-0 tabular-nums [overflow-wrap:anywhere]",
          entry.nr ? "text-subtle" : "text-fg",
          entry.mono && "font-mono text-[11.5px] text-muted",
        )}
      >
        {entry.value}
      </dd>
    </div>
  );
}

/** Renders key-value definition list of agent facts. */
export function FactsList(props: { facts: Fact[] }): ReactElement {
  const factRecords = props.facts;
  return (
    <dl className="m-0 mt-0.5 grid grid-cols-[104px_1fr] gap-x-3 gap-y-[5px] text-[12.5px] leading-[19px]">
      {factRecords.map((item) => (
        <FactEntryRow key={item.key} entry={item} />
      ))}
    </dl>
  );
}

// ============================================================================
// Layout Sections & Identity
// ============================================================================

export function Section(props: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section className={cn("px-4 pt-3 pb-0.5", props.className)} aria-label={props.title}>
      <h4 className="m-0 flex h-6 items-center gap-1.5 text-xs font-medium text-subtle">
        {props.title}
        {props.aside ? (
          <span className="ml-auto inline-flex items-center gap-1 text-2xs font-normal">
            {props.aside}
          </span>
        ) : null}
      </h4>
      {props.children}
    </section>
  );
}

const STATE_TONE_CLASS_MAP: Readonly<Record<string, string>> = Object.freeze({
  fail: "text-danger-text",
  need: "text-warn-text",
  work: "text-accent-text",
  ok: "text-ok-text",
  mute: "text-subtle",
});

/** Identity header: displays large sigil, role title, phase badge, and status glyph. */
export function Identity(props: { agent: AgentVM; stale: boolean }): ReactElement {
  const currentAgent = props.agent;
  const statusToneKey = stateTone(currentAgent);
  const toneClassName = STATE_TONE_CLASS_MAP[statusToneKey] ?? "text-subtle";

  let activeRunningPhrase = "";
  if (currentAgent.runningMs !== null && currentAgent.state !== "failed" && currentAgent.pending === null) {
    activeRunningPhrase = ` · running ${durationText(currentAgent.runningMs)}`;
  }

  const attemptAnnotation = currentAgent.kind === "workflow" && currentAgent.state !== "planned"
    ? ` · attempt ${currentAgent.attempt}`
    : "";

  return (
    <div className="flex items-start gap-3 px-4 pt-3.5 pb-2.5">
      <Sigil
        name={currentAgent.name}
        size={36}
        state={currentAgent.state}
        stale={props.stale}
        badge
      />
      <div className="min-w-0 flex-1">
        <h3 className="m-0 truncate text-md leading-[22px] font-semibold tracking-[-0.01em]">
          <AgentName agent={currentAgent} className="text-md leading-[22px] font-semibold" />
        </h3>
        <div className="mt-px text-xs leading-[18px] text-subtle">
          <span className="font-medium text-muted">{currentAgent.phase}</span> · {resolveAgentClassification(currentAgent)}
          {attemptAnnotation}
        </div>
        <div className={cn("mt-1 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", toneClassName)}>
          <RowGlyph
            state={currentAgent.state}
            pending={currentAgent.pending}
            stale={props.stale}
            skippedBy={currentAgent.skippedBy}
            needKind={currentAgent.needs?.kind ?? null}
          />
          {stateWord(currentAgent)}
          {activeRunningPhrase}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Callout Panels
// ============================================================================

export interface CalloutProps {
  readonly agent: AgentVM;
  readonly run: RunVM | null;
  readonly readOnly: boolean;
  readonly confirm: RowConfirm | null;
  onAction: (agent: AgentVM, action: RowAction) => void;
  onConfirm: (confirm: RowConfirm | null) => void;
}

const CALLOUT_FRAME_CLASS = "mx-4 rounded-xl px-3.5 py-3 text-sm leading-5";

interface ConfirmationControlsProps {
  targetKind: "skip" | "stop";
  targetAgent: AgentVM;
  onAction(agent: AgentVM, action: RowAction): void;
  onConfirm(confirm: RowConfirm | null): void;
}

function InlineConfirmRow({
  targetKind,
  targetAgent,
  onAction,
  onConfirm,
}: ConfirmationControlsProps): ReactElement {
  const ariaDescription = targetKind === "skip" ? "Confirm skip" : "Confirm stop";
  const questionPrompt = targetKind === "skip"
    ? `Skip ${targetAgent.name}? The run continues without it.`
    : `Stop ${targetAgent.name}?`;
  const confirmButtonLabel = targetKind === "skip" ? "Skip" : "Stop";

  return (
    <div
      className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-fg"
      role="group"
      aria-label={ariaDescription}
    >
      <span>{questionPrompt}</span>
      <Button
        size="sm"
        variant="secondary"
        className="h-6 px-2 text-xs"
        onClick={() => {
          onConfirm(null);
          onAction(targetAgent, targetKind);
        }}
      >
        {confirmButtonLabel}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => onConfirm(null)}
      >
        Keep
      </Button>
    </div>
  );
}

function PendingStateCallout({
  agent,
}: {
  readonly agent: AgentVM;
}): ReactElement {
  if (agent.pending === "retry") {
    return (
      <div className={cn(CALLOUT_FRAME_CLASS, "bg-sunken shadow-[inset_0_0_0_1px_var(--border)]")} role="status">
        <div className="flex items-center gap-[7px] font-medium text-fg">
          <ArrowCounterClockwiseIcon size={14} className="text-accent-text" />
          Retrying · attempt {agent.attempt + 1} starting
        </div>
        <p className="m-0 mt-1 text-fg">Muse has not confirmed yet.</p>
      </div>
    );
  }
  return (
    <div className={cn(CALLOUT_FRAME_CLASS, "bg-sunken shadow-[inset_0_0_0_1px_var(--border)]")} role="status">
      <div className="flex items-center gap-[7px] font-medium text-fg">
        <StopCircleIcon size={14} className="text-subtle" />
        Stopping…
      </div>
      <p className="m-0 mt-1 text-fg">Muse has not confirmed yet.</p>
    </div>
  );
}

function FailureStateCallout({
  agent,
  run,
  readOnly,
  confirm,
  onAction,
  onConfirm,
}: CalloutProps): ReactElement {
  const terminalAttempt = agent.attempts[agent.attempts.length - 1];
  let calculatedDuration = agent.durationMs;
  if (terminalAttempt && terminalAttempt.startedAt !== null && terminalAttempt.endedAt !== null) {
    calculatedDuration = terminalAttempt.endedAt - terminalAttempt.startedAt;
  }
  const durationLabel = calculatedDuration !== null && calculatedDuration !== undefined
    ? ` after ${durationText(calculatedDuration)}`
    : "";

  const isWorkflow = agent.kind === "workflow";
  const isResearch = agent.kind === "research";
  const isTimedOut = isResearch && agent.research?.wireState === "timed_out";

  let titlePhrase = `Failed${durationLabel}`;
  if (isWorkflow) {
    titlePhrase = `Failed on attempt ${agent.attempt}${durationLabel}`;
  } else if (isTimedOut) {
    titlePhrase = `Timed out${durationLabel}`;
  }

  const isCurrentlyConfirming = confirm?.id === agent.id ? confirm.kind : null;
  const canInteract = isWorkflow && !readOnly && run && runLive(run);

  let fallbackMessage = "Muse has not reported a reason yet.";
  if (isWorkflow) {
    fallbackMessage = "Muse has not reported a reason yet. Workflow agents report reasons only in the run's final report, if at all.";
  } else if (isResearch) {
    fallbackMessage = RESEARCH_NO_REASON;
  }

  const timePreamble = agent.failure?.at !== null && agent.failure?.at !== undefined
    ? `Muse reported this at ${clockSeconds(agent.failure.at)}. `
    : "";

  return (
    <div
      className={cn(CALLOUT_FRAME_CLASS, "bg-danger-soft shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--danger)_24%,transparent)]")}
      data-callout="failed"
    >
      <div className="flex items-center gap-[7px] font-medium text-fg">
        <WarningCircleIcon size={14} className="text-danger" />
        {titlePhrase}
      </div>

      {agent.failure?.text ? (
        <div className={cn("mt-1 text-xs text-fg [overflow-wrap:anywhere]", !isResearch && "font-mono")}>
          {agent.failure.text}
        </div>
      ) : (
        <p className="m-0 mt-1 text-fg">{fallbackMessage}</p>
      )}

      {isResearch ? (
        <div className="mt-1.5 text-xs leading-[18px] text-muted">
          {RESEARCH_OWN}: the supervisor decides whether its topic is tried again. Stop the run to end them all.
        </div>
      ) : null}

      {isWorkflow ? (
        <div className="mt-1.5 text-xs leading-[18px] text-muted">
          {timePreamble}Retry starts attempt {agent.attempt + 1} with the same task. Skip lets the run go on without it.
        </div>
      ) : null}

      {canInteract ? (
        isCurrentlyConfirming === "skip" ? (
          <InlineConfirmRow
            targetKind="skip"
            targetAgent={agent}
            onAction={onAction}
            onConfirm={onConfirm}
          />
        ) : (
          <div className="mt-2.5 flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => onAction(agent, "retry")}>
              <ArrowCounterClockwiseIcon size={13} />
              Retry agent
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onConfirm({ kind: "skip", id: agent.id })}
            >
              <SkipForwardIcon size={13} />
              Skip and continue
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function SilenceStateCallout({
  agent,
  readOnly,
  confirm,
  onAction,
  onConfirm,
  onKeepWaiting,
}: CalloutProps & { onKeepWaiting: () => void }): ReactElement {
  const isTask = agent.kind === "task";
  const silenceDuration = silenceText(agent);
  const longestMs = agent.quiet?.longestFinishedMs ?? null;
  const isCurrentlyConfirming = confirm?.id === agent.id ? confirm.kind : null;

  let silenceExplanation = `Running for ${durationText(agent.runningMs ?? 0)}. Muse has not reported another update.`;
  if (isTask) {
    silenceExplanation = "The task is still running but has printed nothing in that time. Muse does not say what it is doing.";
  } else if (agent.kind === "workflow") {
    const comparisonPhrase = longestMs !== null
      ? `longer than any finished agent (${durationText(longestMs)})`
      : "with no finished agent to compare with";
    silenceExplanation = `Running for ${durationText(agent.runningMs ?? 0)}, ${comparisonPhrase}. Muse does not report what a workflow agent is doing between its start and its result, so this is a fact, not a verdict.`;
  }

  const stopButtonText = isTask ? "Stop task" : "Stop agent";

  return (
    <div
      className={cn(CALLOUT_FRAME_CLASS, "bg-sunken shadow-[inset_0_0_0_1px_var(--border)]")}
      data-callout="no-update"
    >
      <div className="flex items-center gap-[7px] font-medium text-fg">
        <CircleDashedIcon size={14} className="text-subtle" />
        {isTask ? `No output for ${silenceDuration}` : `No update for ${silenceDuration}`}
      </div>
      <p className="m-0 mt-1 text-fg">{silenceExplanation}</p>

      {!readOnly && canStopAgent(agent) ? (
        isCurrentlyConfirming === "stop" ? (
          <InlineConfirmRow
            targetKind="stop"
            targetAgent={agent}
            onAction={onAction}
            onConfirm={onConfirm}
          />
        ) : (
          <div className="mt-2.5 flex gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onConfirm({ kind: "stop", id: agent.id })}
            >
              <StopCircleIcon size={13} />
              {stopButtonText}
            </Button>
            <Button size="sm" variant="ghost" onClick={onKeepWaiting}>
              <ClockIcon size={13} />
              Keep waiting
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function WaitingPromptCallout({
  agent,
  onAction,
}: {
  readonly agent: AgentVM;
  readonly onAction: (agent: AgentVM, action: RowAction) => void;
}): ReactElement {
  const isInputQuery = agent.needs?.kind === "input";
  const queryDescription = isInputQuery
    ? "Muse asks a question before this can go on."
    : "Muse wants to run a command before this can go on.";
  const actionButtonText = isInputQuery ? "Answer" : "Review request";

  return (
    <div
      className={cn(CALLOUT_FRAME_CLASS, "bg-warn-soft shadow-[inset_0_0_0_1px_var(--warn-line)]")}
      data-callout="waiting"
    >
      <div className="flex items-center gap-[7px] font-medium text-fg">
        {isInputQuery ? (
          <ChatCircleDotsIcon size={14} className="text-status-input" />
        ) : (
          <WarningCircleIcon size={14} className="text-warn" />
        )}
        Waiting for you
      </div>
      <p className="m-0 mt-1 text-fg">{queryDescription}</p>

      {agent.needs?.command ? (
        <div className={cn("mt-1 text-xs text-fg [overflow-wrap:anywhere]", !isInputQuery && "font-mono")}>
          {agent.needs.command}
        </div>
      ) : null}

      <div className="mt-2.5 flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => onAction(agent, "review")}>
          <EyeIcon size={13} />
          {actionButtonText}
        </Button>
      </div>
    </div>
  );
}

/** Explains state requiring user attention or action; renders null when agent is normal. */
export function Callout(props: CalloutProps): ReactElement | null {
  const { agent } = props;
  const [hasDismissedSilence, setHasDismissedSilence] = useState(false);

  if (agent.pending === "retry" || agent.pending === "stop") {
    return <PendingStateCallout agent={agent} />;
  }
  if (agent.state === "failed") {
    return <FailureStateCallout {...props} />;
  }
  if (agent.state === "no-update" && !hasDismissedSilence) {
    return (
      <SilenceStateCallout
        {...props}
        onKeepWaiting={() => setHasDismissedSilence(true)}
      />
    );
  }
  if (agent.state === "waiting-on-you") {
    return <WaitingPromptCallout agent={agent} onAction={props.onAction} />;
  }
  return null;
}

// ============================================================================
// Task & Comparison Details
// ============================================================================

export function TaskSection(props: { agent: AgentVM }): ReactElement | null {
  const activeAgent = props.agent;
  if (activeAgent.kind === "task") {
    return null;
  }

  let sourceLabel = "the objective Muse gave it";
  if (activeAgent.task?.source === "script") {
    sourceLabel = "from the workflow script";
  } else if (activeAgent.kind === "research") {
    sourceLabel = "the topic the supervisor gave it";
  }

  const asideContent = activeAgent.task && activeAgent.kind !== "lead" ? (
    <>
      <CodeIcon size={11} />
      {sourceLabel}
    </>
  ) : null;

  let taskBody = "Muse did not share this agent's task.";
  if (activeAgent.task?.text) {
    taskBody = activeAgent.task.text;
  } else if (activeAgent.kind === "lead") {
    taskBody = "Follow this turn's messages and tool activity in the transcript.";
  }

  return (
    <Section
      title={activeAgent.kind === "lead" ? "Activity" : "Task"}
      aside={asideContent}
    >
      <p className={cn("m-0 text-sm leading-5", activeAgent.task ? "text-fg" : "text-subtle")}>
        {taskBody}
      </p>
    </Section>
  );
}

interface MetricComparisonItem {
  readonly key: string;
  readonly label: string;
  readonly share: number;
  readonly text: string;
  readonly fill: string;
}

export function Compared(props: { agent: AgentVM; run: RunVM }): ReactElement | null {
  const { agent, run } = props;
  const metricsList: MetricComparisonItem[] = [];
  const durationValue = measureOf(agent);

  let barFill = "bg-[var(--bar-fill)]";
  if (agent.state === "failed") {
    barFill = "bg-danger";
  } else if (
    agent.state === "working" ||
    agent.state === "finishing" ||
    agent.state === "no-update"
  ) {
    barFill = "bg-accent";
  }

  if (
    durationValue !== null &&
    run.longestFinishedMs !== null &&
    run.longestFinishedMs > 0 &&
    agent.state !== "planned"
  ) {
    const ratio = durationValue / run.longestFinishedMs;
    const timeDescription = ratio > 1
      ? `${durationText(durationValue)} · past the longest`
      : `${durationText(durationValue)} of ${durationText(run.longestFinishedMs)} longest`;
    metricsList.push({
      key: "time",
      label: "Time",
      share: ratio,
      text: timeDescription,
      fill: barFill,
    });
  }

  const peakTokens = mostTokens(run);
  const ownTokens = agent.tokens ? usageTotal(agent.tokens) : 0;
  if (ownTokens > 0 && peakTokens && peakTokens.total > 0) {
    metricsList.push({
      key: "tokens",
      label: "Tokens",
      share: ownTokens / peakTokens.total,
      text: `${formatTokens(ownTokens)} of ${formatTokens(peakTokens.total)} most`,
      fill: barFill,
    });
  }

  if (metricsList.length === 0) {
    return null;
  }

  return (
    <Section title="Compared with the run">
      <div className="mt-0.5 grid grid-cols-[52px_1fr_112px] items-center gap-x-2.5 gap-y-2 text-xs">
        {metricsList.map((metric) => (
          <div key={metric.key} className="contents" data-compare={metric.key}>
            <span className="text-subtle">{metric.label}</span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-active" aria-hidden="true">
              <span
                className={cn("absolute inset-y-0 left-0 rounded-full", metric.fill)}
                style={{ width: `${Math.min(100, Math.round(metric.share * 100))}%` }}
              />
              {metric.share > 1 ? (
                <span className="absolute inset-0 rounded-full bg-[repeating-linear-gradient(135deg,var(--hatch)_0_2px,transparent_2px_4px)]" />
              ) : null}
            </span>
            <span className="text-right whitespace-nowrap text-muted tabular-nums">
              {metric.text}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ============================================================================
// Honesty & Result Disclosures
// ============================================================================

export function HonestyNote(props: {
  agent: Pick<AgentVM, "kind" | "taskInfo">;
}): ReactElement {
  let disclosureMessage = "What Muse does not stream: a workflow agent's tool calls, transcript or result. Tool-call counts arrive when the run ends.";
  if (props.agent.kind === "task") {
    const toolTarget = props.agent.taskInfo?.background === false ? "this tool" : "a background task";
    disclosureMessage = `What Muse reports for ${toolTarget}: its status and available output. Exit code or signal is shown when reported.`;
  } else if (props.agent.kind === "subagent") {
    disclosureMessage = "What Muse does not stream: a subagent's tool calls or transcript. Its summary arrives when the lead waits on it.";
  } else if (props.agent.kind === "research") {
    disclosureMessage = "What the run reports for a worker: its state and its counters. Its findings and its tokens go into the run's report and the run's own usage.";
  } else if (props.agent.kind === "lead") {
    disclosureMessage = "What Muse reports: this turn's status, tool activity and usage. Its messages and response appear in the transcript.";
  }

  const [headerTitle, ...remainderParts] = disclosureMessage.split(": ");
  const remainderContent = remainderParts.join(": ");

  return (
    <div
      className="mx-4 mt-3 flex items-start gap-2 rounded-[10px] bg-sunken px-3 py-[9px] text-xs leading-[18px] text-muted shadow-[inset_0_0_0_1px_var(--border)]"
      data-honesty=""
    >
      <EyeSlashIcon size={14} className="mt-0.5 shrink-0 text-subtle" />
      <span>
        <b className="font-medium text-fg">{headerTitle}:</b> {remainderContent}
      </span>
    </div>
  );
}

export function ResultTab(props: {
  agent: AgentVM;
  run: RunVM | null;
}): ReactElement {
  const currentAgent = props.agent;

  if (currentAgent.kind === "lead") {
    return (
      <Section title="Response">
        <p className="m-0 text-sm leading-5 text-subtle">
          Read the transcript for this turn's messages, response and tool results.
        </p>
        {currentAgent.state === "unknown" ? (
          <p className="m-0 mt-1 text-sm leading-5 text-muted">
            The turn ended without a reported outcome.
          </p>
        ) : null}
        {currentAgent.failure?.text ? (
          <p className="m-0 mt-2 text-sm text-danger-text [overflow-wrap:anywhere]">
            {currentAgent.failure.text}
          </p>
        ) : null}
      </Section>
    );
  }

  if (currentAgent.kind === "task") {
    return (
      <Section title="Last output">
        <p
          className={cn(
            "m-0 font-mono text-xs leading-[18px] [overflow-wrap:anywhere]",
            currentAgent.taskInfo?.tail ? "text-fg" : "text-subtle",
          )}
        >
          {currentAgent.taskInfo?.tail ?? "Nothing printed yet."}
        </p>
        {currentAgent.failure?.text ? (
          <p className="m-0 mt-2 font-mono text-xs text-danger-text [overflow-wrap:anywhere]">
            {currentAgent.failure.text}
          </p>
        ) : null}
      </Section>
    );
  }

  if (currentAgent.kind === "subagent") {
    let summaryResultText = currentAgent.failure?.text ?? "Muse has not shared a result for this subagent.";
    if (currentAgent.state === "done") {
      summaryResultText = "Muse reports the summary to the lead when it waits on this subagent; the transcript shows it there.";
    }
    return (
      <Section title="Result">
        <p className={cn("m-0 text-sm leading-5", currentAgent.failure?.text ? "text-fg" : "text-subtle")}>
          {summaryResultText}
        </p>
      </Section>
    );
  }

  const isParentRunSettled = props.run !== null && !runLive(props.run);

  if (currentAgent.kind === "research") {
    const hasReport = props.run?.research?.reportAvailable === true;
    const reportSummary = hasReport ? "The run's report is in the transcript." : "The run wrote no report.";
    return (
      <Section title="Result">
        <p className="m-0 text-sm leading-5 text-subtle">
          A worker's findings go into the run's report; the run does not share them apart.
        </p>
        {isParentRunSettled ? (
          <p className="m-0 mt-1 text-sm leading-5 text-muted">{reportSummary}</p>
        ) : null}
      </Section>
    );
  }

  return (
    <Section title="Result">
      <p className="m-0 text-sm leading-5 text-subtle">
        Muse does not share a workflow agent's result. The run's report cites it.
      </p>
      {isParentRunSettled ? (
        <p className="m-0 mt-1 text-sm leading-5 text-muted">The run's report is in the transcript.</p>
      ) : null}
    </Section>
  );
}
