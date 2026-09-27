import { useId, type ReactNode } from "react";
import { formatClock } from "../../model/format.js";
import { durationText, type CompletionVM, type FingerprintVM, type RunVM } from "../../model/swarm.js";
import { runKindWord } from "./cardCopy.js";
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretUpIcon,
  ChartBarIcon,
  CheckCircleIcon,
  DatabaseIcon,
  FileTextIcon,
  MinusCircleIcon,
  QuestionIcon,
  RowsIcon,
  SealCheckIcon,
  ShieldWarningIcon,
  TimerIcon,
  UsersThreeIcon,
  WarningCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "../ui/icons.js";
import { Markdown } from "../ui/Markdown.js";
import { Tip } from "../ui/overlays.js";
import { Button, IconButton, cn } from "../ui/primitives.js";
import { PhaseRail } from "./PhaseRail.js";
import { plural } from "./cardCopy.js";

export interface CompletionReportProps {
  run: RunVM;
  completion: CompletionVM;
  expanded: boolean;
  /** Play the one sheen along the finale rail; the caller plays it once per run. */
  sheen?: boolean;
  /** A request panel sits under the card, so the body's cap drops. */
  compact?: boolean;
  onToggle: () => void;
  onOpenPanel: (view: "roster" | "timeline") => void;
  onDismiss: () => void;
  onOpenTranscript?: () => void;
}

const HIGHLIGHT_ICON: Record<string, ReactNode> = {
  Timer: <TimerIcon size={13} />,
  Database: <DatabaseIcon size={13} />,
  Wrench: <WrenchIcon size={13} />,
  ArrowCounterClockwise: <ArrowCounterClockwiseIcon size={13} />,
  ShieldWarning: <ShieldWarningIcon size={13} />,
  UsersThree: <UsersThreeIcon size={13} />,
  MinusCircle: <MinusCircleIcon size={13} />,
  WarningCircle: <WarningCircleIcon size={13} />,
  Question: <QuestionIcon size={13} />,
};

/** The highlight's line with its strong part set in bold: `Longest agent **judge:perf** · 18m 36s`. */
export function emphasized(text: string, strong: string): ReactNode {
  const at = strong ? text.indexOf(strong) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <b>{strong}</b>
      {text.slice(at + strong.length)}
    </>
  );
}

