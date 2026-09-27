import { Dialog as RDialog } from "radix-ui";
import { InfoIcon, PulseIcon, StopCircleIcon, XCircleIcon } from "../ui/icons.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import type { AncillaController } from "../../model/controller.js";
import type { AppState } from "../../model/store.js";
import { activityView, runLive, summaryLine, crewView, type ActivityItemVM, type ActivityVM } from "../../model/crew.js";
import { IconButton, MOD, Shortcut, cn } from "../ui/primitives.js";
import { ActivityItem, XS_GHOST, XS_SECONDARY, activityKey, stoppable, type ActivityRunExtra } from "./ActivityItem.js";

/**
 * The Activity drawer: every request waiting anywhere, then what runs and what finished today in the threads this
 * client folds, over the sidebar. It is the one cross-thread view; the card and the panel stay with their thread.
 */

export type ActivityFilter = "all" | "needs" | "running" | "finished";

export interface ActivityDrawerProps {
  open: boolean;
  view: ActivityVM;
  filter: ActivityFilter;
  /** The clock the elapsed times count from. */
  now: number;
  /** Strip cells and chips for the run items, by `activityKey`. */
  runs?: Readonly<Record<string, ActivityRunExtra>>;
  /** What Stop everything would stop in the open thread, by name, for the confirm. */
  stopNames?: { runs: readonly string[]; tasks: readonly string[] } | null;
  /** The sidebar's width; under 900 px the drawer takes it plus 200. */
  sidebarWidth?: number;
  onFilter(filter: ActivityFilter): void;
  onOpen(item: ActivityItemVM): void;
  onStop(item: ActivityItemVM): void;
  onStopAll(): void;
  onClose(): void;
}

export interface ActivitySection {
  id: Exclude<ActivityFilter, "all">;
  title: string;
  items: ActivityItemVM[];
}

/** The filters in chip order, with the digit that picks each. */
export const FILTERS: readonly { id: ActivityFilter; label: string; key: string }[] = [
  { id: "all", label: "All", key: "1" },
  { id: "needs", label: "Needs you", key: "2" },
  { id: "running", label: "Working", key: "3" },
  { id: "finished", label: "Finished today", key: "4" },
];

export function sectionsOf(view: ActivityVM): ActivitySection[] {
  return [
    { id: "needs", title: "Needs you", items: view.needsYou },
    { id: "running", title: "Working", items: view.working },
    { id: "finished", title: "Finished today", items: view.finishedToday },
  ];
}

/** Every section with something in it, or the one the filter names even when it is empty. */
export function visibleSections(view: ActivityVM, filter: ActivityFilter): ActivitySection[] {
  return sectionsOf(view).filter((section) => (filter === "all" ? section.items.length > 0 : section.id === filter));
}

export type DrawerKeyAction =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "open" }
  | { kind: "stop" }
  | { kind: "filter"; filter: ActivityFilter };

/** The drawer's keys: `j`/`k` and the arrows move, `Enter` opens, `x` stops, `1` to `4` filter. Escape is the dialog's. */
export function drawerKeyAction(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target?: EventTarget | null }): DrawerKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  const el = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = el?.tagName ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable === true) {
    return null;
  }
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "k":
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "Enter":
      // A focused button keeps its own Enter.
      return tag === "BUTTON" || tag === "A" ? null : { kind: "open" };
    case "x":
      return { kind: "stop" };
    default: {
      const filter = FILTERS.find((candidate) => candidate.key === event.key);
      return filter ? { kind: "filter", filter: filter.id } : null;
    }
  }
}

function stopList(stopAll: { runs: number; tasks: number }): string {
  const parts: string[] = [];
  if (stopAll.runs > 0) {
    parts.push(`${stopAll.runs} ${stopAll.runs === 1 ? "run" : "runs"}`);
  }
  if (stopAll.tasks > 0) {
    parts.push(`${stopAll.tasks} ${stopAll.tasks === 1 ? "task" : "tasks"}`);
  }
  return parts.join(" and ");
}

/** The foot's sentence while something in the open thread can be stopped. */
export function stopAllText(stopAll: { runs: number; tasks: number }): string {
  return `Stop everything stops ${stopList(stopAll)} in this thread. Approvals stay open.`;
}

