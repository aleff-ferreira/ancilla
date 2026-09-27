import { useState, type ReactNode } from "react";
import {
  ArrowCounterClockwiseIcon, ChatCircleDotsIcon, CircleDashedIcon, ClockIcon, CodeIcon, EyeIcon, EyeSlashIcon, SkipForwardIcon, StopCircleIcon, WarningCircleIcon,
} from "../ui/icons.js";
import { formatTokens } from "../../model/format.js";
import { durationText, researchCounters, runLive, usageTotal, type AgentVM, type AttemptEventVM, type RunVM } from "../../model/swarm.js";
import { Button, cn } from "../ui/primitives.js";
import { RESEARCH_NO_REASON, RESEARCH_OWN } from "./cardCopy.js";
import { Sigil } from "./Sigil.js";
import { clockSeconds, longestFinished, measureOf, mostTokens, silenceText, skippedWord, stateTone, stateWord } from "./panel.js";
import { AgentName, RowGlyph, type RowAction, type RowConfirm } from "./RosterRow.js";

/** The copy for a datum Muse has not sent, in the subtle tone. */
export const NOT_REPORTED = "Not reported";
export const AT_RUN_END = "At run end";
export const NEAR_END = "Reported near the end of the agent";

// ---------------------------------------------------------------- lifecycle

export interface LifeItem {
  key: string;
  glyph: AgentVM["state"] | "retry" | "usage";
  title: string;
  sub: string | null;
  /** Epoch ms, `null` when no revision carried a time, `"now"` for a live tail. */
  at: number | null | "now";
  approx: boolean;
  mute: boolean;
  attempt: number;
}

function kindWord(agent: Pick<AgentVM, "kind">): string {
  return agent.kind === "task" ? "Background task" : agent.kind === "subagent" ? "Subagent" : agent.kind === "research" ? "Research worker" : "Workflow agent";
}

/** A research worker's steps: the daemon reports its state and counters, not lifecycle events, so these are read off those. */
function researchItems(agent: AgentVM): LifeItem[] {
  const info = agent.research;
  if (!info) return [];
  const items: LifeItem[] = [];
  const counters = researchCounters(info);
  if (agent.state === "scheduled") {
    items.push({ key: "queued", glyph: "scheduled", title: "Queued", sub: `${agent.phase} · waiting for a slot`, at: null, approx: false, mute: false, attempt: 1 });
    return items;
  }
  items.push({ key: "start", glyph: "working", title: "Started", sub: `${agent.phase}${info.discovery ? " · discovery" : ""}`, at: agent.startedAt, approx: false, mute: false, attempt: 1 });
  switch (agent.state) {
    case "done":
      items.push({ key: "end", glyph: "done", title: agent.durationMs !== null ? `Done after ${durationText(agent.durationMs)}` : "Done", sub: counters, at: agent.endedAt, approx: false, mute: false, attempt: 1 });
      break;
    case "failed":
      items.push({ key: "end", glyph: "failed", title: info.wireState === "timed_out" ? "Timed out" : "Failed", sub: agent.failure?.text ?? RESEARCH_NO_REASON, at: agent.endedAt, approx: false, mute: false, attempt: 1 });
      break;
    case "skipped":
      items.push({ key: "end", glyph: "skipped", title: skippedWord(agent), sub: counters, at: agent.endedAt, approx: false, mute: false, attempt: 1 });
      break;
    default:
      items.push({ key: "tail", glyph: "no-update", title: `Working · ${counters}`, sub: "The counters move as the worker calls its tools", at: "now", approx: false, mute: true, attempt: 1 });
  }
  return items;
}

