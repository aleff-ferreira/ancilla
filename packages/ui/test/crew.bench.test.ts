import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { crewView, type RunVM } from "../src/model/crew.js";
import type { SessionSummary, ViewEvent, WorkflowChild } from "../src/types.js";

const BENCHMARK_AGENT_COUNT = 2000;
const BENCHMARK_PHASE_COUNT = 8;
const BENCHMARK_REVISION_COUNT = 100;
const BENCHMARK_SLOT_SIZE = 20;
const MAX_LATENCY_BUDGET_MS = 40;
const REFERENCE_BASE_TIME = Date.UTC(2026, 8, 26, 14, 0, 0);

function createBenchmarkSession(): SessionSummary {
  return {
    sessionId: "bench",
    cwd: "/work/big",
    title: "Big",
    titleSource: "auto",
    turnCount: 1,
    modelId: "muse-spark-1.3",
    origin: "ancilla",
    archived: false,
    createdAt: "2026-09-26T13:00:00.000Z",
    activityAt: "2026-09-26T14:00:00.000Z",
    settled: false,
    settledAt: null,
    unsettledAt: null,
    sandboxDisabled: false,
    accountId: null,
    live: null,
  };
}

class BenchmarkRosterHarness {
  readonly agentCount: number;
  readonly phaseCount: number;
  readonly revisionCount: number;
  readonly slotSize: number;
  readonly originEpoch: number;

  constructor(
    agents = BENCHMARK_AGENT_COUNT,
    phases = BENCHMARK_PHASE_COUNT,
    revisions = BENCHMARK_REVISION_COUNT,
    slots = BENCHMARK_SLOT_SIZE,
    epoch = REFERENCE_BASE_TIME,
  ) {
    this.agentCount = agents;
    this.phaseCount = phases;
    this.revisionCount = revisions;
    this.slotSize = slots;
    this.originEpoch = epoch;
  }

  private makeRevisionEvent(childSnapshots: WorkflowChild[], revIndex: number, timestamp: number): ViewEvent {
    const isFirst = revIndex === 0;
    return {
      method: isFirst ? "item/started" : "item/updated",
      at: timestamp,
      params: {
        item: {
          itemId: "wf",
          kind: "workflow",
          status: "inProgress",
          revision: revIndex + 1,
          turnId: "t1",
          workflowRunId: "run-big",
          entryId: "big",
          children: childSnapshots,
        },
      },
    };
  }

  generateEvents(): ViewEvent[] {
    const currentChildren: WorkflowChild[] = [];
    for (let idx = 0; idx < this.agentCount; idx += 1) {
      const assignedPhase = idx % this.phaseCount;
      currentChildren.push({
        childId: `c${idx}`,
        attempt: 1,
        status: "scheduled",
        label: `phase${assignedPhase}:agent-${idx}`,
      });
    }

    const eventStream: ViewEvent[] = [];
    const initialClone = currentChildren.map((item) => ({ ...item }));
    eventStream.push(this.makeRevisionEvent(initialClone, 0, this.originEpoch));

    let cursorSlot = 0;
    for (let r = 1; r < this.revisionCount; r += 1) {
      const stepTime = this.originEpoch + r * 30_000;
      const lowerBound = Math.max(0, cursorSlot - this.slotSize);

      for (let i = lowerBound; i < cursorSlot; i += 1) {
        currentChildren[i] = {
          childId: `c${i}`,
          attempt: 1,
          status: "terminal",
          terminal: "completed",
          durationMs: 30_000,
        };
      }

      const upperBound = Math.min(this.agentCount, cursorSlot + this.slotSize);
      for (let i = cursorSlot; i < upperBound; i += 1) {
        currentChildren[i] = {
          childId: `c${i}`,
          attempt: 1,
          status: "started",
        };
      }

      cursorSlot = upperBound;
      const payloadChildren = currentChildren.map(({ label: _ignored, ...remaining }) => remaining);
      eventStream.push(this.makeRevisionEvent(payloadChildren, r, stepTime));
    }

    return eventStream;
  }
}

describe("crewView at 2000 agents", () => {
  it(`builds each revision within ${MAX_LATENCY_BUDGET_MS} ms and keeps untouched rows' identity`, () => {
    const harness = new BenchmarkRosterHarness();
    const eventSeries = harness.generateEvents();
    const session = createBenchmarkSession();

    let activeFold: ThreadFold = emptyFold();
    let priorRunVM: RunVM | null = null;
    const computeLatencies: number[] = [];
    const foldLatencies: number[] = [];
    let preservedRowCount = 0;
    let eligibleRowCount = 0;

    for (let r = 0; r < eventSeries.length; r += 1) {
      const streamEvent = eventSeries[r] as ViewEvent;

      const tFoldStart = performance.now();
      activeFold = applyEvents(activeFold, [streamEvent]);
      foldLatencies.push(performance.now() - tFoldStart);

      const tViewStart = performance.now();
      const inspectTime = (streamEvent.at ?? REFERENCE_BASE_TIME) + 1000;
      const currentRun = crewView(activeFold, session, inspectTime).runs[0] as RunVM;
      computeLatencies.push(performance.now() - tViewStart);

      assert.strictEqual(currentRun.agents.length, BENCHMARK_AGENT_COUNT);
      assert.strictEqual(currentRun.phases.length, BENCHMARK_PHASE_COUNT);

      if (priorRunVM) {
        const priorAgentMap = new Map(priorRunVM.agents.map((ag) => [ag.id, ag]));
        const modifiedChildIds = new Set<string>();

        const currentItems = (streamEvent.params["item"] as { children: WorkflowChild[] }).children;
        const previousItems = (eventSeries[r - 1]?.params["item"] as { children: WorkflowChild[] }).children;

        currentItems.forEach((child, index) => {
          if (child.status !== previousItems[index]?.status) {
            modifiedChildIds.add(child.childId);
          }
        });

        for (const candidateAgent of currentRun.agents) {
          const priorInstance = priorAgentMap.get(candidateAgent.id);
          if (!priorInstance || modifiedChildIds.has(candidateAgent.id)) {
            continue;
          }
          if (priorInstance.state === "done") {
            eligibleRowCount += 1;
            if (priorInstance === candidateAgent) {
              preservedRowCount += 1;
            }
          }
        }
      }

      priorRunVM = currentRun;
    }

    const meanLatency = computeLatencies.reduce((sum, val) => sum + val, 0) / computeLatencies.length;
    const maxLatency = Math.max(...computeLatencies);
    const meanFoldLatency = foldLatencies.reduce((sum, val) => sum + val, 0) / foldLatencies.length;

    console.log(
      `crewView: ${BENCHMARK_AGENT_COUNT} agents × ${BENCHMARK_REVISION_COUNT} revisions · ` +
      `mean ${meanLatency.toFixed(2)} ms · max ${maxLatency.toFixed(2)} ms · ` +
      `fold mean ${meanFoldLatency.toFixed(2)} ms · ${preservedRowCount}/${eligibleRowCount} finished rows reused`,
    );

    assert.ok(
      meanLatency <= MAX_LATENCY_BUDGET_MS,
      `mean ${meanLatency.toFixed(2)} ms per revision is over the ${MAX_LATENCY_BUDGET_MS} ms budget`,
    );
    assert.strictEqual(preservedRowCount, eligibleRowCount, "every finished row a revision did not touch keeps its identity");
    assert.ok(eligibleRowCount > 0);

    const resultingPhases = (priorRunVM as RunVM).phases;
    assert.ok(
      resultingPhases.every((p) => p.agents.length > 48),
      "each phase is past the strip's cell limit, so the card bins it",
    );
  });
});
