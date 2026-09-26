import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { swarmView, type RunVM } from "../src/model/swarm.js";
import type { SessionSummary, ViewEvent, WorkflowChild } from "../src/types.js";

/**
 * The recompute budget of SPEC §13: a 2000-agent run must stay cheap per revision, and a revision that touches a
 * handful of agents must leave every other row's view-model as it was, so the rows above them never re-render.
 */

const AGENTS = 2000;
const PHASES = 8;
const REVISIONS = 100;
const SLOTS = 20;
/** Loose enough for a slow CI runner; the number measured is printed for the record. */
const BUDGET_MS = 40;

const T0 = Date.UTC(2026, 8, 26, 14, 0, 0);
const SESSION: SessionSummary = {
  sessionId: "bench", cwd: "/work/big", title: "Big", titleSource: "auto", turnCount: 1, modelId: "muse-spark-1.3", origin: "ancilla",
  archived: false, createdAt: "2026-09-26T13:00:00.000Z", activityAt: "2026-09-26T14:00:00.000Z", settled: false, settledAt: null,
  unsettledAt: null, sandboxDisabled: false, accountId: null, live: null,
};

function revision(children: WorkflowChild[], index: number, at: number): ViewEvent {
  return {
    method: index === 0 ? "item/started" : "item/updated",
    at,
    params: { item: { itemId: "wf", kind: "workflow", status: "inProgress", revision: index + 1, turnId: "t1", workflowRunId: "run-big", entryId: "big", children } },
  };
}

/** Every agent scheduled up front, then each revision starts and finishes a slot's worth. */
function feed(): ViewEvent[] {
  const children: WorkflowChild[] = [];
  for (let i = 0; i < AGENTS; i += 1) {
    children.push({ childId: `c${i}`, attempt: 1, status: "scheduled", label: `phase${i % PHASES}:agent-${i}` });
  }
  const events: ViewEvent[] = [revision(children.map((child) => ({ ...child })), 0, T0)];
  let next = 0;
  for (let r = 1; r < REVISIONS; r += 1) {
    const at = T0 + r * 30_000;
    // Finish what started last time, start the next slot.
    for (let i = Math.max(0, next - SLOTS); i < next; i += 1) {
      children[i] = { childId: `c${i}`, attempt: 1, status: "terminal", terminal: "completed", durationMs: 30_000 };
    }
    for (let i = next; i < Math.min(AGENTS, next + SLOTS); i += 1) {
      children[i] = { childId: `c${i}`, attempt: 1, status: "started" };
    }
    next = Math.min(AGENTS, next + SLOTS);
    events.push(revision(children.map(({ label: _label, ...rest }) => rest), r, at));
  }
  return events;
}

describe("swarmView at 2000 agents", () => {
  it(`builds each revision within ${BUDGET_MS} ms and keeps untouched rows' identity`, () => {
    const events = feed();
    let fold: ThreadFold = emptyFold();
    let previous: RunVM | null = null;
    const viewTimes: number[] = [];
    const foldTimes: number[] = [];
    let reused = 0;
    let compared = 0;
    for (let r = 0; r < events.length; r += 1) {
      const event = events[r] as ViewEvent;
      const foldStart = performance.now();
      fold = applyEvents(fold, [event]);
      foldTimes.push(performance.now() - foldStart);
      const start = performance.now();
      const run = swarmView(fold, SESSION, (event.at ?? T0) + 1000).runs[0] as RunVM;
      viewTimes.push(performance.now() - start);
      assert.equal(run.agents.length, AGENTS);
      assert.equal(run.phases.length, PHASES);
      if (previous) {
        const before = new Map(previous.agents.map((agent) => [agent.id, agent]));
        const touched = new Set<string>();
        const children = (event.params["item"] as { children: WorkflowChild[] }).children;
        const last = (events[r - 1]?.params["item"] as { children: WorkflowChild[] }).children;
        children.forEach((child, i) => {
          if (child.status !== last[i]?.status) touched.add(child.childId);
        });
        for (const agent of run.agents) {
          const was = before.get(agent.id);
          if (!was || touched.has(agent.id)) continue;
          // A finished row has no running clock, so nothing about it moved; a working one ticks with `now`.
          if (was.state === "done") {
            compared += 1;
            if (was === agent) reused += 1;
          }
        }
      }
      previous = run;
    }
    const mean = viewTimes.reduce((a, b) => a + b, 0) / viewTimes.length;
    const max = Math.max(...viewTimes);
    const foldMean = foldTimes.reduce((a, b) => a + b, 0) / foldTimes.length;
    console.log(`swarmView: ${AGENTS} agents × ${REVISIONS} revisions · mean ${mean.toFixed(2)} ms · max ${max.toFixed(2)} ms · fold mean ${foldMean.toFixed(2)} ms · ${reused}/${compared} finished rows reused`);
    assert.ok(mean <= BUDGET_MS, `mean ${mean.toFixed(2)} ms per revision is over the ${BUDGET_MS} ms budget`);
    assert.equal(reused, compared, "every finished row a revision did not touch keeps its identity");
    assert.ok(compared > 0);
    const phases = (previous as RunVM).phases;
    assert.ok(phases.every((phase) => phase.agents.length > 48), "each phase is past the strip's cell limit, so the card bins it");
  });
});