/** "What happened", one line per lifecycle step Muse reported, per attempt, oldest first. */
export function lifecycleItems(agent: AgentVM, run: RunVM | null): LifeItem[] {
  const items: LifeItem[] = [];
  if (agent.kind === "research") {
    return researchItems(agent);
  }
  if (agent.kind !== "workflow") {
    const who = agent.taskInfo?.initiator === "timeout" ? "Muse backgrounded it after a timeout" : agent.kind === "task" ? "You sent it to the background" : null;
    items.push({ key: "start", glyph: "working", title: agent.kind === "task" ? "Sent to the background" : "Spawned", sub: who, at: agent.startedAt, approx: agent.approx, mute: false, attempt: 1 });
    if (agent.kind === "task" && agent.taskInfo?.lastOutputAt !== null && agent.taskInfo?.lastOutputAt !== undefined) {
      items.push({ key: "output", glyph: "usage", title: "Last output", sub: agent.taskInfo.tail, at: agent.taskInfo.lastOutputAt, approx: false, mute: true, attempt: 1 });
    }
    if (agent.state === "done") items.push({ key: "end", glyph: "done", title: agent.kind === "task" ? "Finished · no failure reported" : "Done", sub: agent.task?.source === "objective" && agent.failure === null ? null : null, at: agent.endedAt, approx: false, mute: false, attempt: 1 });
    else if (agent.state === "failed") items.push({ key: "end", glyph: "failed", title: "Failed", sub: agent.failure?.text ?? "Muse has not reported a reason yet", at: agent.endedAt, approx: false, mute: false, attempt: 1 });
    else if (agent.state === "skipped") items.push({ key: "end", glyph: "skipped", title: skippedWord(agent), sub: null, at: agent.endedAt, approx: false, mute: false, attempt: 1 });
    else if (agent.state === "no-update") items.push({ key: "quiet", glyph: "no-update", title: `No output for ${silenceText(agent)}`, sub: "The task printed nothing in that time", at: "now", approx: false, mute: true, attempt: 1 });
    else if (agent.state === "waiting-on-you") items.push({ key: "need", glyph: "waiting-on-you", title: "Waiting for you", sub: agent.needs?.command ?? null, at: agent.needs?.askedAt ?? null, approx: false, mute: false, attempt: 1 });
    return items;
  }
  if (agent.state === "planned") {
    return [{ key: "planned", glyph: "planned", title: "Planned", sub: "In the workflow script, not scheduled yet", at: null, approx: false, mute: false, attempt: 0 }];
  }
  const many = agent.attempts.length > 1;
  const siblings = run ? (run.phases.find((phase) => phase.name === agent.phase)?.agents.length ?? 1) - 1 : 0;
  agent.attempts.forEach((attempt, index) => {
    const n = attempt.attempt;
    const last = index === agent.attempts.length - 1;
    const next = agent.attempts[index + 1];
    for (const event of attempt.events) {
      const key = `${n}:${event.kind}`;
      const approx = event.detail === "about";
      switch (event.kind) {
        case "scheduled":
          items.push({
            key, glyph: "scheduled", attempt: n, at: event.at, approx, mute: false,
            title: index === 0 ? "Scheduled" : `Attempt ${n} scheduled`,
            sub: index === 0 ? `${agent.phase} phase${siblings > 0 ? `, with ${siblings} other ${siblings === 1 ? "agent" : "agents"}` : ""}` : "A retry with the same task",
          });
          break;
        case "started":
          items.push({ key, glyph: "working", attempt: n, at: event.at, approx: false, mute: false, title: many ? `Attempt ${n} started` : "Started", sub: null });
          break;
        case "usage":
          items.push({
            key, glyph: "usage", attempt: n, at: event.at, approx: false, mute: true, title: "Usage reported",
            sub: [event.detail, last && agent.state === "finishing" ? "completion follows" : null].filter(Boolean).join(" · ") || null,
          });
          break;
        case "completed":
          items.push({ key, glyph: "done", attempt: n, at: event.at, approx: false, mute: false, title: event.detail ? `Done ${event.detail}` : "Done", sub: null });
          break;
        case "failed":
          items.push({
            key, glyph: "failed", attempt: n, at: event.at, approx: false, mute: false,
            title: `${many ? `Attempt ${n} failed` : "Failed"}${event.detail ? ` ${event.detail}` : ""}`,
            sub: last ? (agent.failure?.text ?? "Muse has not reported a reason yet") : next ? `Retried as attempt ${next.attempt}` : null,
          });
          break;
        case "cancelled":
          items.push({ key, glyph: "skipped", attempt: n, at: event.at, approx: false, mute: false, title: last ? skippedWord(agent) : `Attempt ${n} cancelled`, sub: event.detail && event.detail !== "about" ? event.detail : null });
          break;
        case "unknown":
          items.push({ key, glyph: "unknown", attempt: n, at: event.at, approx: false, mute: false, title: "Outcome not reported", sub: event.detail, });
          break;
      }
    }
  });
  if (agent.pending === "retry") {
    items.push({ key: "pending", glyph: "retry", attempt: agent.attempt + 1, at: "now", approx: false, mute: false, title: `Retrying · attempt ${agent.attempt + 1} starting`, sub: "Muse has not confirmed yet" });
  } else if (agent.pending === "stop") {
    items.push({ key: "pending", glyph: "working", attempt: agent.attempt, at: "now", approx: false, mute: false, title: "Stopping…", sub: "Muse has not confirmed yet" });
  } else if (agent.state === "working" || agent.state === "no-update") {
    items.push({ key: "tail", glyph: "no-update", attempt: agent.attempt, at: "now", approx: false, mute: true, title: "No revision from Muse since", sub: "Muse only reports lifecycle changes for workflow agents" });
  } else if (agent.state === "scheduled") {
    items.push({ key: "tail", glyph: "scheduled", attempt: agent.attempt, at: "now", approx: false, mute: true, title: "Waiting for a slot", sub: null });
  }
  return items;
}

