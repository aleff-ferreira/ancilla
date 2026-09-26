import { memo, useEffect, useId, useRef, useState } from "react";
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
  /** The thread's history has not been read yet, or reading it failed, so an empty view proves nothing. */
  load?: "ready" | "loading" | "failed";
  /** Earlier history was left out of the load, so the totals cover only what was loaded. */
  partial?: boolean;
};

/** Screen readers hear at most one summary of what changed in this long, so a swarm does not drown the thread. */
const ANNOUNCE_MS = 3000;

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

function SessionAgentPanel({ view, leadRunning, stale, load = "ready", partial = false }: AgentPanelProps) {
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
  // An empty view is only a claim about the thread once its history has been read.
  const emptyLabel = load === "loading" ? "Loading agent activity…"
    : load === "failed" ? "Agent activity not loaded"
    : stale ? `Last known activity · no agents recorded${partial ? " in loaded history" : ""}`
    : leadRunning && !partial ? "Lead agent is working solo"
    : partial ? "No agents in loaded history"
    : "No agents yet";
  const announcement = useAgentAnnouncement(view, stale || load !== "ready");

  return (
    <section aria-label="Agents" className="@container shrink-0 border-b border-line bg-bg">
      <div className="mx-auto w-full max-w-[1000px] px-3 @min-[520px]:px-5">
        {/* The summary below changes with every count, so it stays out of the live region; this one
            carries only agents starting, finishing, or failing. */}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement ? <span key={announcement.id}>{announcement.text}</span> : null}
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={hasAgents ? detailsId : undefined}
          aria-label={hasAgents ? `${open ? "Collapse" : "Expand"} agents. ${stale ? "Last known activity. " : ""}${summary}${partial ? ", in loaded history" : ""}` : `Agents. ${emptyLabel}`}
          disabled={!hasAgents}
          onClick={() => setExpanded((value) => !value)}
          className="group flex min-h-12 w-full items-center gap-2.5 rounded-lg px-1 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none"
        >
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", hasAgents && !stale ? "bg-accent-soft text-accent-text" : "bg-sunken text-subtle")}>
            <GitForkIcon size={15} aria-hidden="true" />
          </span>
          <span className="shrink-0 text-sm font-medium text-fg">Agents</span>
          {hasAgents ? <span className="min-w-5 shrink-0 rounded-md border border-line px-1 text-center text-2xs font-medium text-muted tabular-nums" title={partial ? "Agents in loaded history" : undefined}>{view.total}</span> : null}
          <span className="min-w-0 flex-1 py-2 text-xs leading-4">
            {hasAgents ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {stale ? <span className="text-subtle">Last known activity</span> : null}
                <span className={cn("min-w-0 text-muted", stale && "text-subtle")}>
                  {summary}
                </span>
                {partial ? <span className="text-subtle">in loaded history</span> : null}
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

function sameAgent(left: AgentActivity, right: AgentActivity): boolean {
  return (Object.keys(left) as (keyof AgentActivity)[]).every((key) => left[key] === right[key]);
}

// Every recompute builds fresh agent objects, but in a large swarm only a few of them change at a time.
const AgentCard = memo(function AgentCard({ agent, stale }: { agent: AgentActivity; stale: boolean }) {
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
}, (before, after) => before.stale === after.stale && sameAgent(before.agent, after.agent));

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

function active(status: AgentActivityStatus | undefined): boolean {
  return status === "working" || status === "waiting";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What a screen reader should hear about the change from `before` (statuses by agent id) to `view`: agents
 * starting, finishing, or failing, and once nothing is left running, how it all ended. Agents being queued,
 * paused, or re-counted are not news, and neither is anything unchanged.
 */
export function agentAnnouncement(before: ReadonlyMap<string, AgentActivityStatus>, view: AgentActivityView): string | null {
  let started = 0;
  let finished = 0;
  let failed = 0;
  for (const agent of view.agents) {
    const previous = before.get(agent.id);
    if (previous === agent.status) continue;
    if (agent.status === "working") started++;
    else if (agent.status === "failed") failed++;
    else if (agent.status === "completed" || agent.status === "stopped") finished++;
  }
  if (started + finished + failed === 0) return null;
  if (finished + failed > 0 && view.working + view.waiting === 0 && [...before.values()].some(active)) {
    const outcomes = [
      view.completed > 0 ? `${view.completed} completed` : null,
      view.failed > 0 ? `${view.failed} failed` : null,
      view.stopped > 0 ? `${view.stopped} stopped` : null,
      view.unknown > 0 ? `${view.unknown} unknown` : null,
    ].filter((part): part is string => part !== null);
    return `All agents finished: ${outcomes.join(", ")}.`;
  }
  const parts: string[] = [];
  if (started > 0) parts.push(`${plural(started, "agent")} started`);
  if (finished > 0) parts.push(parts.length > 0 ? `${finished} finished` : `${plural(finished, "agent")} finished`);
  if (failed > 0) parts.push(parts.length > 0 ? `${failed} failed` : `${plural(failed, "agent")} failed`);
  return `${parts.join(", ")}.`;
}

function statuses(view: AgentActivityView): Map<string, AgentActivityStatus> {
  return new Map(view.agents.map((agent) => [agent.id, agent.status]));
}

/**
 * At most one announcement per ANNOUNCE_MS, describing everything that changed since the last one. What was
 * already there when the thread opened, finished loading, or came back from last known state is not news.
 */
function useAgentAnnouncement(view: AgentActivityView, quiet: boolean): { id: number; text: string } | null {
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);
  const latest = useRef({ view, quiet });
  const announced = useRef<Map<string, AgentActivityStatus> | null>(null);
  const wasQuiet = useRef(quiet);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    latest.current = { view, quiet };
    const rebase = announced.current === null || quiet || wasQuiet.current;
    wasQuiet.current = quiet;
    if (rebase) {
      announced.current = statuses(view);
      return;
    }
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const next = latest.current;
      const text = next.quiet || !announced.current ? null : agentAnnouncement(announced.current, next.view);
      announced.current = statuses(next.view);
      if (text) setMessage((previous) => ({ id: (previous?.id ?? 0) + 1, text }));
    }, ANNOUNCE_MS);
  }, [view, quiet]);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  return message;
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