/** The question Stop everything asks first. */
export function stopAllQuestion(stopAll: { runs: number; tasks: number }): string {
  return `Stop everything? Stops ${stopList(stopAll)}. Approvals stay open.`;
}

export function ActivityDrawer(props: ActivityDrawerProps) {
  const { view, filter } = props;
  const sections = useMemo(() => visibleSections(view, filter), [view, filter]);
  const items = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const keys = useMemo(() => items.map(activityKey), [items]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const wantFocus = useRef(false);
  // The selection follows the row, not its place, so a list that moves under the keys keeps the row chosen.
  const selectedIndex = Math.max(0, keys.indexOf(selectedKey ?? ""));
  const selected = items[selectedIndex] ?? null;
  const selectedRowKey = selected ? activityKey(selected) : null;

  useEffect(() => {
    if (!wantFocus.current || !selectedRowKey) {
      return;
    }
    wantFocus.current = false;
    const row = rows.current.get(selectedRowKey);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  });

  if (!props.open) {
    return null;
  }

  const move = (delta: 1 | -1) => {
    if (items.length === 0) {
      return;
    }
    const next = Math.min(items.length - 1, Math.max(0, selectedIndex + delta));
    setSelectedKey(keys[next] ?? null);
    wantFocus.current = true;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = drawerKeyAction(event);
    if (!action) {
      return;
    }
    event.preventDefault();
    switch (action.kind) {
      case "move":
        move(action.delta);
        break;
      case "open":
        if (selected) props.onOpen(selected);
        break;
      case "stop":
        if (selected && stoppable(selected)) setConfirmKey(selectedRowKey);
        break;
      case "filter":
        props.onFilter(action.filter);
        break;
    }
  };
  const counts: Record<ActivityFilter, number> = {
    all: view.needsYou.length + view.working.length + view.finishedToday.length,
    needs: view.needsYou.length,
    running: view.working.length,
    finished: view.finishedToday.length,
  };
  const stopNames = [...(props.stopNames?.runs ?? []), ...(props.stopNames?.tasks ?? [])];
  const noteAfter = view.note && filter !== "needs" && filter !== "finished" ? (sections.find((section) => section.id === "running")?.id ?? "end") : null;
  const note = (
    <div className="mx-2 mt-1.5 mb-0.5 flex items-start gap-2 rounded-[10px] bg-sunken px-2.5 py-2 text-xs leading-[18px] text-muted shadow-[inset_0_0_0_1px_var(--border)]">
      <InfoIcon size={13} className="mt-0.5 shrink-0 text-subtle" aria-hidden="true" />
      <span>{view.note}</span>
    </div>
  );

  return (
    <RDialog.Root open onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <RDialog.Overlay className="overlay-fade fixed inset-0 z-[var(--z-overlay)] bg-[oklch(0.1_0.01_255/0.32)]" />
      <RDialog.Content
        ref={content}
        aria-modal="true"
        aria-label="Activity"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const row = selectedRowKey ? rows.current.get(selectedRowKey) : undefined;
          (row ?? content.current)?.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          // A confirm is one level; Escape closes it before it closes the drawer.
          if (confirmKey !== null || confirmAll) {
            event.preventDefault();
            setConfirmKey(null);
            setConfirmAll(false);
          }
        }}
        onKeyDown={onKeyDown}
        style={{ "--sb": `${props.sidebarWidth ?? 284}px` } as CSSProperties}
        className="fixed inset-y-0 left-0 z-[var(--z-modal)] flex w-[min(520px,100vw)] flex-col bg-raised text-fg shadow-pop outline-none transition-[transform,opacity] duration-200 ease-drawer starting:-translate-x-4 starting:opacity-0 motion-reduce:transition-opacity motion-reduce:duration-[120ms] max-[899px]:w-[min(100vw,calc(var(--sb)+200px))]"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2.5 pl-4">
          <RDialog.Title asChild>
            <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold tracking-[-0.01em]">
              <PulseIcon size={16} className="shrink-0 text-subtle" aria-hidden="true" />
              Activity
              <Shortcut keys={[MOD, "Shift", "A"]} className="gap-1" />
            </h2>
          </RDialog.Title>
          <RDialog.Description className="sr-only">Every request waiting for you, and what runs and finished today in the threads Ancilla follows.</RDialog.Description>
          <RDialog.Close asChild>
            <IconButton label="Close">
              <XCircleIcon size={15} />
            </IconButton>
          </RDialog.Close>
        </header>
        <div className="flex shrink-0 gap-1.5 px-4 pt-2.5 pb-1" role="group" aria-label="Show">
          {FILTERS.map((entry) => {
            const on = entry.id === filter;
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={on}
                onClick={() => props.onFilter(entry.id)}
                className={cn(
                  "inline-flex h-6 shrink-0 items-center gap-[5px] rounded-md px-2 text-xs font-medium whitespace-nowrap",
                  on ? "bg-active text-fg" : "text-muted shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover hover:text-fg",
                )}
              >
                {entry.id === "needs" && counts.needs > 0 ? <span className="size-1.5 rounded-full bg-warn" aria-hidden="true" /> : null}
                {entry.label}
                <span className={cn("tabular-nums", on ? "text-muted" : "text-subtle")}>{counts[entry.id]}</span>
              </button>
            );
          })}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {view.empty ? (
            <div className="px-6 py-10 text-center">
              <p className="font-display text-2xl text-fg">All quiet.</p>
              <p className="mt-1 text-sm text-subtle">Nothing runs and nothing waits for you.</p>
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.id} aria-labelledby={`activity-section-${section.id}`}>
                <h3 id={`activity-section-${section.id}`} className="flex h-8 items-center gap-2 px-2 pt-2 text-xs font-medium text-subtle">
                  {section.title}
                  <span className="tabular-nums">{section.items.length}</span>
                </h3>
                {section.items.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-subtle">None right now.</p>
                ) : (
                  <div role="list">
                    {section.items.map((item) => {
                      const key = activityKey(item);
                      return (
                        <ActivityItem
                          key={key}
                          item={item}
                          now={props.now}
                          extra={props.runs?.[key]}
                          selected={key === selectedRowKey}
                          confirming={key === confirmKey}
                          rowRef={(el) => {
                            if (el) rows.current.set(key, el);
                            else rows.current.delete(key);
                          }}
                          onSelect={() => setSelectedKey(key)}
                          onOpen={() => props.onOpen(item)}
                          onStop={() => {
                            setSelectedKey(key);
                            setConfirmKey(key);
                          }}
                          onConfirmStop={() => {
                            setConfirmKey(null);
                            props.onStop(item);
                          }}
                          onCancelStop={() => setConfirmKey(null)}
                        />
                      );
                    })}
                  </div>
                )}
                {noteAfter === section.id ? note : null}
              </section>
            ))
          )}
          {!view.empty && noteAfter === "end" ? note : null}
        </div>
        <footer className="flex min-h-11 shrink-0 items-center gap-3 border-t border-line px-4 py-2 text-xs leading-4 text-subtle">
          {confirmAll && view.stopAll ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block text-fg">{stopAllQuestion(view.stopAll)}</span>
                {stopNames.length > 0 ? <span className="block truncate font-mono text-[11.5px]">{stopNames.join(" · ")}</span> : null}
              </span>
              <button
                type="button"
                className={cn(XS_SECONDARY, "text-danger-text")}
                onClick={() => {
                  setConfirmAll(false);
                  props.onStopAll();
                }}
              >
                <StopCircleIcon size={12} />
                Stop everything
              </button>
              <button type="button" className={XS_GHOST} onClick={() => setConfirmAll(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">{view.stopAll ? stopAllText(view.stopAll) : view.foot}</span>
              {view.stopAll ? (
                <button type="button" className={XS_GHOST} onClick={() => setConfirmAll(true)}>
                  <StopCircleIcon size={12} />
                  Stop everything
                </button>
              ) : null}
            </>
          )}
        </footer>
      </RDialog.Content>
    </RDialog.Root>
  );
}

