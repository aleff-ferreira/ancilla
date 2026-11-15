import { memo, type CSSProperties, type ReactNode } from "react";
import { cn } from "../ui/primitives.js";

export type StripCell = "planned" | "scheduled" | "working" | "finishing" | "no-update" | "waiting-on-you" | "failed" | "skipped" | "done" | "unknown";

export type StripSize = "xs" | "sm" | "md" | "rail";

export interface StripProps {
  className?: string;
  decorative?: boolean;
  label?: string;
  binWidth?: number;
  bin?: "phase" | "run";
  binAt?: number;
  more?: boolean;
  stale?: boolean;
  sheen?: boolean;
  finale?: boolean;
  size?: StripSize;
  groups: readonly (readonly StripCell[])[];
}

export interface StripCounts {
  planned: number;
  scheduled: number;
  unknown: number;
  skipped: number;
  failed: number;
  need: number;
  quiet: number;
  working: number;
  done: number;
  total: number;
}

function resolveCellClass(token: StripCell): string {
  switch (token) {
    case "planned": return "planned";
    case "scheduled": return "pending";
    case "working": return "work";
    case "finishing": return "finishing";
    case "no-update": return "quiet";
    case "waiting-on-you": return "need";
    case "failed": return "fail";
    case "skipped": return "stop";
    case "done": return "done";
    case "unknown": return "unknown";
  }
}

function incrementStateCount(bucket: StripCounts, stateItem: StripCell): void {
  bucket.total += 1;
  switch (stateItem) {
    case "planned":
      bucket.planned += 1;
      break;
    case "scheduled":
      bucket.scheduled += 1;
      break;
    case "working":
    case "finishing":
      bucket.working += 1;
      break;
    case "no-update":
      bucket.quiet += 1;
      break;
    case "waiting-on-you":
      bucket.need += 1;
      break;
    case "failed":
      bucket.failed += 1;
      break;
    case "skipped":
      bucket.skipped += 1;
      break;
    case "done":
      bucket.done += 1;
      break;
    case "unknown":
      bucket.unknown += 1;
      break;
  }
}

export function stripCounts(groups: readonly (readonly StripCell[])[]): StripCounts {
  const tally: StripCounts = {
    total: 0,
    done: 0,
    working: 0,
    quiet: 0,
    need: 0,
    failed: 0,
    skipped: 0,
    unknown: 0,
    scheduled: 0,
    planned: 0,
  };

  for (const cluster of groups) {
    for (const cellItem of cluster) {
      incrementStateCount(tally, cellItem);
    }
  }

  return tally;
}

export function stripLabel(
  groups: readonly (readonly StripCell[])[],
  options: { stale?: boolean; more?: boolean } = {},
): string {
  const tally = stripCounts(groups);
  if (tally.total === 0) {
    return options.more ? "No agents scheduled yet, more may start" : "No agents scheduled yet";
  }

  const activePhaseCount = groups.filter((cellList) => cellList.length > 0).length;
  const descriptiveTokens: string[] = [];

  if (tally.done > 0) descriptiveTokens.push(`${tally.done} done`);
  if (tally.need > 0) descriptiveTokens.push(`${tally.need} ${tally.need === 1 ? "needs" : "need"} you`);
  if (tally.failed > 0) descriptiveTokens.push(`${tally.failed} failed`);
  if (tally.quiet > 0) descriptiveTokens.push(`${tally.quiet} no update`);
  if (tally.working > 0) descriptiveTokens.push(`${tally.working} working`);
  if (tally.scheduled > 0) descriptiveTokens.push(`${tally.scheduled} queued`);
  if (tally.planned > 0) descriptiveTokens.push(`${tally.planned} planned`);
  if (tally.skipped > 0) descriptiveTokens.push(`${tally.skipped} skipped`);
  if (tally.unknown > 0) descriptiveTokens.push(`${tally.unknown} ${tally.unknown === 1 ? "outcome" : "outcomes"} not reported`);
  if (options.more) descriptiveTokens.push("more may start");

  const agentPlurality = tally.total === 1 ? "agent" : "agents";
  const phaseQualifier = activePhaseCount > 1 ? ` in ${activePhaseCount} phases` : "";
  const staleQualifier = options.stale ? ", last known" : "";
  const headerPrefix = `${tally.total} ${agentPlurality}${phaseQualifier}${staleQualifier}`;

  return `${headerPrefix}: ${descriptiveTokens.join(", ")}`;
}

interface SegmentItem {
  categoryKey: string;
  countValue: number;
}

