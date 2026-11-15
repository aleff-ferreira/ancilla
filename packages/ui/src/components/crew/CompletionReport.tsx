import { useId, type ReactNode } from "react";
import { formatClock } from "../../model/format.js";
import { durationText, type CompletionVM, type FingerprintVM, type RunVM } from "../../model/crew.js";
import { runKindWord, plural } from "./cardCopy.js";
import { ArrowCounterClockwiseIcon, ArrowSquareOutIcon, CaretDownIcon, CaretUpIcon, ChartBarIcon, CheckCircleIcon, DatabaseIcon, FileTextIcon, MinusCircleIcon, QuestionIcon, RowsIcon, SealCheckIcon, ShieldWarningIcon, TimerIcon, UsersThreeIcon, WarningCircleIcon, WrenchIcon, XCircleIcon } from "../ui/icons.js";
import { Markdown } from "../ui/Markdown.js";
import { Tip } from "../ui/overlays.js";
import { Button, IconButton, cn } from "../ui/primitives.js";
import { PhaseRail } from "./PhaseRail.js";

type PanelNavigationCallback = (targetView: "roster" | "timeline") => void;
type ReportToggleHandler = () => void;
type ReportDismissHandler = () => void;
type TranscriptOpenHandler = () => void;

export interface CompletionReportProps {
  readonly run: RunVM;
  readonly completion: CompletionVM;
  expanded: boolean;
  compact?: boolean;
  sheen?: boolean;
  onToggle: ReportToggleHandler;
  onOpenPanel: PanelNavigationCallback;
  onDismiss: ReportDismissHandler;
  onOpenTranscript?: TranscriptOpenHandler;
}

function resolveHighlightGlyph(iconKey: string): ReactNode {
  switch (iconKey) {
    case "Timer": return <TimerIcon size={13} />;
    case "Database": return <DatabaseIcon size={13} />;
    case "Wrench": return <WrenchIcon size={13} />;
    case "ArrowCounterClockwise": return <ArrowCounterClockwiseIcon size={13} />;
    case "ShieldWarning": return <ShieldWarningIcon size={13} />;
    case "UsersThree": return <UsersThreeIcon size={13} />;
    case "MinusCircle": return <MinusCircleIcon size={13} />;
    case "WarningCircle": return <WarningCircleIcon size={13} />;
    default: return <QuestionIcon size={13} />;
  }
}

export function emphasized(text: string, strong: string): ReactNode {
  if (!strong) return text;
  const matchIndex = text.indexOf(strong);
  if (matchIndex < 0) {
    return text;
  }
  const prefixPart = text.slice(0, matchIndex);
  const suffixPart = text.slice(matchIndex + strong.length);
  return (
    <>
      {prefixPart}
      <b>{strong}</b>
      {suffixPart}
    </>
  );
}

export function reportMeta(run: RunVM): string {
  const stats = run.counts;
  const tokens: string[] = [`${stats.done} done`];
  if (stats.skipped > 0) tokens.push(`${stats.skipped} skipped`);
  if (stats.failed > 0) tokens.push(`${stats.failed} failed`);
  if (stats.unknown > 0) tokens.push(`${stats.unknown} not reported`);
  if (run.retried > 0) tokens.push(`${run.retried} retried`);
  return tokens.join(" · ");
}

export function ticks(totalMs: number): number[] {
  const CANDIDATE_INTERVALS = [
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 3_600_000,
    6 * 3_600_000,
  ];
  const cadence = CANDIDATE_INTERVALS.find((step) => totalMs / step <= 5) ?? (CANDIDATE_INTERVALS[CANDIDATE_INTERVALS.length - 1] as number);
  const resultMarks: number[] = [];
  const limit = totalMs * 0.86;
  for (let pos = cadence; pos < limit; pos += cadence) {
    resultMarks.push(pos);
  }
  return resultMarks;
}

function formatTickDuration(ms: number): string {
  const minCount = Math.round(ms / 60_000);
  if (minCount < 60) {
    return `${minCount}m`;
  }
  const hrs = Math.floor(minCount / 60);
  const remainderMins = minCount % 60;
  const remString = remainderMins ? ` ${remainderMins}m` : "";
  return `${hrs}h${remString}`;
}

function FingerprintTimelineAxis({
  totalMs,
  elapsedLabel,
  toPercentage,
}: {
  totalMs: number;
  elapsedLabel: string;
  toPercentage: (n: number) => string;
}) {
  const zeroMark = <span style={{ left: 0, transform: "none" }}>0</span>;
  const finalMark = <span style={{ right: 0, left: "auto", transform: "none" }}>{elapsedLabel}</span>;
  const marks = ticks(totalMs).map((timeMark) => (
    <span key={timeMark} style={{ left: toPercentage(timeMark) }}>
      {formatTickDuration(timeMark)}
    </span>
  ));

  return (
    <div className="axis">
      {zeroMark}
      {marks}
      {finalMark}
    </div>
  );
}