// ---------------------------------------------------------------- the host

export interface ActivityModel {
  view: ActivityVM;
  runs: Record<string, ActivityRunExtra>;
  stopNames: { runs: string[]; tasks: string[] } | null;
}

function crewOf(state: AppState, sessionId: string, now: number) {
  const thread = state.threads[sessionId];
  if (!thread) {
    return null;
  }
  return crewView(thread.fold, state.sessions[sessionId] ?? null, now, {
    partialHistory: thread.truncated,
    pending: state.crew.pending,
    skipped: state.crew.skipped,
    models: state.models,
    researchRuns: thread.researchRuns,
  });
}

/** The drawer's view, plus what the view-model leaves out: each run's cells and chips, and what Stop everything names. */
export function activityModel(state: AppState, now: number): ActivityModel {
  const view = activityView(state, now);
  const runs: Record<string, ActivityRunExtra> = {};
  const wanted = [...view.working, ...view.finishedToday].filter((item) => item.kind === "run");
  const open = state.route.kind === "thread" ? state.route.sessionId : null;
  const sessions = new Set(wanted.map((item) => item.sessionId));
  if (open !== null && view.stopAll) {
    sessions.add(open);
  }
  let stopNames: ActivityModel["stopNames"] = null;
  for (const sessionId of sessions) {
    const vm = crewOf(state, sessionId, now);
    if (!vm) {
      continue;
    }
    for (const run of vm.runs) {
      const item = wanted.find((candidate) => candidate.sessionId === sessionId && candidate.itemId === run.itemId);
      if (item) {
        runs[activityKey(item)] = { groups: run.phases.map((phase) => phase.agents.map((agent) => agent.state)), chips: summaryLine(run).chips };
      }
    }
    if (sessionId === open && view.stopAll) {
      stopNames = {
        runs: vm.runs.filter((run) => runLive(run) && run.runId !== null).map((run) => run.name),
        tasks: vm.tasks.filter((task) => task.state === "working" || task.state === "no-update" || task.state === "waiting-on-you").map((task) => task.name),
      };
    }
  }
  return { view, runs, stopNames };
}

