import { memo, useId, useState } from "react";
import type { AgentActivity, AgentActivityStatus, AgentActivityView } from "../../model/agents.js";
import { formatDuration } from "../../model/format.js";
import {
  CaretDownIcon,
  CheckCircleIcon,
  ClockCounterClockwiseIcon,
  ClockIcon,
  GitForkIcon,
  PauseIcon,
  QuestionIcon,
  RobotIcon,
  StopCircleIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "../ui/icons.js";
import { cn, Spinner } from "../ui/primitives.js";

type AgentPanelProps = {
  view: AgentActivityView;
  leadRunning: boolean;
  stale: boolean;
  sessionId: string;
};

const STATUS_ORDER: Record<AgentActivityStatus, number> = {
  working: 0,
  waiting: 1,
  failed: 2,
  unknown: 3,
  completed: 4,
  stopped: 5,
};

const STATUS_TONE: Record<AgentActivityStatus, string> = {
  working: "text-accent-text",
  waiting: "text-warn-text",
  completed: "text-ok-text",
  failed: "text-danger-text",
  stopped: "text-subtle",
  unknown: "text-subtle",
};

const STATUS_LABEL: Record<AgentActivityStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Status unknown",
};

/** The parent supplies observed activity; this panel never infers progress from elapsed time. */
export const AgentPanel = memo(function AgentPanel(props: AgentPanelProps) {
  // Changing threads resets disclosure state without letting an effect briefly expose another thread's state.
  return <SessionAgentPanel key={props.sessionId} {...props} />;
});

