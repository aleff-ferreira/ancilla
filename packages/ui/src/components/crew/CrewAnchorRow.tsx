import { memo, useMemo } from "react";
import { useApp, useController } from "../../app/context.js";
import { durationText, runLive, crewView, type RunVM } from "../../model/crew.js";
import type { MspItem } from "../../types.js";
import { ArrowLineDownIcon, FlowArrowIcon } from "../ui/icons.js";
import { cn } from "../ui/primitives.js";
import { plural } from "./cardCopy.js";
import { focusCrewCard, reportVisible } from "./CrewCard.js";

function pickStatusVerb(status: RunVM["status"]): string {
  switch (status) {
    case "stopped": return "Workflow stopped";
    case "failed": return "Workflow failed";
    default: return "Workflow finished";
  }
}

export function anchorText(run: RunVM): { verb: string; text: string } {
  const scheduledCount = run.counts.total - run.counts.planned;
  const tally = run.plannedKnown ? run.counts.total : scheduledCount;
  const agentWord = plural(tally, "agent");

  if (runLive(run)) {
    const validPhases = run.phases.filter((p) => p.state !== "planned" || run.plannedKnown);
    const phaseNote = validPhases.length > 1 ? ` in ${validPhases.length} phases` : "";
    return {
      verb: "Started workflow",
      text: `${run.name} · ${agentWord}${phaseNote}`,
    };
  }

  const finishedPhrase = pickStatusVerb(run.status);
  const runtimeSuffix = run.elapsedMs !== null ? ` · ${durationText(run.elapsedMs)}` : "";
  const scheduledAgents = plural(scheduledCount, "agent");
  return {
    verb: finishedPhrase,
    text: `${run.name} · ${scheduledAgents}${runtimeSuffix}`,
  };
}

export const CrewAnchorRow = memo(function CrewAnchorRow(props: { item: MspItem; sessionId?: string }) {
  const controller = useController();
  const { item, sessionId } = props;
  const dismissedRecord = useApp((st) => {
    if (!sessionId) return false;
    const lookupKey = `${sessionId}:${item.itemId}`;
    return st.crew.dismissedReports.includes(lookupKey);
  });

  const matchingRun = useMemo(() => {
    if (!sessionId) return null;
    const stateTree = controller.store.get();
    const threadFold = stateTree.threads[sessionId]?.fold;
    const sessionRecord = stateTree.sessions[sessionId] ?? null;
    if (!threadFold) return null;

    const inspected = crewView(threadFold, sessionRecord, Date.now(), { models: stateTree.models });
    return inspected.runs.find((entry) => entry.itemId === item.itemId) ?? null;
  }, [controller, item.itemId, sessionId]);

  if (!matchingRun) {
    return (
      <div data-crew-anchor={item.itemId} className="crew-anchor">
        <FlowArrowIcon size={14} />
        <span className="verb">Workflow</span>
      </div>
    );
  }

  const activeLive = runLive(matchingRun);
  const anchorSummary = anchorText(matchingRun);
  const hasDockLink = activeLive || (Boolean(sessionId) && reportVisible(matchingRun, Date.now(), dismissedRecord));
  const navigationPrompt = activeLive ? "in the dock" : "report in the dock";

  const onJumpToDock = () => {
    if (sessionId) {
      focusCrewCard(controller, sessionId);
    }
  };

  return (
    <div
      data-crew-anchor={item.itemId}
      className="crew-anchor"
      aria-label={`${anchorSummary.verb} ${anchorSummary.text}`}
    >
      <FlowArrowIcon size={14} />
      <span className="verb">{anchorSummary.verb}</span>
      <span className="txt" title={anchorSummary.text}>{anchorSummary.text}</span>
      {hasDockLink && sessionId ? (
        <button
          type="button"
          onClick={onJumpToDock}
          className={cn("right", activeLive && "live")}
        >
          <ArrowLineDownIcon size={12} aria-hidden="true" />
          {navigationPrompt}
        </button>
      ) : null}
    </div>
  );
});
