import { useMemo, type ReactElement } from "react";
import { CaretDownIcon, CaretLeftIcon, CaretUpIcon, XCircleIcon } from "../ui/icons.js";
import type { AgentVM, RunVM } from "../../model/crew.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, cn } from "../ui/primitives.js";
import {
  Callout,
  Compared,
  FactsList,
  HonestyNote,
  Identity,
  LifecycleList,
  ResultTab,
  Section,
  TaskSection,
  factsOf,
  lifecycleItems,
  type Fact,
  type LifeItem,
} from "./InspectorSections.js";
import type { RowAction, RowConfirm } from "./RosterRow.js";

export type InspectorTab = "overview" | "lifecycle" | "result";

export interface InspectorProps {
  readonly agent: AgentVM;
  readonly run: RunVM | null;
  readonly tab: InspectorTab;
  /** `column` beside the roster in a wide panel, `full` in place of it. */
  readonly layout: "column" | "full";
  /** The session's model, for the model fact. */
  readonly model: string | null;
  readonly readOnly: boolean;
  readonly stale: boolean;
  readonly confirm: RowConfirm | null;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  className?: string;
  onTab: (tab: InspectorTab) => void;
  onBack: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onAction: (agent: AgentVM, action: RowAction) => void;
  onConfirm: (confirm: RowConfirm | null) => void;
}

interface TabSpec {
  readonly id: InspectorTab;
  readonly caption: string;
}

const TAB_NAVIGATION_ITEMS: readonly TabSpec[] = Object.freeze([
  { id: "overview", caption: "Overview" },
  { id: "lifecycle", caption: "Lifecycle" },
  { id: "result", caption: "Result" },
]);

const ASIDE_STATUS_LOOKUP: Readonly<Record<string, string>> = Object.freeze({
  done: "landed",
  failed: "failed",
  skipped: "cancelled",
  unknown: "outcome not reported",
});

function computeAttemptAnnotation(activeAgent: AgentVM, attemptIdx: number): string | null {
  const matchingAttempt = activeAgent.attempts.find((att) => att.attempt === attemptIdx);
  if (!matchingAttempt) {
    return null;
  }
  const outcomeKey = matchingAttempt.outcome;
  const statusSummary = outcomeKey ? ASIDE_STATUS_LOOKUP[outcomeKey] : undefined;
  if (statusSummary !== undefined) {
    return statusSummary;
  }
  return activeAgent.pending === "retry" ? null : "under way";
}

function computeSectionHeader(attemptIdx: number, distinctCount: number): string {
  if (attemptIdx === 0) {
    return "Planned";
  }
  return distinctCount > 1 ? `Attempt ${attemptIdx}` : "Attempt 1";
}

interface ColumnNavToolbarProps {
  readonly canGoPrev: boolean;
  readonly canGoNext: boolean;
  onNavigateBack: () => void;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
}

const SHORTCUT_PREV = Object.freeze(["k"]);
const SHORTCUT_NEXT = Object.freeze(["j"]);
const SHORTCUT_ESC = Object.freeze(["Esc"]);

function ColumnNavToolbar({
  canGoPrev,
  canGoNext,
  onNavigateBack,
  onNavigatePrev,
  onNavigateNext,
}: ColumnNavToolbarProps): ReactElement {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-2 pl-3">
      <button
        type="button"
        onClick={onNavigateBack}
        className="inline-flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-sm text-muted hover:bg-hover hover:text-fg"
      >
        <CaretLeftIcon className="shrink-0 text-subtle" size={12} />
        <span className="truncate">{"back to the run"}</span>
      </button>
      <Tip label="Previous agent" shortcut={SHORTCUT_PREV}>
        <IconButton
          size="xs"
          label="Previous agent"
          disabled={!canGoPrev}
          onClick={onNavigatePrev}
        >
          <CaretUpIcon size={13} />
        </IconButton>
      </Tip>
      <Tip label="Next agent" shortcut={SHORTCUT_NEXT}>
        <IconButton
          size="xs"
          label="Next agent"
          disabled={!canGoNext}
          onClick={onNavigateNext}
        >
          <CaretDownIcon size={13} />
        </IconButton>
      </Tip>
      <Tip label="Close the inspector" shortcut={SHORTCUT_ESC}>
        <IconButton
          size="xs"
          label="Close the inspector"
          onClick={onNavigateBack}
        >
          <XCircleIcon size={14} />
        </IconButton>
      </Tip>
    </div>
  );
}

interface TabBarNavigationProps {
  readonly activeTab: InspectorTab;
  readonly stepCount: number;
  onSelectTab: (tab: InspectorTab) => void;
}