function SessionAgentPanel({ view, leadRunning, stale }: AgentPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const detailsId = useId();
  const listId = useId();
  const hasAgents = view.agents.length > 0;
  const open = hasAgents && expanded;
  const ordered = [...view.agents].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const current = ordered.filter((agent) => agent.status !== "completed" && agent.status !== "stopped");
  const finished = ordered.filter((agent) => agent.status === "completed" || agent.status === "stopped");
  // Keep failures and unknown states visible. Only finished work goes into the history disclosure.
  const historyPreview = current.length === 0 ? 4 : 0;
  const hiddenHistory = view.agents.length > 4 ? Math.max(0, finished.length - historyPreview) : 0;
  const visible = hiddenHistory > 0 && !historyExpanded ? [...current, ...finished.slice(0, historyPreview)] : ordered;
  const summary = activitySummary(view, stale);
  const emptyLabel = stale ? "Last known activity · no agents recorded" : leadRunning ? "Lead agent is working solo" : "No agents yet";

  return (
    <section aria-label="Agents" className="@container shrink-0 border-b border-line bg-bg">
      <div className="mx-auto w-full max-w-[1000px] px-3 @min-[520px]:px-5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={hasAgents ? detailsId : undefined}
          aria-label={hasAgents ? `${open ? "Collapse" : "Expand"} agents. ${stale ? "Last known activity. " : ""}${summary}` : `Agents. ${emptyLabel}`}
          disabled={!hasAgents}
          onClick={() => setExpanded((value) => !value)}
          className="group flex min-h-12 w-full items-center gap-2.5 rounded-lg px-1 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none"
        >
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", hasAgents && !stale ? "bg-accent-soft text-accent-text" : "bg-sunken text-subtle")}>
            <GitForkIcon size={15} aria-hidden="true" />
          </span>
          <span className="shrink-0 text-sm font-medium text-fg">Agents</span>
          {hasAgents ? <span className="min-w-5 shrink-0 rounded-md border border-line px-1 text-center text-2xs font-medium text-muted tabular-nums">{view.total}</span> : null}
          <span className="min-w-0 flex-1 py-2 text-xs leading-4" role="status" aria-live="polite" aria-atomic="true">
            {hasAgents ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {stale ? <span className="text-subtle">Last known activity</span> : null}
                <span className={cn("min-w-0 text-muted", stale && "text-subtle")}>
                  {summary}
                </span>
              </span>
            ) : <span className="text-subtle">{emptyLabel}</span>}
          </span>
          {hasAgents ? (
            <span className="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
              <span className="hidden @min-[600px]:inline">{open ? "Collapse" : "Details"}</span>
              <CaretDownIcon size={13} aria-hidden="true" className={cn("transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} />
            </span>
          ) : null}
        </button>

        {open ? (
          <div id={detailsId} className="pb-3">
            <div
              className="max-h-[min(292px,32dvh)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl focus-visible:outline-2 focus-visible:outline-accent [scrollbar-gutter:stable]"
              tabIndex={0}
              role="region"
              aria-label={stale ? "Last known agent activity" : "Agent activity"}
            >
              <ul id={listId} className="grid grid-cols-1 gap-2 @min-[640px]:grid-cols-2">
                {visible.map((agent) => <AgentCard key={agent.id} agent={agent} stale={stale} />)}
              </ul>
            </div>
            {hiddenHistory > 0 ? (
              <button
                type="button"
                aria-expanded={historyExpanded}
                aria-controls={listId}
                onClick={() => setHistoryExpanded((value) => !value)}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-xs text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
              >
                <ClockCounterClockwiseIcon size={12} aria-hidden="true" />
                {historyExpanded ? "Hide finished agents" : `Show ${hiddenHistory}${historyPreview > 0 ? " more" : ""} finished ${hiddenHistory === 1 ? "agent" : "agents"}`}
                <CaretDownIcon size={11} aria-hidden="true" className={cn("transition-transform duration-150 motion-reduce:transition-none", historyExpanded && "rotate-180")} />
              </button>
            ) : null}
          </div>
        ) : hasAgents ? <div id={detailsId} hidden /> : null}
      </div>
    </section>
  );
}

function AgentCard({ agent, stale }: { agent: AgentActivity; stale: boolean }) {
  const statusLabel = stale && agent.status === "working" ? "Was working" : stale && agent.status === "waiting" ? "Was waiting" : STATUS_LABEL[agent.status];
  const duration = agent.durationMs === null ? "" : formatDuration(agent.durationMs);
  const name = agent.name.trim() || "Agent";
  const objective = agent.objective?.trim();
  const activity = agent.activity?.trim();
  const distinctActivity = activity && activity !== name && activity !== objective ? activity : null;
  const missingDetails = !objective && !activity && /^Agent(?: [1-9]\d*)?$/.test(name);
  const pastActivity = stale || agent.status === "completed" || agent.status === "failed" || agent.status === "stopped";
  const highlighted = agent.status === "working" && !stale;
  return (
    <li className={cn("min-w-0 overflow-hidden rounded-xl border bg-raised", highlighted ? "border-accent/25" : "border-line")}>
      <article aria-label={`${name}: ${statusLabel}`} className="flex h-full min-w-0 flex-col p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", highlighted ? "bg-accent-soft text-accent-text" : "bg-sunken text-subtle")}>
            <RobotIcon size={13} aria-hidden="true" />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-fg" title={name}>{name}</h3>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-2xs font-medium", stale ? "text-subtle" : STATUS_TONE[agent.status])}>
            <AgentStatusIcon status={agent.status} stale={stale} />
            {statusLabel}
          </span>
        </div>
        {objective && objective !== name ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-fg [overflow-wrap:anywhere]" title={objective}>{objective}</p> : null}
        {distinctActivity ? (
          <p className={cn("line-clamp-2 text-xs leading-5 text-muted [overflow-wrap:anywhere]", objective && objective !== name ? "mt-1" : "mt-2")} title={distinctActivity}>
            <span className="sr-only">{pastActivity ? "Last activity: " : "Activity: "}</span>{distinctActivity}
          </p>
        ) : missingDetails ? <p className="mt-2 text-xs leading-5 text-subtle">Task details not reported.</p> : null}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-2xs text-subtle">
          <span>{agent.source === "workflow" ? "Workflow agent" : "Subagent"}</span>
          {duration ? <span className="inline-flex items-center gap-1 tabular-nums" title="Reported duration"><ClockIcon size={11} aria-hidden="true" /><span className="sr-only">Reported duration: </span>{duration}</span> : null}
          {agent.toolCalls !== null ? <span className="inline-flex items-center gap-1 tabular-nums"><WrenchIcon size={11} aria-hidden="true" />{agent.toolCalls} {agent.toolCalls === 1 ? "tool call" : "tool calls"}</span> : null}
          {agent.attempt > 1 ? <span className="tabular-nums">Attempt {agent.attempt}</span> : null}
        </div>
      </article>
    </li>
  );
}

function AgentStatusIcon({ status, stale }: { status: AgentActivityStatus; stale: boolean }) {
  if (status === "working") {
    return stale ? <ClockCounterClockwiseIcon size={11} aria-hidden="true" /> : <Spinner size={10} className="motion-reduce:animate-none" />;
  }
  const Icon = status === "waiting" ? PauseIcon
    : status === "completed" ? CheckCircleIcon
    : status === "failed" ? WarningCircleIcon
    : status === "stopped" ? StopCircleIcon
    : QuestionIcon;
  return <Icon size={11} aria-hidden="true" />;
}

function activitySummary(view: AgentActivityView, stale: boolean): string {
  const parts = [`${view.working} ${stale ? `${view.working === 1 ? "was" : "were"} working` : "working"}`];
  if (view.waiting > 0) parts.push(`${view.waiting} ${stale ? `${view.waiting === 1 ? "was" : "were"} waiting` : "waiting"}`);
  if (view.completed > 0) parts.push(`${view.completed} completed`);
  if (view.failed > 0) parts.push(`${view.failed} failed`);
  if (view.stopped > 0) parts.push(`${view.stopped} stopped`);
  if (view.unknown > 0) parts.push(`${view.unknown} unknown`);
  return parts.join(" · ");
}
