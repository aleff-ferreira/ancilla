import { useMemo } from "react";
import { CaretDownIcon, CaretLeftIcon, CaretUpIcon, XCircleIcon } from "../ui/icons.js";
import type { AgentVM, RunVM } from "../../model/crew.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, cn } from "../ui/primitives.js";
import { Callout, Compared, FactsList, HonestyNote, Identity, LifecycleList, ResultTab, Section, TaskSection, factsOf, lifecycleItems } from "./InspectorSections.js";
import type { RowAction, RowConfirm } from "./RosterRow.js";

export type InspectorTab = "overview" | "lifecycle" | "result";

export interface InspectorProps {
  run: RunVM | null;
  agent: AgentVM;
  tab: InspectorTab;
  /** `column` beside the roster in a wide panel, `full` in place of it. */
  layout: "column" | "full";
  /** The session's model, for the model fact. */
  model: string | null;
  readOnly: boolean;
  stale: boolean;
  confirm: RowConfirm | null;
  hasPrevious: boolean;
  hasNext: boolean;
  onTab(tab: InspectorTab): void;
  onBack(): void;
  onPrevious(): void;
  onNext(): void;
  onAction(agent: AgentVM, action: RowAction): void;
  onConfirm(confirm: RowConfirm | null): void;
  className?: string;
}

const TABS: { key: InspectorTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "lifecycle", label: "Lifecycle" },
  { key: "result", label: "Result" },
];

/**
 * One agent, inside the panel: identity, the state's callout, three tabs. Overview stacks what happened, the task,
 * the facts (never blank), the comparison with the run and the honesty note; Lifecycle shows every attempt in full;
 * Result says what Muse shares, which for a workflow agent is only the run's report.
 */
export function Inspector(props: InspectorProps) {
  const { agent, run } = props;
  const items = useMemo(() => lifecycleItems(agent, run), [agent, run]);
  const facts = useMemo(() => factsOf(agent, run, props.model), [agent, run, props.model]);
  const attempts = [...new Set(items.map((item) => item.attempt))];
  return (
    <div
      className={cn("flex min-h-0 flex-col", props.layout === "column" ? "w-[360px] shrink-0" : "flex-1", props.className)}
      data-inspector={props.layout}
      aria-label={`Inspector: ${agent.name}`}
    >
      {props.layout === "column" ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-2 pl-3">
          <button type="button" onClick={props.onBack} className="inline-flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-sm text-muted hover:bg-hover hover:text-fg">
            <CaretLeftIcon size={12} className="shrink-0 text-subtle" />
            <span className="truncate">back to the run</span>
          </button>
          <Tip label="Previous agent" shortcut={["k"]}>
            <IconButton size="xs" label="Previous agent" disabled={!props.hasPrevious} onClick={props.onPrevious}><CaretUpIcon size={13} /></IconButton>
          </Tip>
          <Tip label="Next agent" shortcut={["j"]}>
            <IconButton size="xs" label="Next agent" disabled={!props.hasNext} onClick={props.onNext}><CaretDownIcon size={13} /></IconButton>
          </Tip>
          <Tip label="Close the inspector" shortcut={["Esc"]}>
            <IconButton size="xs" label="Close the inspector" onClick={props.onBack}><XCircleIcon size={14} /></IconButton>
          </Tip>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Identity agent={agent} stale={props.stale} />
        <Callout agent={agent} run={run} readOnly={props.readOnly} confirm={props.confirm} onAction={props.onAction} onConfirm={props.onConfirm} />
        <div role="tablist" aria-label="Inspector sections" className="mt-3 flex gap-[18px] border-b border-line px-4">
          {TABS.map((tab, index) => {
            const on = tab.key === props.tab;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={on}
                data-tab={tab.key}
                onClick={() => props.onTab(tab.key)}
                className={cn(
                  "relative inline-flex h-[34px] items-center gap-1.5 text-sm font-medium whitespace-nowrap outline-none",
                  on ? "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-sm after:bg-fg after:content-['']" : "text-subtle hover:text-fg",
                )}
              >
                {tab.label}
                {tab.key === "lifecycle" ? <span className="inline-flex h-[15px] min-w-[18px] items-center justify-center rounded-full bg-active px-1 text-[10.5px] leading-[15px] text-muted tabular-nums">{items.length}</span> : null}
                <span className="sr-only">, press {index + 1}</span>
              </button>
            );
          })}
        </div>
        {props.tab === "overview" ? (
          <>
            <Section title="What happened">
              <LifecycleList items={items} />
            </Section>
            <TaskSection agent={agent} />
            <Section title="Facts">
              <FactsList facts={facts} />
            </Section>
            {run ? <Compared agent={agent} run={run} /> : null}
            <HonestyNote agent={agent} />
          </>
        ) : props.tab === "lifecycle" ? (
          <>
            {attempts.map((attempt) => (
              <Section key={attempt} title={attempt === 0 ? "Planned" : attempts.length > 1 ? `Attempt ${attempt}` : "Attempt 1"} aside={attemptAside(agent, attempt)}>
                <LifecycleList items={items.filter((item) => item.attempt === attempt)} />
              </Section>
            ))}
            <HonestyNote agent={agent} />
          </>
        ) : (
          <>
            <ResultTab agent={agent} run={run} />
            <HonestyNote agent={agent} />
          </>
        )}
      </div>
    </div>
  );
}

function attemptAside(agent: AgentVM, attempt: number): string | null {
  const found = agent.attempts.find((candidate) => candidate.attempt === attempt);
  if (!found) return null;
  switch (found.outcome) {
    case "done": return "landed";
    case "failed": return "failed";
    case "skipped": return "cancelled";
    case "unknown": return "outcome not reported";
    default: return agent.pending === "retry" ? null : "under way";
  }
}