export function Fingerprint({ fingerprint, elapsed }: { fingerprint: FingerprintVM; elapsed: string }) {
  const spanMax = Math.max(1, fingerprint.totalMs);
  const laneRowHeight = 44 / Math.max(1, fingerprint.lanes.length);
  const toPct = (ms: number) => `${((ms / spanMax) * 100).toFixed(2)}%`;
  const agentPluralLabel = plural(fingerprint.lanes.length, "agent");
  const partialHistoryNote = fingerprint.partial ? ", from loaded history" : "";
  const accessibleChartLabel = `Where the time went: ${agentPluralLabel} over ${elapsed}${partialHistoryNote}`;

  return (
    <div className="crew-fp" role="img" aria-label={accessibleChartLabel}>
      <div className="lanes">
        {fingerprint.phases.map((ph, idx) => {
          if (ph.startMs === null) return null;
          const isLastPh = idx === fingerprint.phases.length - 1;
          const leftPct = toPct(ph.startMs);
          const nameStyle = isLastPh ? { right: 0 } : { left: `calc(${leftPct} + 4px)` };

          return (
            <span key={ph.name}>
              <span className="band" style={{ left: leftPct }} />
              <span className="lab" style={nameStyle}>{ph.name}</span>
            </span>
          );
        })}
        {fingerprint.lanes.map((laneObj, lIdx) =>
          laneObj.spans.map((sp, sIdx) => {
            const spanLeft = toPct(sp.startMs);
            const spanWidth = toPct(Math.max(0, sp.endMs - sp.startMs));
            const topOffset = `${(18 + lIdx * laneRowHeight).toFixed(1)}px`;

            return (
              <span
                key={`${laneObj.id}-${sIdx}`}
                className={cn("bar", sp.failed && "f")}
                style={{ left: spanLeft, width: spanWidth, top: topOffset }}
              />
            );
          }),
        )}
      </div>
      <FingerprintTimelineAxis totalMs={fingerprint.totalMs} elapsedLabel={elapsed} toPercentage={toPct} />
      {fingerprint.partial ? <div className="partial">Times are from loaded history</div> : null}
    </div>
  );
}

function resolveOutcomeTitle(status: string, researchStatus?: string, isLanded?: boolean): string {
  if (status === "stopped") {
    return researchStatus === "interrupted" ? "Interrupted" : "Stopped";
  }
  if (status === "failed") {
    return "Failed";
  }
  return isLanded ? "Done" : "Finished";
}

function ReportSummaryHeadline({ headlineText, factLineText }: { headlineText: string; factLineText?: string | null }) {
  return (
    <div className="crew-landed">
      <h2>{headlineText}</h2>
      {factLineText ? <div className="sub">{factLineText}</div> : null}
    </div>
  );
}

function ReportStatGrid({ statistics }: { statistics: readonly { label: string; value: string }[] }) {
  return (
    <div className="crew-stats">
      {statistics.map((entry) => (
        <div key={entry.label} className="crew-stat">
          <div className="v">{entry.value}</div>
          <div className="k">{entry.label}</div>
        </div>
      ))}
    </div>
  );
}