/** Opens the item's thread, and its card and inspector when the item stands for a run or an agent. */
export function openActivityItem(controller: AncillaController, item: ActivityItemVM): void {
  controller.setActivityOpen(false);
  controller.openThread(item.sessionId);
  if (item.kind === "run" || item.kind === "task") {
    controller.setCardOpen(`crew:${item.sessionId}`, true);
  }
  if (item.kind !== "request" && item.agentId !== null) {
    controller.inspectAgent(item.sessionId, item.agentId);
  }
}

/** Stops the item: a run through its cancel, a task or subagent through the same action the card uses. */
export function stopActivityItem(controller: AncillaController, item: ActivityItemVM): void {
  if (item.kind === "run") {
    if (item.itemId) {
      void controller.stopRun(item.sessionId, item.itemId);
    }
    return;
  }
  const id = item.agentId ?? item.itemId;
  if (!id) {
    return;
  }
  const vm = crewOf(controller.store.get(), item.sessionId, Date.now());
  const agent = vm ? [...vm.tasks, ...vm.subagents].find((candidate) => candidate.id === id) : undefined;
  if (agent) {
    void controller.crewAction(item.sessionId, agent, "stop");
  } else if (item.kind === "task") {
    void controller.taskAction(item.sessionId, "stop", id);
  } else {
    void controller.subagentAction(item.sessionId, "stop", id);
  }
}

/** The drawer on the app's state: nothing while closed, the live view once a second while open. */
export function ActivityDrawerHost() {
  const controller = useController();
  const open = useApp((s) => s.crew.activityOpen);
  const sidebarWidth = useApp((s) => s.prefs.sidebarWidth);
  const state = useApp((s) => (open ? s : null));
  const now = useNow(1000, open);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const model = useMemo(() => (state ? activityModel(state, now) : null), [state, now]);
  if (!open || !model) {
    return null;
  }
  return (
    <ActivityDrawer
      open
      view={model.view}
      runs={model.runs}
      stopNames={model.stopNames}
      now={now}
      filter={filter}
      sidebarWidth={sidebarWidth}
      onFilter={setFilter}
      onOpen={(item) => openActivityItem(controller, item)}
      onStop={(item) => stopActivityItem(controller, item)}
      onStopAll={() => {
        const current = controller.store.get();
        if (current.route.kind === "thread") {
          void controller.stopEverything(current.route.sessionId);
        }
      }}
      onClose={() => controller.setActivityOpen(false)}
    />
  );
}