/** The footer's counts once the run ended: `10 done · 1 retried`, `9 done · 1 skipped`. */
export function reportMeta(run: RunVM): string {
  const { counts } = run;
  const parts = [`${counts.done} done`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} not reported`);
  if (run.retried > 0) parts.push(`${run.retried} retried`);
  return parts.join(" · ");
}

/** Axis ticks for a run of `totalMs`: whole minutes at a step that keeps at most four labels, clear of the end label. */
export function ticks(totalMs: number): number[] {
  const steps = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
  const step = steps.find((candidate) => totalMs / candidate <= 5) ?? (steps[steps.length - 1] as number);
  const out: number[] = [];
  for (let at = step; at < totalMs * 0.86; at += step) out.push(at);
  return out;
}

function tickText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

/** Where the time went: one lane per agent under the phases' bands, a failed attempt in the danger colour. */
export function Fingerprint({ fingerprint, elapsed }: { fingerprint: FingerprintVM; elapsed: string }) {
  const total = Math.max(1, fingerprint.totalMs);
  const laneHeight = 44 / Math.max(1, fingerprint.lanes.length);
  const pct = (ms: number) => `${((ms / total) * 100).toFixed(2)}%`;
  const label = `Where the time went: ${plural(fingerprint.lanes.length, "agent")} over ${elapsed}${fingerprint.partial ? ", from loaded history" : ""}`;
  return (
    <div className="swarm-fp" role="img" aria-label={label}>
      <div className="lanes">
        {fingerprint.phases.map((phase, index) => {
          if (phase.startMs === null) return null;
          const last = index === fingerprint.phases.length - 1;
          return (
            <span key={phase.name}>
              <span className="band" style={{ left: pct(phase.startMs) }} />
              <span className="lab" style={last ? { right: 0 } : { left: `calc(${pct(phase.startMs)} + 4px)` }}>{phase.name}</span>
            </span>
          );
        })}
        {fingerprint.lanes.map((lane, index) =>
          lane.spans.map((span, k) => (
            <span
              key={`${lane.id}-${k}`}
              className={cn("bar", span.failed && "f")}
              style={{ left: pct(span.startMs), width: pct(Math.max(0, span.endMs - span.startMs)), top: `${(18 + index * laneHeight).toFixed(1)}px` }}
            />
          )),
        )}
      </div>
      <div className="axis">
        <span style={{ left: 0, transform: "none" }}>0</span>
        {ticks(fingerprint.totalMs).map((at) => (
          <span key={at} style={{ left: pct(at) }}>{tickText(at)}</span>
        ))}
        <span style={{ right: 0, left: "auto", transform: "none" }}>{elapsed}</span>
      </div>
      {fingerprint.partial ? <div className="partial">Times are from loaded history</div> : null}
    </div>
  );
}

/**
 * The completion report: the card a finished run becomes. A serif headline says exactly what happened, the finale
 * rail turns ok, four stats, the highlights the model chose, the fingerprint, and the first lines of the report
 * (SPEC §9.6). The sheen plays once, and only when everyone landed.
 */
export function CompletionReport(props: CompletionReportProps) {
  const { run, completion, expanded } = props;
  const bodyId = useId();
  const landed = run.status === "finished";
  const elapsed = run.elapsedApprox ? (completion.stats[1]?.value ?? durationText(run.elapsedMs)) : durationText(run.elapsedMs);
  const word = run.status === "stopped" ? "Stopped" : run.status === "failed" ? "Failed" : landed ? "Done" : "Finished";
  const started = run.startedAt !== null ? formatClock(run.startedAt, run.clockAt) : null;
  const finished = run.endedAt !== null ? formatClock(run.endedAt, run.clockAt) : null;
  const subLong = [runKindWord(run), started ? `started ${started}` : null, finished ? `finished ${finished}` : null].filter(Boolean).join(" · ");
  const scheduled = run.counts.total - run.counts.planned;
  return (
    <div className="swarm-run report" data-run={run.itemId}>
      <div className="swarm-head">
        <button type="button" className="toggle" aria-expanded={expanded} aria-controls={bodyId} data-swarm-focus="head" onClick={props.onToggle}>
          <span className={cn("swarm-tile", landed ? "ok" : "mute")} aria-hidden="true">
            {landed ? <SealCheckIcon size={16} /> : <MinusCircleIcon size={16} />}
          </span>
          <span className="tt">
            <span className="nm">{run.name}</span>
            <span className="sub long">{subLong}</span>
            <span className="sub short">{runKindWord(run)} · {elapsed}</span>
          </span>
        </button>
        <span className={cn("swarm-el", landed && "ok")}>
          {landed ? <CheckCircleIcon size={13} aria-hidden="true" /> : null}
          {word} · {elapsed}
        </span>
        <IconButton size="sm" label={expanded ? "Collapse the report" : "Expand the report"} onClick={props.onToggle}>
          {expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
        </IconButton>
        <Tip label="Dismiss the report">
          <IconButton size="sm" label="Dismiss the report" onClick={props.onDismiss}>
            <XCircleIcon size={14} />
          </IconButton>
        </Tip>
      </div>
      {expanded ? (
        <div id={bodyId} className={cn("swarm-body", props.compact && "compact")}>
          <div className="swarm-landed">
            <h2>{completion.headline}</h2>
            {completion.factLine ? <div className="sub">{completion.factLine}</div> : null}
          </div>
          <PhaseRail phases={run.phases} openPhase={null} finale stale={false} sheen={props.sheen} onOpen={() => props.onOpenPanel("roster")} />
          <div className="swarm-stats">
            {completion.stats.map((stat) => (
              <div key={stat.label} className="swarm-stat">
                <div className="v">{stat.value}</div>
                <div className="k">{stat.label}</div>
              </div>
            ))}
          </div>
          {completion.highlights.length > 0 ? (
            <>
              <div className="swarm-sec">Highlights</div>
              <ul className="swarm-facts">
                {completion.highlights.map((highlight) => (
                  <li key={highlight.text}>
                    {HIGHLIGHT_ICON[highlight.icon] ?? <QuestionIcon size={13} />}
                    <span>{emphasized(highlight.text, highlight.strong)}</span>
                    {highlight.aside ? <span className="r">{highlight.aside}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {completion.fingerprint.totalMs > 0 && completion.fingerprint.lanes.some((lane) => lane.spans.length > 0) ? (
            <>
              <div className="swarm-sec">Where the time went</div>
              <Fingerprint fingerprint={completion.fingerprint} elapsed={elapsed} />
            </>
          ) : null}
          <div className="swarm-sec">
            Report
            <span className="min-w-0 flex-1" />
            {props.onOpenTranscript ? (
              <button type="button" className="lnk" onClick={props.onOpenTranscript}>
                <ArrowSquareOutIcon size={11} /> Open in transcript
              </button>
            ) : null}
          </div>
          <div className="swarm-excerpt">
            <div className="src">
              <FileTextIcon size={12} /> final summary · first lines
            </div>
            {completion.excerpt ? <Markdown text={completion.excerpt} /> : <span className="text-muted">Muse did not attach a report.</span>}
          </div>
          {run.report && run.report.handoffs.length > 0 ? (
            <>
              <div className="swarm-sec">Handoffs</div>
              <ul className="swarm-facts">
                {run.report.handoffs.map((handoff, index) => (
                  <li key={index}>
                    <span>
                      <b>{handoff.agent}</b>
                      {handoff.description ? ` · ${handoff.description}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="swarm-foot">
            <Button size="xs" variant="ghost" onClick={() => props.onOpenPanel("roster")}>
              <RowsIcon size={12} />
              <span className="lbl">All {scheduled} agents</span>
            </Button>
            <Button size="xs" variant="ghost" onClick={() => props.onOpenPanel("timeline")}>
              <ChartBarIcon size={12} />
              <span className="lbl">Timeline</span>
            </Button>
            <span className="min-w-0 flex-1" />
            <span className="meta">{reportMeta(run)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