function ReportHighlightsSection({ highlightItems }: { highlightItems: readonly { icon: string; text: string; strong: string; aside?: string | null }[] }) {
  if (highlightItems.length === 0) return null;

  return (
    <>
      <div className="crew-sec">Highlights</div>
      <ul className="crew-facts">
        {highlightItems.map((item) => (
          <li key={item.text}>
            {resolveHighlightGlyph(item.icon)}
            <span>{emphasized(item.text, item.strong)}</span>
            {item.aside ? <span className="r">{item.aside}</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function ReportExcerptBlock({ excerptText, onOpenTranscript }: { excerptText?: string | null; onOpenTranscript?: () => void }) {
  const transcriptLink = onOpenTranscript ? (
    <button type="button" className="lnk" onClick={onOpenTranscript}>
      <ArrowSquareOutIcon size={11} /> Open in transcript
    </button>
  ) : null;

  return (
    <>
      <div className="crew-sec">
        Report
        <span className="min-w-0 flex-1" />
        {transcriptLink}
      </div>
      <div className="crew-excerpt">
        <div className="src">
          <FileTextIcon size={12} /> final summary · first lines
        </div>
        {excerptText ? <Markdown text={excerptText} /> : <span className="text-muted">Muse did not attach a report.</span>}
      </div>
    </>
  );
}

function ReportHandoffsSection({ handoffItems }: { handoffItems?: readonly { agent: string; description?: string }[] }) {
  if (!handoffItems || handoffItems.length === 0) return null;

  return (
    <>
      <div className="crew-sec">Handoffs</div>
      <ul className="crew-facts">
        {handoffItems.map((item, keyIndex) => (
          <li key={keyIndex}>
            <span>
              <b>{item.agent}</b>
              {item.description ? ` · ${item.description}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function TimelineNavigationButton({ onNavigate }: { onNavigate: PanelNavigationCallback }) {
  return (
    <Button size="xs" variant="ghost" onClick={() => onNavigate("timeline")}>
      <ChartBarIcon size={12} />
      <span className="lbl">Timeline</span>
    </Button>
  );
}

function ReportFooterControls({
  scheduledAgentsCount,
  metadataLine,
  onNavigate,
}: {
  scheduledAgentsCount: number;
  metadataLine: string;
  onNavigate: PanelNavigationCallback;
}) {
  const agentsLabel = `All ${scheduledAgentsCount} agents`;
  return (
    <div className="crew-foot">
      <Button size="xs" variant="ghost" onClick={() => onNavigate("roster")}>
        <RowsIcon size={12} />
        <span className="lbl">{agentsLabel}</span>
      </Button>
      <TimelineNavigationButton onNavigate={onNavigate} />
      <span className="min-w-0 flex-1" />
      <span className="meta">{metadataLine}</span>
    </div>
  );
}

function ExpandCollapseButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const actionLabel = expanded ? "Collapse the report" : "Expand the report";
  const chevron = expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />;
  return (
    <IconButton size="sm" label={actionLabel} onClick={onToggle}>
      {chevron}
    </IconButton>
  );
}

function DismissReportButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Tip label="Dismiss the report">
      <IconButton size="sm" label="Dismiss the report" onClick={onDismiss}>
        <XCircleIcon size={14} />
      </IconButton>
    </Tip>
  );
}

export function CompletionReport(props: CompletionReportProps) {
  const { run, completion, expanded } = props;
  const sectionContentId = useId();
  const isFinishedCleanly = run.status === "finished";

  const durationDisplayString = run.elapsedApprox
    ? (completion.stats[1]?.value ?? durationText(run.elapsedMs))
    : durationText(run.elapsedMs);

  const outcomeWord = resolveOutcomeTitle(run.status, run.research?.status, isFinishedCleanly);

  const startFormatted = run.startedAt !== null ? formatClock(run.startedAt, run.clockAt) : null;
  const endFormatted = run.endedAt !== null ? formatClock(run.endedAt, run.clockAt) : null;
  const narrativeSubLong = [
    runKindWord(run),
    startFormatted ? `started ${startFormatted}` : null,
    endFormatted ? `finished ${endFormatted}` : null,
  ].filter(Boolean).join(" · ");

  const agentsScheduled = run.counts.total - run.counts.planned;
  const hasFingerprintSpans = completion.fingerprint.lanes.some((l) => l.spans.length > 0);
  const shouldRenderFingerprint = completion.fingerprint.totalMs > 0 && hasFingerprintSpans;

  return (
    <div className="crew-run report" data-run={run.itemId}>
      <div className="crew-head">
        <button
          type="button"
          className="toggle"
          aria-expanded={expanded}
          aria-controls={sectionContentId}
          data-crew-focus="head"
          onClick={props.onToggle}
        >
          <span className={cn("crew-tile", isFinishedCleanly ? "ok" : "mute")} aria-hidden="true">
            {isFinishedCleanly ? <SealCheckIcon size={16} /> : <MinusCircleIcon size={16} />}
          </span>
          <span className="tt">
            <span className="nm">{run.name}</span>
            <span className="sub long">{narrativeSubLong}</span>
            <span className="sub short">{runKindWord(run)} · {durationDisplayString}</span>
          </span>
        </button>
        <span className={cn("crew-el", isFinishedCleanly && "ok")}>
          {isFinishedCleanly ? <CheckCircleIcon size={13} aria-hidden="true" /> : null}
          {outcomeWord} · {durationDisplayString}
        </span>
        <ExpandCollapseButton expanded={expanded} onToggle={props.onToggle} />
        <DismissReportButton onDismiss={props.onDismiss} />
      </div>
      {expanded ? (
        <div id={sectionContentId} className={cn("crew-body", props.compact && "compact")}>
          <ReportSummaryHeadline
            headlineText={completion.headline}
            factLineText={completion.factLine}
          />
          <PhaseRail
            phases={run.phases}
            openPhase={null}
            finale
            stale={false}
            sheen={props.sheen}
            onOpen={() => props.onOpenPanel("roster")}
          />
          <ReportStatGrid statistics={completion.stats} />
          <ReportHighlightsSection highlightItems={completion.highlights} />
          {shouldRenderFingerprint ? (
            <>
              <div className="crew-sec">Where the time went</div>
              <Fingerprint fingerprint={completion.fingerprint} elapsed={durationDisplayString} />
            </>
          ) : null}
          <ReportExcerptBlock
            excerptText={completion.excerpt}
            onOpenTranscript={props.onOpenTranscript}
          />
          <ReportHandoffsSection handoffItems={run.report?.handoffs} />
          <ReportFooterControls
            scheduledAgentsCount={agentsScheduled}
            metadataLine={reportMeta(run)}
            onNavigate={props.onOpenPanel}
          />
        </div>
      ) : null}
    </div>
  );
}