function timeCell(item: LifeItem): string {
  if (item.at === "now") return "now";
  if (item.at === null) return "time not recorded";
  return item.approx ? `about ${clockSeconds(item.at)}` : clockSeconds(item.at);
}

function LifeGlyph(props: { glyph: LifeItem["glyph"] }) {
  if (props.glyph === "retry") return <span className="flex size-4 items-center justify-center text-accent-text"><ArrowCounterClockwiseIcon size={14} /></span>;
  if (props.glyph === "usage") return <span className="flex size-4 items-center justify-center text-subtle"><span className="size-[9px] rounded-full bg-[var(--cell-done)]" /></span>;
  return <RowGlyph state={props.glyph} />;
}

/** The lifecycle list: glyph, title and sub, and the mono time at the right. */
export function LifecycleList(props: { items: LifeItem[]; className?: string }) {
  return (
    <ul className={cn("m-0 mt-0.5 list-none p-0", props.className)}>
      {props.items.map((item, index) => (
        <li key={item.key} className="relative grid grid-cols-[16px_1fr_auto] items-start gap-2.5 py-[5px]">
          {index < props.items.length - 1 ? <span aria-hidden="true" className="absolute top-[22px] -bottom-1.5 left-[7.5px] w-px bg-line-strong" /> : null}
          <LifeGlyph glyph={item.glyph} />
          <div className="min-w-0">
            <div className={cn("text-sm leading-5", item.mute ? "text-muted" : "text-fg")}>{item.title}</div>
            {item.sub ? <div className="text-xs leading-[18px] text-subtle [overflow-wrap:anywhere]">{item.sub}</div> : null}
          </div>
          <span className="font-mono text-[11.5px] leading-5 whitespace-nowrap text-subtle tabular-nums">{timeCell(item)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- facts

export interface Fact {
  key: string;
  label: string;
  value: string;
  /** The value says why the figure is absent. */
  nr?: boolean;
  mono?: boolean;
}

function tokensFact(agent: AgentVM, live: boolean): Fact {
  if (agent.tokens && usageTotal(agent.tokens) > 0) {
    const parts = [formatTokens(usageTotal(agent.tokens))];
    if (agent.tokens.inputTokens !== undefined) parts.push(`in ${formatTokens(agent.tokens.inputTokens)}`);
    if (agent.tokens.outputTokens !== undefined) parts.push(`out ${formatTokens(agent.tokens.outputTokens)}`);
    if (agent.tokens.reasoningTokens !== undefined && agent.tokens.reasoningTokens > 0) parts.push(`reasoning ${formatTokens(agent.tokens.reasoningTokens)}`);
    return { key: "tokens", label: "Tokens", value: parts.join(" · ") };
  }
  if (agent.kind === "task") return { key: "tokens", label: "Tokens", value: "Not reported for background tasks", nr: true };
  if (agent.kind === "research") return { key: "tokens", label: "Tokens", value: "Not reported per worker · the run counts its own", nr: true };
  return { key: "tokens", label: "Tokens", value: live ? NEAR_END : NOT_REPORTED, nr: true };
}

/** The facts, never blank: every absent figure says why (SPEC §7, §14). */
export function factsOf(agent: AgentVM, run: RunVM | null, model: string | null): Fact[] {
  const facts: Fact[] = [];
  const live = agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" || agent.state === "waiting-on-you" || agent.state === "scheduled";
  const runGoing = run ? runLive(run) : live;
  const longest = run ? longestFinished(run) : null;

  let status = stateWord(agent);
  if (agent.state === "working" && agent.runningMs !== null && agent.kind !== "workflow") {
    status = `${agent.kind === "task" ? "Running" : "Working"} · ${durationText(agent.runningMs)}`;
  } else if (agent.state === "working" && agent.runningMs !== null) {
    const silent = agent.lastEventAt !== null && agent.startedAt !== null && agent.lastEventAt <= agent.startedAt;
    status = `Working · running ${durationText(agent.runningMs)}${silent ? " · no update since it started" : ""}${silent && longest === null ? " · no agent has finished yet" : ""}`;
  } else if (agent.state === "no-update") {
    status = `${agent.kind === "task" ? "Running" : "Working"} · ${agent.kind === "task" ? "no output" : "no update"} for ${silenceText(agent)}`;
  } else if (agent.state === "finishing") {
    status = "Finishing · usage reported, completion follows";
  } else if (agent.state === "failed") {
    status = `Failed, terminal${runGoing ? " · the run went on without it" : ""}`;
  } else if (agent.state === "done" && agent.durationMs !== null) {
    status = `Done · ${durationText(agent.durationMs)}`;
  }
  facts.push({ key: "status", label: "Status", value: status });

  if (agent.kind === "workflow" && agent.state !== "planned") {
    const durations = agent.attempts.map((attempt) => (attempt.startedAt !== null && attempt.endedAt !== null ? durationText(attempt.endedAt - attempt.startedAt) : null));
    const known = durations.every((d) => d !== null) && durations.length > 0;
    facts.push({ key: "attempts", label: "Attempts", value: `${Math.max(1, agent.attempts.length)}${known ? ` · ${durations.join(" + ")}` : ""}` });
  }
  if (agent.kind === "task" && agent.taskInfo) {
    facts.push({ key: "command", label: "Command", value: agent.taskInfo.command, mono: true });
    facts.push({ key: "initiator", label: "Sent by", value: agent.taskInfo.initiator === "timeout" ? "Muse, after a timeout" : agent.taskInfo.initiator === "user" ? "You" : "Not reported", nr: agent.taskInfo.initiator === null });
  }
  if (agent.state !== "planned") {
    const into = agent.startedAt !== null && run?.startedAt !== null && run !== null ? ` · ${durationText(Math.max(0, agent.startedAt - run.startedAt))} into the run` : "";
    facts.push(agent.startedAt !== null
      ? { key: "started", label: "Started", value: `${agent.approx ? "about " : ""}${clockSeconds(agent.startedAt)}${into}` }
      : { key: "started", label: "Started", value: "Not recorded", nr: true });
    if (!live) {
      facts.push(agent.endedAt !== null ? { key: "ended", label: "Ended", value: clockSeconds(agent.endedAt) } : { key: "ended", label: "Ended", value: "Not recorded", nr: true });
    }
  }
  if (agent.kind === "task" && agent.taskInfo) {
    facts.push(agent.taskInfo.lastOutputAt !== null ? { key: "output", label: "Last output", value: clockSeconds(agent.taskInfo.lastOutputAt) } : { key: "output", label: "Last output", value: "No output yet", nr: true });
  }
  if (agent.kind === "workflow" && (agent.state === "no-update" || agent.state === "working")) {
    facts.push(longest && longest.durationMs !== null
      ? { key: "longest", label: "Longest finished", value: `${longest.name} · ${durationText(longest.durationMs)}` }
      : { key: "longest", label: "Longest finished", value: "None yet · no agent has finished", nr: true });
  }
  facts.push(tokensFact(agent, live));
  if (agent.kind === "research" && agent.research) {
    // The daemon's counters, as the run reports them; each is a figure even at zero, since zero is what it did.
    const info = agent.research;
    facts.push({ key: "searches", label: "Searches", value: String(info.searches) });
    facts.push({ key: "reads", label: "Reads", value: String(info.reads) });
    facts.push({ key: "saved", label: "Saved", value: String(info.saved) });
    facts.push({ key: "tool-calls", label: "Tool calls", value: String(agent.toolCalls ?? 0) });
    facts.push(info.model !== null
      ? { key: "model", label: "Model", value: info.model }
      : { key: "model", label: "Model", value: "Not named in the run's config", nr: true });
    facts.push({ key: "result", label: "Result", value: "Its findings go into the run's report", nr: true });
    facts.push({ key: "round", label: "Round", value: `${info.round}${info.discovery ? " · discovery worker" : ""}` });
  } else if (agent.kind !== "task") {
    facts.push(agent.toolCalls !== null
      ? { key: "tool-calls", label: "Tool calls", value: String(agent.toolCalls) }
      : { key: "tool-calls", label: "Tool calls", value: agent.kind === "workflow" && runGoing ? AT_RUN_END : NOT_REPORTED, nr: true });
    facts.push({ key: "model", label: "Model", value: `Not reported for ${agent.kind === "workflow" ? "workflow agents" : "subagents"}${model ? ` · the lead runs ${model}` : ""}`, nr: true });
  } else {
    facts.push({ key: "exit", label: "Exit code", value: "Not reported for background tasks", nr: true });
  }
  if (agent.kind === "workflow") {
    const result = agent.state === "failed" ? "None · this agent did not finish"
      : agent.state === "skipped" ? "None · it was skipped"
      : agent.state === "unknown" ? "Not reported"
      : agent.state === "done" ? "Not shared · the run's report cites it"
      : agent.state === "planned" ? "None yet · not scheduled"
      : AT_RUN_END;
    facts.push({ key: "result", label: "Result", value: result, nr: true });
    if (agent.state !== "planned") facts.push({ key: "child-id", label: "Child id", value: agent.id, mono: true });
  }
  return facts;
}

export function FactsList(props: { facts: Fact[] }) {
  return (
    <dl className="m-0 mt-0.5 grid grid-cols-[104px_1fr] gap-x-3 gap-y-[5px] text-[12.5px] leading-[19px]">
      {props.facts.map((fact) => (
        <div key={fact.key} className="contents" data-fact={fact.key}>
          <dt className="text-subtle">{fact.label}</dt>
          <dd className={cn("m-0 min-w-0 tabular-nums [overflow-wrap:anywhere]", fact.nr ? "text-subtle" : "text-fg", fact.mono && "font-mono text-[11.5px] text-muted")}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- sections

export function Section(props: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("px-4 pt-3 pb-0.5", props.className)} aria-label={props.title}>
      <h4 className="m-0 flex h-6 items-center gap-1.5 text-xs font-medium text-subtle">
        {props.title}
        {props.aside ? <span className="ml-auto inline-flex items-center gap-1 text-2xs font-normal">{props.aside}</span> : null}
      </h4>
      {props.children}
    </section>
  );
}

/** Identity: the 36 px sigil, the prefixed name, `Design · Workflow agent · attempt 2`, and the status word. */
export function Identity(props: { agent: AgentVM; stale: boolean }) {
  const { agent } = props;
  const tone = { fail: "text-danger-text", need: "text-warn-text", work: "text-accent-text", ok: "text-ok-text", mute: "text-subtle" }[stateTone(agent)];
  const running = agent.runningMs !== null && agent.state !== "failed" && agent.pending === null ? ` · running ${durationText(agent.runningMs)}` : "";
  return (
    <div className="flex items-start gap-3 px-4 pt-3.5 pb-2.5">
      <Sigil name={agent.name} size={36} state={agent.state} stale={props.stale} badge />
      <div className="min-w-0 flex-1">
        <h3 className="m-0 truncate text-md leading-[22px] font-semibold tracking-[-0.01em]">
          <AgentName agent={agent} className="text-md leading-[22px] font-semibold" />
        </h3>
        <div className="mt-px text-xs leading-[18px] text-subtle">
          <span className="font-medium text-muted">{agent.phase}</span> · {kindWord(agent)}
          {agent.kind === "workflow" && agent.state !== "planned" ? ` · attempt ${agent.attempt}` : ""}
        </div>
        <div className={cn("mt-1 inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", tone)}>
          <RowGlyph state={agent.state} pending={agent.pending} stale={props.stale} skippedBy={agent.skippedBy} needKind={agent.needs?.kind ?? null} />
          {stateWord(agent)}
          {running}
        </div>
      </div>
    </div>
  );
}

export interface CalloutProps {
  agent: AgentVM;
  run: RunVM | null;
  readOnly: boolean;
  confirm: RowConfirm | null;
  onAction(agent: AgentVM, action: RowAction): void;
  onConfirm(confirm: RowConfirm | null): void;
}

/** The state's explanation and what can be done about it; nothing for the states that need nothing. */
export function Callout(props: CalloutProps) {
  const { agent } = props;
  const [waiting, setWaiting] = useState(false);
  const confirming = props.confirm && props.confirm.id === agent.id ? props.confirm.kind : null;
  const confirmRow = (kind: "skip" | "stop") => (
    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-fg" role="group" aria-label={kind === "skip" ? "Confirm skip" : "Confirm stop"}>
      <span>{kind === "skip" ? `Skip ${agent.name}? The run continues without it.` : `Stop ${agent.name}?`}</span>
      <Button size="sm" variant="secondary" className="h-6 px-2 text-xs" onClick={() => { props.onConfirm(null); props.onAction(agent, kind); }}>{kind === "skip" ? "Skip" : "Stop"}</Button>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => props.onConfirm(null)}>Keep</Button>
    </div>
  );
  const box = "mx-4 rounded-xl px-3.5 py-3 text-sm leading-5";
  if (agent.pending === "retry") {
    return (
      <div className={cn(box, "bg-sunken shadow-[inset_0_0_0_1px_var(--border)]")} role="status">
        <div className="flex items-center gap-[7px] font-medium text-fg"><ArrowCounterClockwiseIcon size={14} className="text-accent-text" />Retrying · attempt {agent.attempt + 1} starting</div>
        <p className="m-0 mt-1 text-fg">Muse has not confirmed yet.</p>
      </div>
    );
  }
  if (agent.pending === "stop") {
    return (
      <div className={cn(box, "bg-sunken shadow-[inset_0_0_0_1px_var(--border)]")} role="status">
        <div className="flex items-center gap-[7px] font-medium text-fg"><StopCircleIcon size={14} className="text-subtle" />Stopping…</div>
        <p className="m-0 mt-1 text-fg">Muse has not confirmed yet.</p>
      </div>
    );
  }
  if (agent.state === "failed") {
    const last = agent.attempts[agent.attempts.length - 1];
    const lastMs = last && last.startedAt !== null && last.endedAt !== null ? last.endedAt - last.startedAt : agent.durationMs;
    const after = lastMs !== null && lastMs !== undefined ? ` after ${durationText(lastMs)}` : "";
    const workflow = agent.kind === "workflow";
    const research = agent.kind === "research";
    return (
      <div className={cn(box, "bg-danger-soft shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--danger)_24%,transparent)]")} data-callout="failed">
        <div className="flex items-center gap-[7px] font-medium text-fg">
          <WarningCircleIcon size={14} className="text-danger" />
          {workflow ? `Failed on attempt ${agent.attempt}${after}` : research && agent.research?.wireState === "timed_out" ? `Timed out${after}` : `Failed${after}`}
        </div>
        {agent.failure?.text ? (
          <div className={cn("mt-1 text-xs text-fg [overflow-wrap:anywhere]", !research && "font-mono")}>{agent.failure.text}</div>
        ) : (
          <p className="m-0 mt-1 text-fg">
            {workflow ? "Muse has not reported a reason yet. Workflow agents report reasons only in the run's final report, if at all." : research ? RESEARCH_NO_REASON : "Muse has not reported a reason yet."}
          </p>
        )}
        {research ? (
          <div className="mt-1.5 text-xs leading-[18px] text-muted">{RESEARCH_OWN}: the supervisor decides whether its topic is tried again. Stop the run to end them all.</div>
        ) : null}
        {workflow ? (
          <div className="mt-1.5 text-xs leading-[18px] text-muted">
            {agent.failure?.at !== null && agent.failure?.at !== undefined ? `Muse reported this at ${clockSeconds(agent.failure.at)}. ` : ""}
            Retry starts attempt {agent.attempt + 1} with the same task. Skip lets the run go on without it.
          </div>
        ) : null}
        {workflow && !props.readOnly && props.run && runLive(props.run) ? (
          confirming === "skip" ? confirmRow("skip") : (
            <div className="mt-2.5 flex gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => props.onAction(agent, "retry")}><ArrowCounterClockwiseIcon size={13} />Retry agent</Button>
              <Button size="sm" variant="ghost" onClick={() => props.onConfirm({ kind: "skip", id: agent.id })}><SkipForwardIcon size={13} />Skip and continue</Button>
            </div>
          )
        ) : null}
      </div>
    );
  }
  if (agent.state === "no-update" && !waiting) {
    const task = agent.kind === "task";
    const longest = agent.quiet?.longestFinishedMs ?? null;
    return (
      <div className={cn(box, "bg-sunken shadow-[inset_0_0_0_1px_var(--border)]")} data-callout="no-update">
        <div className="flex items-center gap-[7px] font-medium text-fg">
          <CircleDashedIcon size={14} className="text-subtle" />
          {task ? `No output for ${silenceText(agent)}` : `No update for ${silenceText(agent)}`}
        </div>
        <p className="m-0 mt-1 text-fg">
          {task
            ? "The task is still running but has printed nothing in that time. Muse does not say what it is doing."
            : `Running for ${durationText(agent.runningMs ?? 0)}, ${longest !== null ? `longer than any finished agent (${durationText(longest)})` : "with no finished agent to compare with"}. Muse does not report what a workflow agent is doing between its start and its result, so this is a fact, not a verdict.`}
        </p>
        {!props.readOnly ? (
          confirming === "stop" ? confirmRow("stop") : (
            <div className="mt-2.5 flex gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => props.onConfirm({ kind: "stop", id: agent.id })}><StopCircleIcon size={13} />{task ? "Stop task" : "Stop agent"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setWaiting(true)}><ClockIcon size={13} />Keep waiting</Button>
            </div>
          )
        ) : null}
      </div>
    );
  }
  if (agent.state === "waiting-on-you") {
    const input = agent.needs?.kind === "input";
    return (
      <div className={cn(box, "bg-warn-soft shadow-[inset_0_0_0_1px_var(--warn-line)]")} data-callout="waiting">
        <div className="flex items-center gap-[7px] font-medium text-fg">
          {input ? <ChatCircleDotsIcon size={14} className="text-status-input" /> : <WarningCircleIcon size={14} className="text-warn" />}
          Waiting for you
        </div>
        <p className="m-0 mt-1 text-fg">{input ? "Muse asks a question before this can go on." : "Muse wants to run a command before this can go on."}</p>
        {agent.needs?.command ? <div className={cn("mt-1 text-xs text-fg [overflow-wrap:anywhere]", !input && "font-mono")}>{agent.needs.command}</div> : null}
        <div className="mt-2.5 flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => props.onAction(agent, "review")}><EyeIcon size={13} />{input ? "Answer" : "Review request"}</Button>
        </div>
      </div>
    );
  }
  return null;
}

/** "Task", from the workflow script or the subagent's objective; a sentence when Muse shared none. */
export function TaskSection(props: { agent: AgentVM }) {
  const { agent } = props;
  if (agent.kind === "task") return null;
  return (
    <Section title="Task" aside={agent.task ? <><CodeIcon size={11} />{agent.task.source === "script" ? "from the workflow script" : agent.kind === "research" ? "the topic the supervisor gave it" : "the objective Muse gave it"}</> : null}>
      <p className={cn("m-0 text-sm leading-5", agent.task ? "text-fg" : "text-subtle")}>{agent.task?.text ?? "Muse did not share this agent's task."}</p>
    </Section>
  );
}

/** "Compared with the run": this agent's time against the longest finished, its tokens against the most. */
export function Compared(props: { agent: AgentVM; run: RunVM }) {
  const { agent, run } = props;
  const rows: { key: string; label: string; share: number; text: string; fill: string }[] = [];
  const measure = measureOf(agent);
  const fill = agent.state === "failed" ? "bg-danger" : agent.state === "working" || agent.state === "finishing" || agent.state === "no-update" ? "bg-accent" : "bg-[var(--bar-fill)]";
  if (measure !== null && run.longestFinishedMs !== null && run.longestFinishedMs > 0 && agent.state !== "planned") {
    const share = measure / run.longestFinishedMs;
    rows.push({ key: "time", label: "Time", share, text: share > 1 ? `${durationText(measure)} · past the longest` : `${durationText(measure)} of ${durationText(run.longestFinishedMs)} longest`, fill });
  }
  const most = mostTokens(run);
  const mine = agent.tokens ? usageTotal(agent.tokens) : 0;
  if (mine > 0 && most && most.total > 0) {
    rows.push({ key: "tokens", label: "Tokens", share: mine / most.total, text: `${formatTokens(mine)} of ${formatTokens(most.total)} most`, fill });
  }
  if (rows.length === 0) return null;
  return (
    <Section title="Compared with the run">
      <div className="mt-0.5 grid grid-cols-[52px_1fr_112px] items-center gap-x-2.5 gap-y-2 text-xs">
        {rows.map((row) => (
          <div key={row.key} className="contents" data-compare={row.key}>
            <span className="text-subtle">{row.label}</span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-active" aria-hidden="true">
              <span className={cn("absolute inset-y-0 left-0 rounded-full", row.fill)} style={{ width: `${Math.min(100, Math.round(row.share * 100))}%` }} />
              {row.share > 1 ? <span className="absolute inset-0 rounded-full bg-[repeating-linear-gradient(135deg,var(--hatch)_0_2px,transparent_2px_4px)]" /> : null}
            </span>
            <span className="text-right whitespace-nowrap text-muted tabular-nums">{row.text}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** What Muse does not stream, so nobody waits for it. */
export function HonestyNote(props: { agent: Pick<AgentVM, "kind"> }) {
  const text = props.agent.kind === "task"
    ? "What Muse streams for a background task: its output lines. It does not report an exit code."
    : props.agent.kind === "subagent"
      ? "What Muse does not stream: a subagent's tool calls or transcript. Its summary arrives when the lead waits on it."
      : props.agent.kind === "research"
        ? "What the run reports for a worker: its state and its counters. Its findings and its tokens go into the run's report and the run's own usage."
        : "What Muse does not stream: a workflow agent's tool calls, transcript or result. Tool-call counts arrive when the run ends.";
  const [strong, ...rest] = text.split(": ");
  return (
    <div className="mx-4 mt-3 flex items-start gap-2 rounded-[10px] bg-sunken px-3 py-[9px] text-xs leading-[18px] text-muted shadow-[inset_0_0_0_1px_var(--border)]" data-honesty="">
      <EyeSlashIcon size={14} className="mt-0.5 shrink-0 text-subtle" />
      <span><b className="font-medium text-fg">{strong}:</b> {rest.join(": ")}</span>
    </div>
  );
}

/** The Result tab: what Muse shares of an agent's result, which for a workflow agent is nothing but the run's report. */
export function ResultTab(props: { agent: AgentVM; run: RunVM | null }) {
  const { agent } = props;
  if (agent.kind === "task") {
    return (
      <Section title="Last output">
        <p className={cn("m-0 font-mono text-xs leading-[18px] [overflow-wrap:anywhere]", agent.taskInfo?.tail ? "text-fg" : "text-subtle")}>{agent.taskInfo?.tail ?? "Nothing printed yet."}</p>
        {agent.failure?.text ? <p className="m-0 mt-2 font-mono text-xs text-danger-text [overflow-wrap:anywhere]">{agent.failure.text}</p> : null}
      </Section>
    );
  }
  if (agent.kind === "subagent") {
    return (
      <Section title="Result">
        <p className={cn("m-0 text-sm leading-5", agent.failure?.text ? "text-fg" : "text-subtle")}>
          {agent.state === "done" ? "Muse reports the summary to the lead when it waits on this subagent; the transcript shows it there." : agent.failure?.text ?? "Muse has not shared a result for this subagent."}
        </p>
      </Section>
    );
  }
  const finished = props.run !== null && !runLive(props.run);
  if (agent.kind === "research") {
    const written = props.run?.research?.reportAvailable === true;
    return (
      <Section title="Result">
        <p className="m-0 text-sm leading-5 text-subtle">A worker's findings go into the run's report; the run does not share them apart.</p>
        {finished ? <p className="m-0 mt-1 text-sm leading-5 text-muted">{written ? "The run's report is in the transcript." : "The run wrote no report."}</p> : null}
      </Section>
    );
  }
  return (
    <Section title="Result">
      <p className="m-0 text-sm leading-5 text-subtle">Muse does not share a workflow agent's result. The run's report cites it.</p>
      {finished ? <p className="m-0 mt-1 text-sm leading-5 text-muted">The run's report is in the transcript.</p> : null}
    </Section>
  );
}