function TabBarNavigation({
  activeTab,
  stepCount,
  onSelectTab,
}: TabBarNavigationProps): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="Inspector sections"
      className="mt-3 flex gap-[18px] border-b border-line px-4"
    >
      {TAB_NAVIGATION_ITEMS.map((tabItem, itemIndex) => {
        const isCurrent = tabItem.id === activeTab;
        return (
          <button
            key={tabItem.id}
            type="button"
            role="tab"
            aria-selected={isCurrent}
            data-tab={tabItem.id}
            onClick={() => onSelectTab(tabItem.id)}
            className={cn(
              "relative inline-flex h-[34px] items-center gap-1.5 text-sm font-medium whitespace-nowrap outline-none",
              isCurrent
                ? "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-sm after:bg-fg after:content-['']"
                : "text-subtle hover:text-fg",
            )}
          >
            {tabItem.caption}
            {tabItem.id === "lifecycle" ? (
              <span className="inline-flex h-[15px] min-w-[18px] items-center justify-center rounded-full bg-active px-1 text-[10.5px] leading-[15px] text-muted tabular-nums">
                {stepCount}
              </span>
            ) : null}
            <span className="sr-only">, press {itemIndex + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

interface OverviewPanelProps {
  readonly targetAgent: AgentVM;
  readonly activeRun: RunVM | null;
  readonly events: readonly LifeItem[];
  readonly facts: readonly Fact[];
}

function OverviewTabContent({
  targetAgent,
  activeRun,
  events,
  facts,
}: OverviewPanelProps): ReactElement {
  return (
    <>
      <Section title="What happened">
        <LifecycleList items={events as LifeItem[]} />
      </Section>
      <TaskSection agent={targetAgent} />
      <Section title="Facts">
        <FactsList facts={facts as Fact[]} />
      </Section>
      {activeRun ? <Compared agent={targetAgent} run={activeRun} /> : null}
      <HonestyNote agent={targetAgent} />
    </>
  );
}

interface LifecyclePanelProps {
  readonly targetAgent: AgentVM;
  readonly events: readonly LifeItem[];
  readonly attemptList: readonly number[];
}

function LifecycleTabContent({
  targetAgent,
  events,
  attemptList,
}: LifecyclePanelProps): ReactElement {
  return (
    <>
      {attemptList.map((attemptNum) => (
        <Section
          key={attemptNum}
          title={computeSectionHeader(attemptNum, attemptList.length)}
          aside={computeAttemptAnnotation(targetAgent, attemptNum)}
        >
          <LifecycleList
            items={events.filter((ev) => ev.attempt === attemptNum)}
          />
        </Section>
      ))}
      <HonestyNote agent={targetAgent} />
    </>
  );
}

/**
 * Inspector panel: presents details for an active or finished agent.
 * Includes identity banner, state callouts, and three tabs:
 * overview metrics, comprehensive lifecycle log, and final result.
 */
export function Inspector(props: InspectorProps): ReactElement {
  const selectedAgent = props.agent;
  const parentRun = props.run;

  const timelineEntries = useMemo(
    () => lifecycleItems(selectedAgent, parentRun),
    [selectedAgent, parentRun],
  );

  const parsedFacts = useMemo(
    () => factsOf(selectedAgent, parentRun, props.model),
    [selectedAgent, parentRun, props.model],
  );

  const attemptIds = useMemo(
    () => Array.from(new Set(timelineEntries.map((ev) => ev.attempt))),
    [timelineEntries],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        props.layout === "column" ? "w-[360px] shrink-0" : "flex-1",
        props.className,
      )}
      data-inspector={props.layout}
      aria-label={`Inspector: ${selectedAgent.name}`}
    >
      {props.layout === "column" ? (
        <ColumnNavToolbar
          canGoPrev={props.hasPrevious}
          canGoNext={props.hasNext}
          onNavigateBack={props.onBack}
          onNavigatePrev={props.onPrevious}
          onNavigateNext={props.onNext}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Identity agent={selectedAgent} stale={props.stale} />

        <Callout
          agent={selectedAgent}
          run={parentRun}
          readOnly={props.readOnly}
          confirm={props.confirm}
          onAction={props.onAction}
          onConfirm={props.onConfirm}
        />

        <TabBarNavigation
          activeTab={props.tab}
          stepCount={timelineEntries.length}
          onSelectTab={props.onTab}
        />

        {props.tab === "overview" ? (
          <OverviewTabContent
            targetAgent={selectedAgent}
            activeRun={parentRun}
            events={timelineEntries}
            facts={parsedFacts}
          />
        ) : props.tab === "lifecycle" ? (
          <LifecycleTabContent
            targetAgent={selectedAgent}
            events={timelineEntries}
            attemptList={attemptIds}
          />
        ) : (
          <>
            <ResultTab agent={selectedAgent} run={parentRun} />
            <HonestyNote agent={selectedAgent} />
          </>
        )}
      </div>
    </div>
  );
}