function ProportionalBarView({
  cellGroup,
  isStaleFeed,
  targetWidth,
}: {
  cellGroup: readonly StripCell[];
  isStaleFeed: boolean;
  targetWidth: number | undefined;
}) {
  const tally = stripCounts([cellGroup]);
  const categories: readonly SegmentItem[] = [
    { categoryKey: "done", countValue: tally.done },
    { categoryKey: "work", countValue: tally.working },
    { categoryKey: "quiet", countValue: tally.quiet },
    { categoryKey: "need", countValue: tally.need },
    { categoryKey: "fail", countValue: tally.failed },
    { categoryKey: "stop", countValue: tally.skipped },
    { categoryKey: "unknown", countValue: tally.unknown },
    { categoryKey: "pending", countValue: tally.scheduled + tally.planned },
  ];

  const inlineCss: CSSProperties | undefined = targetWidth === undefined
    ? undefined
    : ({ "--bw": `${targetWidth}px` } as CSSProperties);

  return (
    <span className={cn("crew-bin", isStaleFeed && "stale")} style={inlineCss}>
      {categories
        .filter((entry) => entry.countValue > 0)
        .map((entry) => {
          const percentageRatio = ((entry.countValue / tally.total) * 100).toFixed(1);
          return (
            <span
              key={entry.categoryKey}
              className={entry.categoryKey}
              style={{ width: `${percentageRatio}%` }}
            />
          );
        })}
    </span>
  );
}

function areGroupArraysEqual(
  prevCollection: StripProps["groups"],
  nextCollection: StripProps["groups"],
): boolean {
  if (prevCollection.length !== nextCollection.length) return false;
  return prevCollection.every((sublist, rowIdx) => {
    const counterpart = nextCollection[rowIdx];
    if (sublist.length !== counterpart.length) return false;
    return sublist.every((cellVal, colIdx) => cellVal === counterpart[colIdx]);
  });
}

export const Strip = memo(
  function Strip(props: StripProps) {
    const {
      groups,
      size: stripSize = "sm",
      finale: isFinale = false,
      sheen: hasSheen = false,
      stale: isStale = false,
      more: hasMore = false,
      binAt: binThreshold = 48,
      bin: binMode = "phase",
      binWidth: binPixelWidth,
      label: customLabel,
      decorative: isDecorative = false,
      className: extraClassName,
    } = props;

    const nonEmpties = groups.filter((arr) => arr.length > 0);
    const sumCells = nonEmpties.reduce((accum, currList) => accum + currList.length, 0);

    const renderCellNode = (styleModifier: string, keyIdentifier: number): ReactNode => (
      <span
        key={keyIdentifier}
        className={cn("crew-cell", styleModifier, isStale && "stale")}
      />
    );

    const ariaDescriptors = isDecorative
      ? { "aria-hidden": true as const }
      : { role: "img", "aria-label": customLabel ?? stripLabel(groups, { stale: isStale, more: hasMore }) };

    const shouldBinEntireRun = binMode === "run" && sumCells > binThreshold;
    const computedRootClasses = cn(
      "crew-strip",
      stripSize !== "sm" && stripSize,
      isFinale && "finale",
      isStale && "stale",
      isFinale && hasSheen && "crew-sheen",
      extraClassName,
    );

    return (
      <span {...ariaDescriptors} className={computedRootClasses}>
        {shouldBinEntireRun ? (
          <ProportionalBarView
            cellGroup={nonEmpties.flat()}
            isStaleFeed={isStale}
            targetWidth={binPixelWidth}
          />
        ) : (
          nonEmpties.map((phaseRow, phaseIdx) => {
            if (phaseRow.length > binThreshold) {
              return (
                <ProportionalBarView
                  key={phaseIdx}
                  cellGroup={phaseRow}
                  isStaleFeed={isStale}
                  targetWidth={binPixelWidth}
                />
              );
            }
            return (
              <span key={phaseIdx} className="crew-phase">
                {phaseRow.map((agentState, itemIdx) =>
                  renderCellNode(resolveCellClass(agentState), itemIdx),
                )}
              </span>
            );
          })
        )}
        {hasMore ? <span className="crew-phase">{renderCellNode("more", 0)}</span> : null}
      </span>
    );
  },
  (prevProps, nextProps) => {
    const combinedKeys = Object.keys({ ...prevProps, ...nextProps }) as (keyof StripProps)[];
    return combinedKeys.every((propKey) => {
      if (propKey === "groups") {
        return areGroupArraysEqual(prevProps.groups, nextProps.groups);
      }
      return Object.is(prevProps[propKey], nextProps[propKey]);
    });
  },
);
