import { memo, useMemo } from "react";
import { useApp, useController } from "../../app/context.js";
import { durationText, runLive, swarmView, type RunVM } from "../../model/swarm.js";
import type { MspItem } from "../../types.js";
import { ArrowLineDownIcon, FlowArrowIcon } from "../ui/icons.js";
import { cn } from "../ui/primitives.js";
import { plural } from "./cardCopy.js";
import { focusSwarmCard, reportVisible } from "./SwarmCard.js";

/** The transcript's one line for a run: `Started workflow … · 10 agents in 4 phases · in the dock` (SPEC §2.2). */
export function anchorText(run: RunVM): { verb: string; text: string } {
  const scheduled = run.counts.total - run.counts.planned;
  const agents = plural(run.plannedKnown ? run.counts.total : scheduled, "agent");
  if (runLive(run)) {
    const phases = run.phases.filter((phase) => phase.state !== "planned" || run.plannedKnown).length;
    return { verb: "Started workflow", text: `${run.name} · ${agents}${phases > 1 ? ` in ${phases} phases` : ""}` };
  }
  const verb = run.status === "stopped" ? "Workflow stopped" : run.status === "failed" ? "Workflow failed" : "Workflow finished";
  const elapsed = run.elapsedMs !== null ? ` · ${durationText(run.elapsedMs)}` : "";
  return { verb, text: `${run.name} · ${plural(scheduled, "agent")}${elapsed}` };
}

/**
 * The `kind: "workflow"` item in the transcript renders as this row and nothing else: the run itself lives in the
 * dock, and the link at the right takes you there.
 */
export const SwarmAnchorRow = memo(function SwarmAnchorRow(props: { item: MspItem; sessionId?: string }) {
  const controller = useController();
  const { item, sessionId } = props;
  const dismissed = useApp((s) => (sessionId ? s.swarm.dismissedReports.includes(`${sessionId}:${item.itemId}`) : false));
  const run = useMemo(() => {
    const state = controller.store.get();
    const fold = sessionId ? state.threads[sessionId]?.fold : undefined;
    const session = sessionId ? (state.sessions[sessionId] ?? null) : null;
    if (!fold) return null;
    return swarmView(fold, session, Date.now(), { models: state.models }).runs.find((candidate) => candidate.itemId === item.itemId) ?? null;
  }, [controller, item, sessionId]);
  if (!run) {
    return (
      <div className="swarm-anchor" data-swarm-anchor={item.itemId}>
        <FlowArrowIcon size={14} />
        <span className="verb">Workflow</span>
      </div>
    );
  }
  const live = runLive(run);
  const { verb, text } = anchorText(run);
  const inDock = live || (sessionId !== undefined && reportVisible(run, Date.now(), dismissed));
  return (
    <div className="swarm-anchor" data-swarm-anchor={item.itemId} aria-label={`${verb} ${text}`}>
      <FlowArrowIcon size={14} />
      <span className="verb">{verb}</span>
      <span className="txt" title={text}>{text}</span>
      {inDock && sessionId ? (
        <button type="button" className={cn("right", live && "live")} onClick={() => focusSwarmCard(controller, sessionId)}>
          <ArrowLineDownIcon size={12} aria-hidden="true" />
          {live ? "in the dock" : "report in the dock"}
        </button>
      ) : null}
    </div>
  );
});
