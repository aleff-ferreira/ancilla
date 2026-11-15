import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addEcho, applyEvent, applyEvents, buildTurns, emptyFold, foldFromLoad, gateFor, updateEcho, uuidTime } from "../src/model/fold.js";
import type { TranscriptLoad, ViewEvent } from "../src/types.js";
import { historyEvents, liveEvents } from "./fixtures/probe.js";

function foldSequence(events: ViewEvent[]) {
  return applyEvents(emptyFold(), events);
}

function makePartialLoad(
  events: ViewEvent[],
  activeTurnId: string | null = "active",
): TranscriptLoad {
  return {
    session: null,
    events,
    readOnlyReason: null,
    truncated: false,
    readOnly: false,
    historyUnavailable: true,
    viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
    pending: { approvals: [], userInputs: [] },
    msp: {
      status: activeTurnId ? "running" : "idle",
      activeTurnId,
      modelId: "model",
      approvalMode: "onRequest",
      workspaceRoot: "/w",
      turnCount: 2,
    },
  };
}

describe("fold: non-authoritative transcript reconciliation", () => {
  it("preserves live terminal outcomes and cumulative totals while backfilling an unseen usage call", () => {
    const liveRunEvents: ViewEvent[] = [
      { method: "turn/completed", params: { turnId: "old", terminal: "completed", durationMs: 500 }, at: 500 },
      { method: "turn/started", params: { turnId: "active" }, at: 600 },
      {
        method: "session/tokenUsage",
        params: {
          viewCursor: "usage-new",
          turnId: "active",
          cumulative: { promptTokens: 200, outputTokens: 20, totalTokens: 220 },
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      },
    ];
    const initialFold = foldSequence(liveRunEvents);

    const historyPayload: ViewEvent[] = [
      {
        method: "turn/completed",
        params: { turnId: "old", terminal: "failed", reason: "incomplete", error: { kind: "incomplete", message: "old projection", retryable: false } },
      },
      {
        method: "session/tokenUsage",
        params: {
          viewCursor: "usage-old",
          turnId: "old",
          cumulative: { promptTokens: 100, outputTokens: 10, totalTokens: 110 },
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      },
      { method: "session/closed", params: {} },
    ];
    const loadedTranscript = makePartialLoad(historyPayload);
    const reconciledFold = foldFromLoad(loadedTranscript, initialFold);

    assert.deepStrictEqual(reconciledFold.turns.old, initialFold.turns.old);
    assert.strictEqual(reconciledFold.activeTurnId, "active");
    assert.deepStrictEqual(reconciledFold.meta.tokenTotals, initialFold.meta.tokenTotals);

    const sortedCalls = Object.keys(reconciledFold.meta.calls).sort();
    assert.deepStrictEqual(sortedCalls, ["active:200:20:220::100", "old:100:10:110::100"]);

    const reReconciled = foldFromLoad(loadedTranscript, reconciledFold);
    assert.deepStrictEqual(reReconciled.meta.calls, reconciledFold.meta.calls, "repeated reads do not count usage twice");
    assert.deepStrictEqual(Object.keys(initialFold.meta.calls), ["active:200:20:220::100"], "the live fold stays immutable");

    const subsequentUsageEvent: ViewEvent = {
      method: "session/tokenUsage",
      params: { viewCursor: "usage-later", cumulative: { promptTokens: 300, outputTokens: 30, totalTokens: 330 } },
    };
    const advancedFold = foldFromLoad(makePartialLoad([subsequentUsageEvent]), reconciledFold);
    assert.strictEqual(advancedFold.meta.tokenTotals?.totalTokens, 330);
  });

  it("rejects a partial terminal for the running session but recovers a genuinely ended active turn", () => {
    const baseFold = addEcho(
      foldSequence([{ method: "turn/started", params: { turnId: "active" }, at: 10 }]),
      { localId: "echo", text: "Work", turnId: "active", disposition: "started", createdAt: 9 },
    );

    const prematureFail: ViewEvent = {
      method: "turn/completed",
      params: { turnId: "active", terminal: "failed", error: { kind: "incomplete", message: "partial", retryable: false } },
    };
    const runningFold = foldFromLoad(makePartialLoad([prematureFail]), baseFold);
    assert.strictEqual(runningFold.turns.active?.terminal, undefined);
    assert.strictEqual(runningFold.echoes.length, 1);

    const completionEvent: ViewEvent = {
      method: "turn/completed",
      params: { turnId: "active", terminal: "completed" },
      at: 30,
    };
    const settledFold = foldFromLoad(makePartialLoad([completionEvent], null), runningFold);
    assert.strictEqual(settledFold.activeTurnId, null);
    assert.strictEqual(settledFold.turns.active?.terminal, "completed");
    assert.strictEqual(settledFold.turns.active?.startedAt, 10);
    assert.strictEqual(settledFold.echoes.length, 0);
  });

  it("lets a saved finished item replace an open one, and never reopens a finished one", () => {
    const makeWfEvent = (revision: number, status: string): ViewEvent => ({
      method: "item/updated",
      params: { item: { itemId: "wf", kind: "workflow", turnId: "active", revision, status, children: [] } },
    });

    const activeWorkflowFold = foldSequence([1, 2, 3, 4].map((rev) => makeWfEvent(rev, "inProgress")));
    const reconciledCompleted = foldFromLoad(makePartialLoad([makeWfEvent(2, "completed")]), activeWorkflowFold);
    assert.strictEqual(reconciledCompleted.items.wf?.status, "completed");

    const finishedWorkflowFold = foldSequence([makeWfEvent(1, "inProgress"), makeWfEvent(2, "completed")]);
    const attemptReopenFold = foldFromLoad(makePartialLoad([makeWfEvent(5, "inProgress")]), finishedWorkflowFold);
    assert.strictEqual(attemptReopenFold.items.wf?.status, "completed");
  });

  it("places backfilled items where the page has them, not after everything on screen", () => {
    const makeCompletedItem = (itemId: string, turnId: string, kind = "toolCall", text?: string): ViewEvent => ({
      method: "item/completed",
      params: { item: { itemId, kind, turnId, text, revision: 1, status: "completed" } },
    });

    const currentScreenFold = foldSequence([
      { method: "turn/started", params: { turnId: "A" } },
      makeCompletedItem("uA", "A", "userMessage", "do it"),
      makeCompletedItem("t1", "A"),
      makeCompletedItem("final", "A", "agentMessage", "All done."),
      { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
      { method: "turn/started", params: { turnId: "active" } },
      makeCompletedItem("uB", "active", "userMessage", "next"),
      makeCompletedItem("live", "active"),
    ]);

    const pageWithMissingItem = [
      makeCompletedItem("uA", "A", "userMessage", "do it"),
      makeCompletedItem("t1", "A"),
      makeCompletedItem("t2", "A"),
      makeCompletedItem("final", "A", "agentMessage", "All done."),
      makeCompletedItem("uB", "active", "userMessage", "next"),
    ];
    const mergedFold = foldFromLoad(makePartialLoad(pageWithMissingItem), currentScreenFold);
    assert.deepStrictEqual(mergedFold.order, ["uA", "t1", "t2", "final", "uB", "live"]);
    assert.strictEqual(buildTurns(mergedFold)[0]?.final?.text, "All done.", "the reply stays the reply");

    const turnActiveOnly = foldSequence([
      { method: "turn/started", params: { turnId: "active" } },
      makeCompletedItem("uB", "active", "userMessage", "newest"),
    ]);
    const olderTurnLoad = makePartialLoad([
      makeCompletedItem("uA", "A", "userMessage", "older"),
      { method: "turn/completed", params: { turnId: "A", terminal: "failed", error: { kind: "x", message: "boom", retryable: true } } },
      makeCompletedItem("uB", "active", "userMessage", "newest"),
    ]);
    const olderMerged = foldFromLoad(olderTurnLoad, turnActiveOnly);
    assert.deepStrictEqual(buildTurns(olderMerged).map((t) => t.turnId), ["A", "active"]);

    const screenEdges = foldSequence([makeCompletedItem("t0", "A"), makeCompletedItem("t1", "A"), makeCompletedItem("t3", "A")]);
    const pageSlice = makePartialLoad([makeCompletedItem("t1", "A"), makeCompletedItem("t2", "A")]);
    const mergedEdges = foldFromLoad(pageSlice, screenEdges);
    assert.deepStrictEqual(mergedEdges.order, ["t0", "t1", "t2", "t3"]);
  });

  it("merges approvals and questions with the history when the host's pending list is incomplete", () => {
    const makeReq = (approvalId: string, turnId: string): ViewEvent => ({
      method: "approval/requested",
      params: { approvalId, itemId: `tool-${approvalId}`, turnId },
    });

    const activePendingFold = foldSequence([
      { method: "turn/started", params: { turnId: "active" } },
      makeReq("X", "active"),
      makeReq("K", "active"),
    ]);

    const historicalStream: ViewEvent[] = [
      makeReq("X", "active"),
      { method: "approval/resolved", params: { approvalId: "X", decision: "approved", resolvedBy: "user" } },
      { method: "userInput/requested", params: { userInputId: "Q", itemId: "ask", turnId: "active", questions: [] } },
      makeReq("OLD", "earlier"),
    ];

    for (const isAuthoritative of [false, true]) {
      const loadConfig = {
        ...makePartialLoad(historicalStream),
        pendingComplete: false,
        ...(isAuthoritative ? { historyUnavailable: false, viewHealth: null } : {}),
      };
      const resultFold = foldFromLoad(loadConfig, activePendingFold);
      assert.deepStrictEqual(Object.keys(resultFold.approvals).sort(), ["K"]);
      assert.deepStrictEqual(Object.keys(resultFold.userInputs), ["Q"]);
    }
  });

  it("promotes a queued prompt once the session reports its turn running, even if the page stops short of it", () => {
    const initialTurnA = addEcho(
      foldSequence([{ method: "turn/started", params: { turnId: "A" } }]),
      { localId: "q", text: "then run tests", turnId: "B", disposition: "queued", createdAt: 2 },
    );
    const promotedFold = foldFromLoad(makePartialLoad([], "B"), initialTurnA);
    assert.strictEqual(promotedFold.activeTurnId, "B");
    assert.deepStrictEqual(promotedFold.echoes.map((e) => e.disposition), ["started"]);

    const unassignedQueue = addEcho(
      foldSequence([{ method: "turn/started", params: { turnId: "B" } }]),
      { localId: "q", text: "then run tests", turnId: null, disposition: "queued", createdAt: 2 },
    );
    const assignedQueue = updateEcho(unassignedQueue, "q", { turnId: "B", disposition: "queued" });
    assert.strictEqual(assignedQueue.echoes[0]?.disposition, "started");
  });

  it("keeps the agent labels a partial page holds in an older revision", () => {
    const makeWfWithChildren = (revision: number, children: unknown[]): ViewEvent => ({
      method: "item/updated",
      params: { item: { itemId: "wf", kind: "workflow", turnId: "active", revision, status: "inProgress", children } },
    });

    const liveHigherRevision = foldSequence([
      makeWfWithChildren(11, [
        { childId: "a", attempt: 1, status: "started" },
        { childId: "b", attempt: 1, status: "scheduled" },
      ]),
    ]);

    const olderHistoryRevision = makePartialLoad([
      makeWfWithChildren(2, [
        { childId: "a", attempt: 1, status: "scheduled", label: "Read alpha" },
        { childId: "b", attempt: 1, status: "scheduled", label: "Verify beta" },
      ]),
    ]);

    const reconciledLabels = foldFromLoad(olderHistoryRevision, liveHigherRevision);
    assert.strictEqual(reconciledLabels.items.wf?.revision, 11);
    assert.deepStrictEqual(
      reconciledLabels.items.wf?.children?.map((c) => [c.label, c.status]),
      [["Read alpha", "started"], ["Verify beta", "scheduled"]],
    );
    assert.deepStrictEqual(
      reconciledLabels.agentItems?.wf?.children?.map((c) => c.label),
      ["Read alpha", "Verify beta"],
    );
  });

  it("neither duplicates nor drops an item across partial pages that overlap the screen differently", () => {
    const makeMsg = (itemId: string, turnId: string, kind = "toolCall", text?: string): ViewEvent => ({
      method: "item/completed",
      params: { item: { itemId, kind, turnId, text, revision: 1, status: "completed" } },
    });

    let currentFold = foldSequence([
      { method: "turn/started", params: { turnId: "A" } },
      makeMsg("uA", "A", "userMessage", "a"),
      makeMsg("t1", "A"),
      makeMsg("final", "A", "agentMessage", "All done."),
      { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
      { method: "turn/started", params: { turnId: "active" } },
      makeMsg("uB", "active", "userMessage", "b"),
      makeMsg("l1", "active"),
      makeMsg("l2", "active"),
    ]);

    const pageSlices = [
      [makeMsg("uA", "A", "userMessage", "a"), makeMsg("t1", "A"), makeMsg("t2", "A")],
      [makeMsg("t2", "A"), makeMsg("t3", "A"), makeMsg("final", "A", "agentMessage", "All done.")],
      [
        makeMsg("uA", "A", "userMessage", "a"),
        makeMsg("t1", "A"),
        makeMsg("t2", "A"),
        makeMsg("t3", "A"),
        makeMsg("final", "A", "agentMessage", "All done."),
        makeMsg("uB", "active", "userMessage", "b"),
        makeMsg("l1", "active"),
      ],
    ];

    for (const slice of pageSlices) {
      currentFold = foldFromLoad(makePartialLoad(slice), currentFold);
      assert.strictEqual(new Set(currentFold.order).size, currentFold.order.length, "no item is shown twice");
      assert.deepStrictEqual([...currentFold.order].sort(), Object.keys(currentFold.items).sort(), "no item is dropped");
    }

    assert.deepStrictEqual(currentFold.order, ["uA", "t1", "t2", "t3", "final", "uB", "l1", "l2"]);
    assert.strictEqual(buildTurns(currentFold)[0]?.final?.text, "All done.");
  });

  it("shows the running turn's open requests from the page when a thread first opens with an incomplete pending list", () => {
    const startEvent = (turnId: string): ViewEvent => ({ method: "turn/started", params: { turnId } });
    const completeEvent = (turnId: string): ViewEvent => ({ method: "turn/completed", params: { turnId, terminal: "completed" } });
    const reqApproval = (approvalId: string, itemId: string, turnId: string): ViewEvent => ({
      method: "approval/requested",
      params: { approvalId, itemId, turnId },
    });
    const resApproval = (approvalId: string): ViewEvent => ({
      method: "approval/resolved",
      params: { approvalId, decision: "approved", resolvedBy: "user" },
    });
    const reqInput = (userInputId: string, itemId: string, turnId: string): ViewEvent => ({
      method: "userInput/requested",
      params: { userInputId, itemId, turnId, questions: [] },
    });

    const initialPage: ViewEvent[] = [
      startEvent("old"),
      reqApproval("Y", "tool-Y", "old"),
      resApproval("Y"),
      completeEvent("old"),
      startEvent("active"),
      reqApproval("X", "tool-X", "active"),
      reqInput("Q", "ask", "active"),
    ];
    for (const priorState of [null, emptyFold()]) {
      const resultFold = foldFromLoad({ ...makePartialLoad(initialPage), pendingComplete: false }, priorState);
      assert.deepStrictEqual(Object.keys(resultFold.approvals), ["X"]);
      assert.deepStrictEqual(Object.keys(resultFold.userInputs), ["Q"]);
    }
  });

  it("merges a long thread's partial page in a fraction of a second", () => {
    const makeBatchItem = (idx: number): ViewEvent => ({
      method: "item/completed",
      params: {
        item: {
          itemId: `i${idx}`,
          kind: idx % 7 === 0 ? "userMessage" : "toolCall",
          turnId: `T${Math.floor(idx / 50)}`,
          text: `step ${idx}`,
          revision: 1,
          status: "completed",
        },
      },
    });

    const TOTAL_STEPS = 20_000;
    const initialEvents: ViewEvent[] = [
      { method: "turn/started", params: { turnId: "active" } },
      ...Array.from({ length: TOTAL_STEPS }, (_, i) => makeBatchItem(i)),
    ];
    let largeFold = foldSequence(initialEvents);
    largeFold = addEcho(largeFold, { localId: "e", text: "step 7", turnId: null, disposition: "sending", createdAt: 1 });
    largeFold = addEcho(largeFold, { localId: "s", text: "steer", turnId: "active", disposition: "steered", createdAt: 2 });

    const incomingOverlappingPage = Array.from({ length: TOTAL_STEPS }, (_, i) => makeBatchItem(10_000 + i));
    const startMs = performance.now();
    const mergedFold = foldFromLoad(makePartialLoad(incomingOverlappingPage), largeFold);
    const durationMs = performance.now() - startMs;

    assert.strictEqual(mergedFold.order.length, 30_000);
    assert.strictEqual(new Set(mergedFold.order).size, 30_000);
    assert.strictEqual(mergedFold.echoes.length, 2);
    assert.ok(durationMs < 2_000, `a 20k-item page onto 20k shown items took ${durationMs}ms`);
  });

  it("keeps newer plan metadata and explicit clears, then accepts later saved plan changes", () => {
    const metaFold = foldSequence([
      { method: "session/goalChanged", params: { viewCursor: "v:s:21", goal: null }, at: 21 },
      { method: "session/todoListChanged", params: { viewCursor: "v:s:20", items: [{ content: "Verify", status: "inProgress" }] }, at: 20 },
      { method: "session/modelChanged", params: { viewCursor: "v:s:23", modelId: "current-model" }, at: 23 },
      { method: "session/branchChanged", params: { viewCursor: "v:s:22", branch: null }, at: 22 },
    ]);

    const staleHistoryLoad = makePartialLoad([
      { method: "session/branchChanged", params: { branch: "old-branch" } },
      { method: "session/todoListChanged", params: { viewCursor: "v:s:10", items: [{ content: "Old", status: "pending" }] }, at: 100 },
      { method: "session/started", params: { session: { modelId: "old-model", approvalMode: { mode: "allowAll" } } } },
      { method: "session/goalChanged", params: { viewCursor: "v:s:11", goal: { objective: "Old goal", status: "active" } }, at: 100 },
    ]);
    const reconciledStale = foldFromLoad(staleHistoryLoad, metaFold);

    assert.deepStrictEqual(reconciledStale.meta.todoList, metaFold.meta.todoList, "cursor order wins over a later read timestamp");
    assert.strictEqual(reconciledStale.meta.goal, null, "a cleared goal is known metadata");
    assert.strictEqual(reconciledStale.meta.branch, null, "unordered history cannot undo an explicit branch clear");
    assert.strictEqual(reconciledStale.meta.modelId, "current-model");

    const newerHistoryLoad = makePartialLoad([
      { method: "session/todoListChanged", params: { viewCursor: "v:s:30", items: [{ content: "Verify", status: "completed" }] } },
      { method: "session/goalChanged", params: { viewCursor: "v:s:31", goal: { objective: "Next goal", status: "active" } } },
      { method: "session/branchChanged", params: { viewCursor: "v:s:32", branch: "next-branch" } },
    ]);
    const reconciledNewer = foldFromLoad(newerHistoryLoad, reconciledStale);

    assert.deepStrictEqual(reconciledNewer.meta.todoList, [{ content: "Verify", status: "completed" }]);
    assert.strictEqual(reconciledNewer.meta.goal?.objective, "Next goal");
    assert.strictEqual(reconciledNewer.meta.branch, "next-branch");
    assert.strictEqual(metaFold.meta.goal, null);
  });

  it("uses known event times when cursors are absent and preserves current metadata when order is unknown", () => {
    const priorFold = foldSequence([
      { method: "session/goalChanged", params: { goal: { objective: "Current", status: "active" } }, at: 20 },
    ]);

    const olderFold = foldFromLoad(
      makePartialLoad([{ method: "session/goalChanged", params: { goal: { objective: "Old", status: "active" } }, at: 10 }]),
      priorFold,
    );
    assert.strictEqual(olderFold.meta.goal?.objective, "Current");

    const unknownFold = foldFromLoad(makePartialLoad([{ method: "session/goalChanged", params: { goal: null } }]), olderFold);
    assert.strictEqual(unknownFold.meta.goal?.objective, "Current");

    const advancedGoal = foldFromLoad(
      makePartialLoad([{ method: "session/goalChanged", params: { goal: null }, at: 30 }]),
      unknownFold,
    );
    assert.strictEqual(advancedGoal.meta.goal, null);
    assert.strictEqual(advancedGoal.meta.goalSeen, true);

    const initialGoal = foldFromLoad(
      makePartialLoad([{ method: "session/goalChanged", params: { goal: { objective: "Saved goal", status: "active" } } }]),
      emptyFold(),
    );
    assert.strictEqual(initialGoal.meta.goal?.objective, "Saved goal", "unknown metadata can still be backfilled");
  });
});

describe("fold: turn lifecycle and terminal status resolution", () => {
  const makeMsgEvent = (itemId: string, turnId: string, text: string, kind = "userMessage"): ViewEvent => ({
    method: "item/completed",
    params: { item: { itemId, kind, turnId, text, revision: 1, status: "completed" } },
  });
  const makeIncompleteTurnEvent = (turnId: string): ViewEvent => ({
    method: "turn/completed",
    params: { turnId, terminal: "failed", reason: "incomplete" },
  });

  const activeRunningFold = foldSequence([
    { method: "turn/started", params: { turnId: "A" }, at: 1 },
    makeMsgEvent("uA", "A", "refactor"),
  ]);

  it("is not taken as a failure of a turn the session no longer runs, and the real outcome replaces it later", () => {
    const loadSnapshot = makePartialLoad([makeMsgEvent("uA", "A", "refactor"), makeIncompleteTurnEvent("A")], null);
    const resolvedFold = foldFromLoad(loadSnapshot, activeRunningFold);

    assert.strictEqual(resolvedFold.turns.A?.terminal, "unknown");
    assert.strictEqual(resolvedFold.turns.A?.error, undefined);
    assert.strictEqual(resolvedFold.activeTurnId, null);
    assert.notStrictEqual(buildTurns(resolvedFold).at(-1)?.info?.terminal, "failed");

    const repeatedRead = foldFromLoad(loadSnapshot, resolvedFold);
    assert.strictEqual(repeatedRead.turns.A?.terminal, "unknown", "a repeated placeholder changes nothing");

    const realOutcomeEvents: ViewEvent[] = [
      makeMsgEvent("uA", "A", "refactor"),
      makeMsgEvent("fin", "A", "Done.", "agentMessage"),
      { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
    ];
    const savedOutcomeFold = foldFromLoad(makePartialLoad(realOutcomeEvents, null), repeatedRead);
    assert.strictEqual(savedOutcomeFold.turns.A?.terminal, "completed", "a later partial read with the real outcome replaces the placeholder");
    assert.strictEqual(buildTurns(savedOutcomeFold).at(-1)?.final?.text, "Done.");

    const staleReplay = foldFromLoad(loadSnapshot, savedOutcomeFold);
    assert.strictEqual(staleReplay.turns.A?.terminal, "completed", "an older placeholder never replaces a real outcome");

    const liveOutcomeFold = applyEvent(resolvedFold, { method: "turn/completed", params: { turnId: "A", terminal: "completed" } });
    assert.strictEqual(liveOutcomeFold.turns.A?.terminal, "completed");
    assert.strictEqual(liveOutcomeFold.turns.A?.provisional, undefined, "a live outcome is final");
  });

  it("is not taken as a failure of a finished turn while the session runs the next one", () => {
    const subsequentTurnFold = foldFromLoad(
      makePartialLoad([makeMsgEvent("uA", "A", "refactor"), makeIncompleteTurnEvent("A")], "B"),
      activeRunningFold,
    );
    assert.strictEqual(subsequentTurnFold.turns.A?.terminal, "unknown");
    assert.strictEqual(subsequentTurnFold.activeTurnId, "B");
  });

  it("leaves the turn running when the session's own state is unknown", () => {
    const unstatedSession = { ...makePartialLoad([makeIncompleteTurnEvent("A")]), msp: null };
    const preservedState = foldFromLoad(unstatedSession, activeRunningFold);
    assert.strictEqual(preservedState.turns.A?.terminal, undefined);
    assert.strictEqual(preservedState.activeTurnId, "A");
  });

  it("keeps a real saved failure visible", () => {
    const providerFailure: ViewEvent = {
      method: "turn/completed",
      params: { turnId: "A", terminal: "failed", error: { kind: "provider", message: "Provider down", retryable: true } },
    };
    const failureFold = foldFromLoad(makePartialLoad([providerFailure], null), activeRunningFold);
    assert.strictEqual(failureFold.turns.A?.terminal, "failed");
    assert.strictEqual(failureFold.turns.A?.error?.message, "Provider down");

    const laterContradiction = foldFromLoad(
      makePartialLoad([{ method: "turn/completed", params: { turnId: "A", terminal: "completed" } }], null),
      failureFold,
    );
    assert.strictEqual(laterContradiction.turns.A?.terminal, "failed", "only a placeholder gives way to a later read");
  });

  it("gives way to a real outcome read or streamed later, and never softens one already shown", () => {
    const placeholderFold = foldFromLoad(
      makePartialLoad([makeMsgEvent("uA", "A", "refactor"), makeIncompleteTurnEvent("A")], null),
      activeRunningFold,
    );
    assert.strictEqual(placeholderFold.turns.A?.terminal, "unknown");

    const providerFailure: ViewEvent = {
      method: "turn/completed",
      params: { turnId: "A", terminal: "failed", error: { kind: "provider", message: "Provider down", retryable: true } },
    };
    const realFailureFold = foldFromLoad(makePartialLoad([providerFailure], null), placeholderFold);
    assert.strictEqual(realFailureFold.turns.A?.terminal, "failed", "a real failure read later replaces the placeholder");
    assert.strictEqual(realFailureFold.turns.A?.error?.message, "Provider down");

    const softenedAttempt = foldFromLoad(makePartialLoad([makeIncompleteTurnEvent("A")], null), realFailureFold);
    assert.strictEqual(softenedAttempt.turns.A?.terminal, "failed", "a later placeholder does not soften it");

    const streamedCompletion = applyEvent(placeholderFold, {
      method: "turn/completed",
      params: { turnId: "A", terminal: "completed" },
      at: 5,
    });
    assert.strictEqual(streamedCompletion.turns.A?.terminal, "completed", "a live outcome that arrived during the read replaces the placeholder");

    const pageAfterStream = foldFromLoad(
      makePartialLoad([makeMsgEvent("uA", "A", "refactor"), makeIncompleteTurnEvent("A")], null),
      streamedCompletion,
    );
    assert.strictEqual(pageAfterStream.turns.A?.terminal, "completed");

    const liveShown = applyEvent(activeRunningFold, providerFailure);
    const contradictedPage = foldFromLoad(
      makePartialLoad([{ method: "turn/completed", params: { turnId: "A", terminal: "completed" } }], null),
      liveShown,
    );
    assert.strictEqual(contradictedPage.turns.A?.error?.message, "Provider down", "a failure the live feed showed is never replaced by a page");
  });
});

describe("fold: live transcript playback against probe fixtures", () => {
  it("retains each workflow assignment through status-only revisions without retaining an old phase", () => {
    const makeWfUpdate = (revision: number, children: unknown[]): ViewEvent => ({
      method: "item/updated",
      params: { item: { itemId: "workflow-1", kind: "workflow", status: "inProgress", revision, children } },
    });

    let currentFold = foldSequence([
      makeWfUpdate(1, [
        { childId: "a", attempt: 1, label: "Audit navigation", phase: "Inspecting", status: "scheduled" },
        { childId: "b", attempt: 1, label: "Check tests", status: "scheduled" },
      ]),
    ]);

    currentFold = applyEvent(
      currentFold,
      makeWfUpdate(2, [
        { childId: "a", attempt: 1, status: "started" },
        { childId: "b", attempt: 1, status: "terminal", terminal: "completed" },
      ]),
    );
    assert.deepStrictEqual(currentFold.items["workflow-1"]?.children?.map((c) => c.label), ["Audit navigation", "Check tests"]);
    assert.strictEqual(currentFold.items["workflow-1"]?.children?.[0]?.phase, undefined);

    currentFold = applyEvent(currentFold, makeWfUpdate(3, [{ childId: "a", attempt: 2, label: "Verify navigation fix", status: "scheduled" }]));
    assert.strictEqual(currentFold.items["workflow-1"]?.children?.[0]?.label, "Verify navigation fix");
    assert.strictEqual(currentFold.items["workflow-1"]?.children?.[0]?.terminal, undefined);
    assert.strictEqual(currentFold.items["workflow-1"]?.children?.length, 1, "removed children are not resurrected");

    currentFold = applyEvent(currentFold, makeWfUpdate(4, [{ childId: "a", attempt: 3, status: "scheduled" }]));
    assert.strictEqual(currentFold.items["workflow-1"]?.children?.[0]?.label, undefined, "another attempt does not inherit obsolete metadata");
  });

  it("keeps the small agent index stable while the parent streams ordinary text", () => {
    let activeFold = foldSequence([
      { method: "item/started", params: { item: { itemId: "w", kind: "workflow", status: "inProgress", revision: 1 } } },
    ]);
    const cachedAgentIndex = activeFold.agentItems;

    activeFold = applyEvent(activeFold, {
      method: "item/started",
      params: { item: { itemId: "reply", kind: "agentMessage", status: "inProgress", revision: 1 } },
    });
    activeFold = applyEvent(activeFold, {
      method: "item/delta",
      params: { itemId: "reply", delta: "Working", field: "text" },
    });

    assert.strictEqual(activeFold.agentItems, cachedAgentIndex);
    assert.strictEqual(activeFold.agentItems?.w, activeFold.items.w);

    activeFold = applyEvent(activeFold, {
      method: "item/updated",
      params: { item: { itemId: "w", kind: "workflow", status: "completed", revision: 2 } },
    });
    assert.notStrictEqual(activeFold.agentItems, cachedAgentIndex);
    assert.strictEqual(activeFold.agentItems?.w?.status, "completed");
    assert.strictEqual(cachedAgentIndex?.w?.status, "inProgress", "the previous snapshot stays immutable");
  });

  it("preserves the visible transcript when the projection cannot supply history", () => {
    const historicalFold = foldSequence(historyEvents);
    const recoveredFold = foldFromLoad(
      {
        events: [],
        session: null,
        msp: null,
        readOnlyReason: null,
        pending: { approvals: [], userInputs: [] },
        truncated: false,
        pendingComplete: false,
        historyUnavailable: true,
        readOnly: false,
      },
      historicalFold,
    );

    assert.ok(historicalFold.order.length > 0);
    assert.deepStrictEqual(recoveredFold.order, historicalFold.order);
    assert.deepStrictEqual(recoveredFold.items, historicalFold.items);
    assert.deepStrictEqual(recoveredFold.turns, historicalFold.turns);
  });

  it("merges nonempty unavailable history without dropping newer displayed items or revisions", () => {
    const makeAgentItemEvent = (itemId: string, revision: number, text: string): ViewEvent => ({
      method: "item/updated",
      params: { item: { itemId, revision, text, kind: "agentMessage", status: "inProgress", turnId: "active" } },
    });

    const activeDisplay = foldSequence([
      makeAgentItemEvent("reply", 5, "Newer visible answer"),
      makeAgentItemEvent("recent", 1, "Keep this too"),
    ]);

    const historicalLoad = foldFromLoad(
      {
        events: [makeAgentItemEvent("reply", 2, "Old answer"), makeAgentItemEvent("new", 1, "Fresh work")],
        viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
        readOnlyReason: null,
        session: null,
        msp: null,
        readOnly: false,
        truncated: false,
        pending: { approvals: [], userInputs: [] },
      },
      activeDisplay,
    );

    assert.strictEqual(historicalLoad.items.reply.revision, 5);
    assert.strictEqual(historicalLoad.items.reply.text, "Newer visible answer");
    assert.strictEqual(historicalLoad.items.recent.text, "Keep this too");
    assert.strictEqual(historicalLoad.items.new.text, "Fresh work");
  });

  it("merges a partial stream snapshot once without replaying old deltas or shortening its text", () => {
    const initialStartEvent: ViewEvent = {
      method: "item/started",
      params: { item: { itemId: "reply", revision: 1, kind: "agentMessage", status: "inProgress", turnId: "active", text: "" } },
    };
    const makeDeltaEvent = (deltaText: string): ViewEvent => ({
      method: "item/delta",
      params: { itemId: "reply", field: "text", delta: deltaText },
    });

    const reloadFromSnapshot = (events: ViewEvent[], priorFold: ReturnType<typeof emptyFold>) =>
      foldFromLoad(
        {
          events,
          historyUnavailable: true,
          readOnlyReason: null,
          session: null,
          msp: null,
          readOnly: false,
          truncated: false,
          pending: { approvals: [], userInputs: [] },
        },
        priorFold,
      );

    const baseFold = foldSequence([initialStartEvent, makeDeltaEvent("Hello")]);
    const expandedFold = reloadFromSnapshot([initialStartEvent, makeDeltaEvent("Hello"), makeDeltaEvent(" world")], baseFold);
    assert.strictEqual(expandedFold.items.reply.text, "Hello world");

    const duplicateReload = reloadFromSnapshot([initialStartEvent, makeDeltaEvent("Hello"), makeDeltaEvent(" world")], expandedFold);
    assert.strictEqual(duplicateReload.items.reply.text, "Hello world");

    const partialReload = reloadFromSnapshot([initialStartEvent, makeDeltaEvent("Hello")], expandedFold);
    assert.strictEqual(partialReload.items.reply.text, "Hello world");
    assert.strictEqual(baseFold.items.reply.text, "Hello");
  });

  it("drops a prompt's local copy once its turn ends, landed or not", () => {
    const unacknowledgedSend = addEcho(
      emptyFold(),
      { localId: "e1", text: "hello", turnId: null, disposition: "sending", createdAt: 1 },
    );
    const startedSend = updateEcho(unacknowledgedSend, "e1", { turnId: "t1", disposition: "started" });
    assert.strictEqual(startedSend.echoes.length, 1);

    const failedTurnFold = applyEvent(startedSend, {
      method: "turn/completed",
      params: { sessionId: "s1", turnId: "t1", terminal: "failed", error: { kind: "rateLimit", message: "quota", retryable: true } },
      at: 2,
    });
    assert.strictEqual(failedTurnFold.echoes.length, 0, "a failed turn takes its pending bubble with it");

    const quietTurnFold = applyEvent(
      updateEcho(unacknowledgedSend, "e1", { turnId: "t2", disposition: "started" }),
      {
        method: "turn/completed",
        params: { sessionId: "s1", turnId: "t2", terminal: "completed" },
        at: 3,
      },
    );
    assert.strictEqual(quietTurnFold.echoes.length, 0, "a turn that committed no prompt item leaves no ghost either");
  });

  it("folds the live stream into three finished turns", () => {
    const reducedFold = liveEvents.reduce(applyEvent, emptyFold());
    const turnSummaries = buildTurns(reducedFold);
    assert.strictEqual(turnSummaries.length, 3);
    assert.strictEqual(reducedFold.activeTurnId, null);

    const [firstTurn, secondTurn, thirdTurn] = turnSummaries;
    assert.strictEqual(firstTurn?.prompt?.text, "Reply with exactly one word: pong");
    assert.strictEqual(firstTurn?.final?.text, "pong");
    assert.strictEqual(firstTurn?.entries.length, 0, "reminder children stay hidden");
    assert.strictEqual(firstTurn?.info?.durationMs, 42316);

    assert.strictEqual(secondTurn?.entries.length, 1);
    assert.strictEqual(secondTurn?.entries[0]?.kind, "toolCall");
    assert.strictEqual(secondTurn?.entries[0]?.tool, "bash");
    assert.match(secondTurn?.entries[0]?.visibleOutput ?? "", /README\.md/);
    assert.match(secondTurn?.final?.text ?? "", /printed 4 entries/);

    assert.strictEqual(thirdTurn?.entries[0]?.tool, "request_user_input");
    assert.strictEqual(thirdTurn?.final?.text, "Blue");
    assert.deepStrictEqual(Object.keys(reducedFold.userInputs), []);

    const settledInput = Object.values(reducedFold.settled)[0];
    assert.strictEqual(settledInput?.outcome, "answered");
    assert.strictEqual(settledInput?.answers[0]?.selectedLabel, "Blue");

    assert.strictEqual(reducedFold.meta.contextUsage?.windowTokens, 1007997);
    assert.strictEqual(reducedFold.meta.tokenTotals?.totalTokens, 108605);
    assert.strictEqual(reducedFold.meta.approvalMode, "onRequest");
    assert.strictEqual(reducedFold.meta.modelId, "muse-spark-1.3-contributor");
  });

  it("shows a turn as running with its streaming reply inline", () => {
    const firstDeltaIdx = liveEvents.findIndex((ev) => ev.method === "item/delta");
    const activeStreamFold = foldSequence(liveEvents.slice(0, firstDeltaIdx + 1));
    assert.notStrictEqual(activeStreamFold.activeTurnId, null);

    const [activeTurn] = buildTurns(activeStreamFold);
    assert.strictEqual(activeTurn?.running, true);
    assert.strictEqual(activeTurn?.final, null);

    const streamingReply = activeTurn?.entries.find((e) => e.kind === "agentMessage");
    assert.strictEqual(streamingReply?.text, "pong");
    assert.strictEqual(streamingReply?.status, "inProgress");
  });

  it("parks a pending question until it settles", () => {
    const questionRequestedIdx = liveEvents.findIndex((ev) => ev.method === "userInput/requested");
    const gatedFold = foldSequence(liveEvents.slice(0, questionRequestedIdx + 1));
    const [pendingQuestion] = Object.values(gatedFold.userInputs);

    assert.strictEqual(pendingQuestion?.questions[0]?.question, "Which color do you prefer?");
    const matchingTool = Object.values(gatedFold.items).find((item) => item.tool === "request_user_input");
    assert.strictEqual(gateFor(gatedFold, matchingTool?.itemId ?? "")?.kind, "input");
  });

  it("renders paged history the same as the live stream", () => {
    const liveTurnList = buildTurns(foldSequence(liveEvents));
    const historyTurnList = buildTurns(foldSequence(historyEvents));
    assert.deepStrictEqual(
      historyTurnList.map((t) => [t.prompt?.text, t.final?.text, t.entries.map((e) => e.kind)]),
      liveTurnList.map((t) => [t.prompt?.text, t.final?.text, t.entries.map((e) => e.kind)]),
    );
  });

  it("never duplicates items when history and live events overlap", () => {
    const combinedFold = applyEvents(foldSequence(historyEvents), liveEvents);
    const combinedIds = combinedFold.order;
    assert.strictEqual(new Set(combinedIds).size, combinedIds.length);

    const standaloneLive = foldSequence(liveEvents);
    assert.strictEqual(combinedFold.order.length, standaloneLive.order.length);

    const finalAnswer = Object.values(combinedFold.items).find((i) => i.kind === "agentMessage" && i.text === "pong");
    assert.strictEqual(finalAnswer?.revision, 2, "the higher live revision wins over the paged one");
  });

  it("keeps streamed text when the final arrives empty and ignores late deltas", () => {
    let workingFold = applyEvent(emptyFold(), {
      method: "item/started",
      params: { sessionId: "s", item: { itemId: "m1", kind: "agentMessage", status: "inProgress", revision: 1, turnId: "t1" } },
    });
    workingFold = applyEvent(workingFold, { method: "item/delta", params: { sessionId: "s", itemId: "m1", delta: "Hello world" } });
    workingFold = applyEvent(workingFold, {
      method: "item/completed",
      params: { sessionId: "s", item: { itemId: "m1", kind: "agentMessage", status: "completed", revision: 2, turnId: "t1", text: "" } },
    });
    assert.strictEqual(workingFold.items["m1"]?.text, "Hello world");

    workingFold = applyEvent(workingFold, { method: "item/delta", params: { sessionId: "s", itemId: "m1", delta: " again" } });
    assert.strictEqual(workingFold.items["m1"]?.text, "Hello world");
  });

  it("streams reasoning summaries and tool output by field path", () => {
    let streamingFold = applyEvent(emptyFold(), {
      method: "item/started",
      params: { sessionId: "s", item: { itemId: "r1", kind: "reasoning", status: "inProgress", revision: 1, turnId: "t1" } },
    });
    const makeFieldDelta = (itemId: string, field: string, delta: string): ViewEvent => ({
      method: "item/delta",
      params: { itemId, field, delta },
    });

    streamingFold = applyEvents(streamingFold, [
      makeFieldDelta("r1", "summary.0", "Checking "),
      makeFieldDelta("r1", "summary.0", "tests"),
      makeFieldDelta("r1", "summary.1", "Then build"),
      makeFieldDelta("x9", "output", "npm ok"),
    ]);

    assert.deepStrictEqual(streamingFold.items["r1"]?.summary, ["Checking tests", "Then build"]);
    assert.strictEqual(streamingFold.items["x9"]?.kind, "toolCall");
    assert.strictEqual(streamingFold.items["x9"]?.visibleOutput, "npm ok");
  });

  it("tracks approvals from request to resolution", () => {
    const shellApprovalPayload = {
      approvalId: "a1",
      sessionId: "s",
      subject: { kind: "shell", command: "rm -rf dist" },
      itemId: "tool1",
      availableChoices: [{ choiceId: "yes", label: "Allow once", decision: "approved", scope: "once" }],
      currentRequirementId: { approvalId: "a1", sourceIndex: 0 },
    };

    let foldState = applyEvent(emptyFold(), { method: "approval/requested", params: shellApprovalPayload });
    assert.strictEqual(gateFor(foldState, "tool1")?.kind, "approval");

    foldState = applyEvent(foldState, {
      method: "approval/resolved",
      params: { sessionId: "s", approvalId: "a1", decision: "approved", resolvedBy: "user" },
    });
    assert.deepStrictEqual(foldState.approvals, {});
    assert.strictEqual(foldState.resolved["a1"]?.decision, "approved");

    foldState = applyEvent(foldState, { method: "approval/requested", params: shellApprovalPayload });
    assert.deepStrictEqual(foldState.approvals, {}, "a redelivered request for a resolved approval stays resolved");
  });

  it("records failures, retries and cancellations per turn", () => {
    const foldState = applyEvents(emptyFold(), [
      { method: "turn/started", params: { turnId: "t1" }, at: 1000 },
      {
        method: "turn/retryScheduled",
        params: { turnId: "t1", attempt: 1, maxAttempts: 3, nextAttempt: 2, reason: "rate limited", retryDelayMs: 2000 },
      },
      {
        method: "turn/completed",
        params: { turnId: "t1", terminal: "failed", error: { kind: "modelError", message: "Provider down", retryable: true } },
        at: 5000,
      },
    ]);

    assert.strictEqual(foldState.activeTurnId, null);
    assert.strictEqual(foldState.turns["t1"]?.terminal, "failed");
    assert.strictEqual(foldState.turns["t1"]?.error?.message, "Provider down");
    assert.strictEqual(foldState.turns["t1"]?.retry, undefined);
    assert.strictEqual(foldState.turns["t1"]?.startedAt, 1000);
  });
});

describe("fold: prompt echo reconciliation and reload idempotency", () => {
  it("drops the local echo once the prompt comes back from the stream", () => {
    let threadFold = addEcho(
      emptyFold(),
      { localId: "l1", text: "hello  there", turnId: null, disposition: "sending", createdAt: 1 },
    );
    threadFold = updateEcho(threadFold, "l1", { turnId: "t1", disposition: "started" });
    assert.strictEqual(threadFold.echoes[0]?.turnId, "t1");

    threadFold = applyEvent(threadFold, {
      method: "item/completed",
      params: { item: { itemId: "u1", kind: "userMessage", status: "completed", revision: 1, turnId: "t1", text: "hello there" } },
    });
    assert.strictEqual(threadFold.echoes.length, 0);

    let racedFold = applyEvent(emptyFold(), {
      method: "item/completed",
      params: { item: { itemId: "u2", kind: "userMessage", status: "completed", revision: 1, turnId: "t2", text: "fast" } },
    });
    racedFold = addEcho(racedFold, { localId: "l2", text: "fast", turnId: null, disposition: "sending", createdAt: 1 });
    racedFold = updateEcho(racedFold, "l2", { turnId: "t2", disposition: "started" });
    assert.strictEqual(racedFold.echoes.length, 0, "an echo whose prompt already landed is dropped on ack");
  });

  it("clears an acknowledged slash turn's echo even before the shown text arrives", () => {
    let commandFold = addEcho(
      emptyFold(),
      { localId: "l1", text: "/plan tidy", turnId: null, disposition: "sending", createdAt: 1 },
    );
    commandFold = applyEvent(commandFold, {
      method: "item/started",
      params: { item: { itemId: "u1", kind: "userMessage", status: "inProgress", revision: 1, turnId: "t1", text: "Use skill bundled:plan first" } },
    });
    commandFold = updateEcho(commandFold, "l1", { turnId: "t1", disposition: "started" });
    assert.strictEqual(commandFold.echoes.length, 0, "the acknowledged turn identifies the expanded prompt");

    commandFold = applyEvent(commandFold, {
      method: "item/completed",
      params: {
        item: { itemId: "u1", kind: "userMessage", status: "completed", revision: 2, turnId: "t1", text: "Use skill bundled:plan first", displayText: "/plan tidy" },
      },
    });
    assert.strictEqual(commandFold.echoes.length, 0, "the revision with the shown text clears it");

    let strayFold = addEcho(emptyFold(), { localId: "l2", text: "typed", turnId: "t2", disposition: "started", createdAt: 1 });
    strayFold = applyEvent(strayFold, {
      method: "item/completed",
      params: { item: { itemId: "u2", kind: "userMessage", status: "completed", revision: 1, turnId: "t2", text: "sent" } },
    });
    assert.strictEqual(strayFold.echoes.length, 0, "the saved prompt replaces its local copy despite rewritten text");

    strayFold = applyEvent(strayFold, { method: "turn/completed", params: { turnId: "t2", terminal: "completed" } });
    assert.strictEqual(strayFold.echoes.length, 0, "a finished turn whose prompt landed needs no local copy");
  });

  it("keeps queued prompts until their turn launches or is reclaimed", () => {
    let queuedFold = addEcho(
      emptyFold(),
      { localId: "q1", text: "next", turnId: "t5", disposition: "queued", createdAt: 1 },
    );
    queuedFold = applyEvent(queuedFold, { method: "turn/started", params: { turnId: "t5" } });
    assert.strictEqual(queuedFold.echoes[0]?.disposition, "started");

    queuedFold = addEcho(queuedFold, { localId: "q2", text: "later", turnId: "t6", disposition: "queued", createdAt: 2 });
    queuedFold = applyEvent(queuedFold, { method: "turn/unqueued", params: { turnId: "t6", commandId: "t6" } });
    assert.deepStrictEqual(queuedFold.echoes.map((e) => e.localId), ["q1"]);
  });

  it("builds a fold from a resume load with the server's pending set", () => {
    const userInputRequestedIndex = liveEvents.findIndex((e) => e.method === "userInput/requested");
    const rawPendingInput = liveEvents[userInputRequestedIndex]?.params;

    const resumeFold = foldFromLoad({
      events: historyEvents,
      session: null,
      truncated: false,
      readOnly: false,
      readOnlyReason: null,
      pending: { approvals: [], userInputs: [rawPendingInput as never] },
      msp: { status: "running", activeTurnId: "t-live", modelId: "m", approvalMode: "denyUnmatched", workspaceRoot: "/w", turnCount: 3 },
    });

    assert.strictEqual(resumeFold.activeTurnId, "t-live");
    assert.strictEqual(Object.keys(resumeFold.userInputs).length, 1);
    assert.strictEqual(resumeFold.meta.approvalMode, "onRequest", "events win over the resume snapshot");
  });

  it("does not show a prompt twice when the thread reloads while it is in flight (#55)", () => {
    const makeLoadEnvelope = (events: ViewEvent[]): TranscriptLoad => ({
      session: null,
      events,
      truncated: false,
      readOnly: false,
      readOnlyReason: null,
      pending: { approvals: [], userInputs: [] },
      msp: { status: "running", activeTurnId: "t2", modelId: "m", approvalMode: "onRequest", workspaceRoot: "/w", turnCount: 2 },
    });

    const makeTurnPromptItem = (itemId: string, turnId: string, text: string): ViewEvent => ({
      at: 1,
      method: "item/completed",
      params: { item: { itemId, kind: "userMessage", status: "completed", revision: 1, turnId, text } },
    });

    let liveThreadFold = addEcho(emptyFold(), { localId: "l1", text: "continue", turnId: "t2", disposition: "started", createdAt: 1 });
    liveThreadFold = addEcho(liveThreadFold, { localId: "l2", text: "later", turnId: "t3", disposition: "queued", createdAt: 2 });
    liveThreadFold = addEcho(liveThreadFold, { localId: "l3", text: "continue", turnId: null, disposition: "sending", createdAt: 3 });

    const reloadedTranscript = foldFromLoad(
      makeLoadEnvelope([
        { at: 1, method: "turn/started", params: { turnId: "t1" } },
        makeTurnPromptItem("u1", "t1", "continue"),
        { at: 1, method: "turn/completed", params: { turnId: "t1", terminal: "completed" } },
        { at: 1, method: "turn/started", params: { turnId: "t2" } },
        makeTurnPromptItem("u2", "t2", "continue"),
      ]),
      liveThreadFold,
    );

    assert.deepStrictEqual(
      reloadedTranscript.echoes.map((e) => e.localId),
      ["l2", "l3"],
      "the acknowledged echo the history already holds goes; a queued one and an unacknowledged one stay",
    );

    const occurrencesCount =
      buildTurns(reloadedTranscript).filter((t) => t.prompt?.text === "continue").length +
      reloadedTranscript.echoes.filter((e) => e.text === "continue" && e.disposition !== "queued").length;
    assert.strictEqual(occurrencesCount, 3, "two prompts from history plus the one still being sent, each exactly once");
  });

  it("returns the same fold for an empty batch", () => {
    const emptySourceFold = emptyFold();
    assert.strictEqual(applyEvents(emptySourceFold, []), emptySourceFold);
  });
});

describe("fold: subagent child filtering and throughput", () => {
  const makeDummyChildEvent = (itemId: string): ViewEvent => ({
    method: "item/completed",
    at: 100,
    params: {
      sessionId: "s1",
      item: {
        itemId,
        kind: "reminderChild",
        status: "completed",
        revision: 1,
        turnId: "t1",
        text: "static_synthetic_subagent_reminder_payload",
      },
    },
  });

  const dummyReminderChildEvent = makeDummyChildEvent("child_static_reminder");

  it("are left out of the fold, since nothing ever renders them", () => {
    const dismissedFold = foldSequence([
      dummyReminderChildEvent,
      makeDummyChildEvent("c2"),
      makeDummyChildEvent("c3"),
    ]);
    assert.deepStrictEqual(Object.keys(dismissedFold.items), []);
    assert.deepStrictEqual(dismissedFold.order, []);
  });

  it("cost a thread nothing as they pile up", () => {
    let benchmarkFold = emptyFold();
    const BENCHMARK_CHILD_COUNT = 10_000;
    const tStart = performance.now();
    for (let i = 0; i < BENCHMARK_CHILD_COUNT; i += 1) {
      benchmarkFold = applyEvent(benchmarkFold, dummyReminderChildEvent);
    }
    const elapsedDurationMs = performance.now() - tStart;

    assert.strictEqual(benchmarkFold.order.length, 0, "order array must remain empty");
    assert.strictEqual(Object.keys(benchmarkFold.items).length, 0, "items index must remain empty");
    assert.ok(
      elapsedDurationMs < 10_000,
      `${BENCHMARK_CHILD_COUNT} subagent children took ${elapsedDurationMs.toFixed(2)}ms (budget: < 10000ms)`,
    );
  });
});

describe("fold: crew trace attempt lifecycles and tool call recording", () => {
  const BASE_EPOCH = Date.UTC(2026, 8, 26, 14, 2, 0);

  const makeWfTraceEvent = (
    revision: number,
    children: unknown[],
    atTime?: number,
    status = "inProgress",
    extraProps: Record<string, unknown> = {},
  ): ViewEvent => ({
    method: revision === 1 ? "item/started" : status === "inProgress" ? "item/updated" : "item/completed",
    ...(atTime !== undefined ? { at: atTime } : {}),
    params: {
      item: {
        itemId: "wf",
        kind: "workflow",
        status,
        revision,
        turnId: "t1",
        children,
        ...extraProps,
      },
    },
  });

  it("stamps each attempt's lifecycle steps the first time they show, from the live event's time", () => {
    const traceFold = foldSequence([
      makeWfTraceEvent(1, [{ childId: "a", attempt: 1, status: "scheduled", label: "read" }], BASE_EPOCH),
      makeWfTraceEvent(2, [{ childId: "a", attempt: 1, status: "started" }], BASE_EPOCH + 2_000),
      makeWfTraceEvent(3, [{ childId: "a", attempt: 1, status: "started" }], BASE_EPOCH + 3_000),
      makeWfTraceEvent(4, [{ childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 10, outputTokens: 2 } }], BASE_EPOCH + 60_000),
      makeWfTraceEvent(5, [{ childId: "a", attempt: 1, status: "completed" }], BASE_EPOCH + 61_000),
      makeWfTraceEvent(6, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed", durationMs: 59_000 }], BASE_EPOCH + 62_000),
    ]);

    const activeWorkflowRun = traceFold.crew.runs["wf"];
    assert.ok(activeWorkflowRun);
    assert.deepStrictEqual(activeWorkflowRun.children["a:1"], {
      scheduledAt: BASE_EPOCH,
      startedAt: BASE_EPOCH + 2_000,
      usageAt: BASE_EPOCH + 60_000,
      completedAt: BASE_EPOCH + 61_000,
      terminalAt: BASE_EPOCH + 62_000,
      lastEventAt: BASE_EPOCH + 62_000,
      usage: { inputTokens: 10, outputTokens: 2 },
      label: "read",
      terminal: "completed",
      durationMs: 59_000,
      approx: false,
    });
    assert.strictEqual(activeWorkflowRun.startedAt, BASE_EPOCH);
    assert.strictEqual(activeWorkflowRun.approx, false);
    assert.strictEqual(activeWorkflowRun.endedAt, null);

    const minuteStep = BASE_EPOCH / 60_000;
    assert.deepStrictEqual(activeWorkflowRun.eventMinutes, [minuteStep, minuteStep, minuteStep + 1, minuteStep + 1, minuteStep + 1]);
  });

  it("falls back to the item's record time, and keeps an unchanged attempt's record by identity", () => {
    const makeTimeMeta = (timestampMs: number) => ({ recordedAt: new Date(timestampMs).toISOString() });

    let traceFold = foldSequence([
      makeWfTraceEvent(1, [{ childId: "a", attempt: 1, status: "scheduled" }, { childId: "b", attempt: 1, status: "scheduled" }], undefined, "inProgress", makeTimeMeta(BASE_EPOCH)),
      makeWfTraceEvent(2, [{ childId: "a", attempt: 1, status: "started" }, { childId: "b", attempt: 1, status: "scheduled" }], undefined, "inProgress", makeTimeMeta(BASE_EPOCH + 5_000)),
    ]);

    const priorTrace = traceFold.crew.runs["wf"]!;
    assert.strictEqual(priorTrace.children["a:1"]?.startedAt, BASE_EPOCH + 5_000);
    assert.strictEqual(priorTrace.children["b:1"]?.lastEventAt, BASE_EPOCH);

    traceFold = applyEvent(
      traceFold,
      makeWfTraceEvent(3, [{ childId: "a", attempt: 1, status: "started" }, { childId: "b", attempt: 1, status: "started" }], undefined, "inProgress", makeTimeMeta(BASE_EPOCH + 9_000)),
    );

    const updatedTrace = traceFold.crew.runs["wf"]!;
    assert.notStrictEqual(updatedTrace, priorTrace, "the trace is copied for the revision");
    assert.strictEqual(updatedTrace.children["a:1"], priorTrace.children["a:1"], "an attempt the revision did not touch keeps its record");
    assert.strictEqual(updatedTrace.children["b:1"]?.startedAt, BASE_EPOCH + 9_000);
    assert.strictEqual(priorTrace.children["b:1"]?.startedAt, undefined, "the fold on screen is never changed under it");

    const untimedFold = foldSequence([makeWfTraceEvent(1, [{ childId: "a", attempt: 1, status: "scheduled" }])]);
    assert.deepStrictEqual(untimedFold.crew.runs["wf"]?.children["a:1"], { lastEventAt: null, approx: false });
    assert.strictEqual(untimedFold.crew.runs["wf"]?.startedAt, null);
  });

  it("latches the usage Muse sends once, and notes the run's start from revision 1 and its end", () => {
    let traceFold = foldSequence([
      makeWfTraceEvent(1, [{ childId: "a", attempt: 1, status: "started" }], BASE_EPOCH),
      makeWfTraceEvent(2, [{ childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 } }], BASE_EPOCH + 10_000),
      makeWfTraceEvent(3, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], BASE_EPOCH + 11_000),
    ]);

    assert.deepStrictEqual(traceFold.crew.runs["wf"]?.children["a:1"]?.usage, {
      inputTokens: 48_333,
      outputTokens: 4_004,
      reasoningTokens: 3_409,
    });
    assert.strictEqual(traceFold.items["wf"]?.children?.[0]?.usage, undefined, "the item shows what Muse sent last");

    traceFold = applyEvent(
      traceFold,
      makeWfTraceEvent(4, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], BASE_EPOCH + 12_000, "completed"),
    );
    assert.strictEqual(traceFold.crew.runs["wf"]?.startedAt, BASE_EPOCH);
    assert.strictEqual(traceFold.crew.runs["wf"]?.endedAt, BASE_EPOCH + 12_000);
    assert.strictEqual(traceFold.crew.runs["wf"]?.children["a:1"]?.lastEventAt, BASE_EPOCH + 11_000, "the run ending is not the agent moving");
  });

  it("marks a run first seen past revision 1, and a child first seen under way, as approximate", () => {
    const version7Uuid = "01a0dbae-727a-7543-b502-a584a609ad8b";
    const parsedScheduledTime = parseInt(version7Uuid.slice(0, 8) + version7Uuid.slice(9, 13), 16);

    const approximateFold = foldSequence([
      makeWfTraceEvent(
        22,
        [{ childId: version7Uuid, attempt: 1, status: "started" }, { childId: "plain", attempt: 1, status: "terminal", terminal: "completed" }],
        parsedScheduledTime + 90_000,
      ),
    ]);

    const activeRun = approximateFold.crew.runs["wf"]!;
    assert.strictEqual(activeRun.approx, true);
    assert.strictEqual(activeRun.startedAt, parsedScheduledTime + 90_000);
    assert.deepStrictEqual(activeRun.children[`${version7Uuid}:1`], {
      scheduledAt: parsedScheduledTime,
      startedAt: parsedScheduledTime + 90_000,
      lastEventAt: parsedScheduledTime + 90_000,
      approx: true,
    });
    assert.deepStrictEqual(activeRun.children["plain:1"], {
      terminalAt: parsedScheduledTime + 90_000,
      lastEventAt: parsedScheduledTime + 90_000,
      terminal: "completed",
      approx: true,
    });

    assert.strictEqual(uuidTime(version7Uuid), parsedScheduledTime);
    assert.strictEqual(uuidTime("0192f3a1-6b2e-4c40-9a1d-3e5f7b8c9d02"), null, "only version 7 carries a clock");
    assert.strictEqual(uuidTime("plain"), null);

    const retriedFold = foldSequence([
      makeWfTraceEvent(30, [{ childId: version7Uuid, attempt: 2, status: "started" }], parsedScheduledTime + 200_000),
    ]);
    assert.deepStrictEqual(retriedFold.crew.runs["wf"]?.children[`${version7Uuid}:2`], {
      startedAt: parsedScheduledTime + 200_000,
      lastEventAt: parsedScheduledTime + 200_000,
      approx: true,
    });
  });

  it("keeps an attempt's record after a retry drops it from the item", () => {
    const retryLifecycleFold = foldSequence([
      makeWfTraceEvent(1, [{ childId: "a", attempt: 1, status: "scheduled", label: "design:x" }], BASE_EPOCH),
      makeWfTraceEvent(2, [{ childId: "a", attempt: 1, status: "terminal", terminal: "failed", durationMs: 5_000 }], BASE_EPOCH + 5_000),
      makeWfTraceEvent(3, [{ childId: "a", attempt: 2, status: "scheduled" }], BASE_EPOCH + 6_000),
    ]);

    assert.deepStrictEqual(Object.keys(retryLifecycleFold.crew.runs["wf"]?.children ?? {}), ["a:1", "a:2"]);
    assert.strictEqual(retryLifecycleFold.crew.runs["wf"]?.children["a:1"]?.terminal, "failed");
    assert.strictEqual(retryLifecycleFold.crew.runs["wf"]?.children["a:1"]?.label, "design:x");
    assert.strictEqual(retryLifecycleFold.crew.runs["wf"]?.children["a:2"]?.scheduledAt, BASE_EPOCH + 6_000);
  });

  it("carries the trace across a partial page and merges a full reload's record times with the live ones", () => {
    const liveStreamFold = foldSequence([
      makeWfTraceEvent(1, [{ childId: "a", attempt: 1, status: "scheduled" }], BASE_EPOCH),
      makeWfTraceEvent(2, [{ childId: "a", attempt: 1, status: "started" }], BASE_EPOCH + 2_000),
      makeWfTraceEvent(3, [{ childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 5 } }], BASE_EPOCH + 3_000),
    ]);

    const makePageSnapshot = (events: ViewEvent[], isPartial: boolean): TranscriptLoad => ({
      events,
      session: null,
      msp: null,
      readOnlyReason: null,
      pending: { approvals: [], userInputs: [] },
      readOnly: false,
      truncated: isPartial,
      ...(isPartial ? { historyUnavailable: true } : {}),
    });

    const makeTimestampMeta = (ms: number) => ({ recordedAt: new Date(ms).toISOString() });

    const partialFold = foldFromLoad(
      makePageSnapshot(
        [makeWfTraceEvent(4, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], undefined, "inProgress", makeTimestampMeta(BASE_EPOCH + 4_500))],
        true,
      ),
      liveStreamFold,
    );

    assert.deepStrictEqual(partialFold.crew.runs["wf"]?.children["a:1"], {
      scheduledAt: BASE_EPOCH,
      startedAt: BASE_EPOCH + 2_000,
      usageAt: BASE_EPOCH + 3_000,
      terminalAt: BASE_EPOCH + 4_500,
      lastEventAt: BASE_EPOCH + 4_500,
      usage: { inputTokens: 5 },
      terminal: "completed",
      approx: false,
    });
    assert.strictEqual(partialFold.crew.runs["wf"]?.startedAt, BASE_EPOCH);

    const fullReloadFold = foldFromLoad(
      makePageSnapshot(
        [
          makeWfTraceEvent(2, [{ childId: "a", attempt: 1, status: "started" }], undefined, "inProgress", makeTimestampMeta(BASE_EPOCH + 2_400)),
          makeWfTraceEvent(3, [{ childId: "a", attempt: 1, status: "usage" }], undefined, "inProgress", makeTimestampMeta(BASE_EPOCH + 3_400)),
          makeWfTraceEvent(4, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], undefined, "inProgress", makeTimestampMeta(BASE_EPOCH + 4_400)),
        ],
        false,
      ),
      liveStreamFold,
    );

    const mergedRun = fullReloadFold.crew.runs["wf"]!;
    assert.strictEqual(mergedRun.startedAt, BASE_EPOCH, "the live start from revision 1 beats a capped page's first revision");
    assert.strictEqual(mergedRun.approx, false);
    assert.strictEqual(mergedRun.children["a:1"]?.scheduledAt, BASE_EPOCH, "the page never saw the scheduling revision; the live trace did");
    assert.strictEqual(mergedRun.children["a:1"]?.startedAt, BASE_EPOCH + 2_000, "the earlier of two exact readings");
    assert.deepStrictEqual(mergedRun.children["a:1"]?.usage, { inputTokens: 5 }, "usage the page never carried is kept");
    assert.strictEqual(mergedRun.children["a:1"]?.terminalAt, BASE_EPOCH + 4_400);
    assert.strictEqual(mergedRun.children["a:1"]?.approx, false);

    const evictedFold = foldFromLoad(
      makePageSnapshot([makeWfTraceEvent(1, [{ childId: "z", attempt: 1, status: "started" }], undefined, "inProgress", { itemId: "other" })], false),
      liveStreamFold,
    );
    assert.deepStrictEqual(Object.keys(evictedFold.crew.runs), ["other"]);
  });

  it("traces a tool call while it runs and keeps it only when it ran in the background", () => {
    const makeToolEvent = (
      itemId: string,
      revision: number,
      status: string,
      atTime: number,
      extraProps: Record<string, unknown> = {},
    ): ViewEvent => ({
      method: status === "inProgress" ? (revision === 1 ? "item/started" : "item/updated") : "item/completed",
      at: atTime,
      params: { item: { itemId, kind: "toolCall", status, revision, tool: "bash", args: JSON.stringify({ command: "npm test" }), ...extraProps } },
    });

    let toolTraceFold = foldSequence([
      makeToolEvent("t1", 1, "inProgress", BASE_EPOCH),
      makeToolEvent("t2", 1, "inProgress", BASE_EPOCH + 1_000),
    ]);
    assert.deepStrictEqual(toolTraceFold.crew.tasks["t1"], { firstSeenAt: BASE_EPOCH, approx: false, lastOutputAt: null, endedAt: null });

    toolTraceFold = applyEvents(toolTraceFold, [
      { method: "item/delta", at: BASE_EPOCH + 30_000, params: { itemId: "t1", field: "output", delta: "12 passed\n" } },
      { method: "item/delta", params: { itemId: "t2", field: "output", delta: "no time on this one\n" } },
      makeToolEvent("t1", 2, "inProgress", BASE_EPOCH + 40_000, { background: true, backgroundInitiator: "user" }),
    ]);

    assert.strictEqual(toolTraceFold.crew.tasks["t1"]?.lastOutputAt, BASE_EPOCH + 30_000);
    assert.strictEqual(toolTraceFold.crew.tasks["t1"]?.firstSeenAt, BASE_EPOCH, "backgrounding it later does not move its start");
    assert.strictEqual(toolTraceFold.crew.tasks["t2"]?.lastOutputAt, null);

    toolTraceFold = applyEvents(toolTraceFold, [
      makeToolEvent("t1", 3, "completed", BASE_EPOCH + 90_000, { background: true }),
      makeToolEvent("t2", 2, "completed", BASE_EPOCH + 91_000),
    ]);

    assert.strictEqual(toolTraceFold.crew.tasks["t1"]?.endedAt, BASE_EPOCH + 90_000);
    assert.strictEqual(toolTraceFold.crew.tasks["t2"]?.endedAt, BASE_EPOCH + 91_000, "a foreground tool keeps its completion for monitoring");

    const sampleUuid = "01a0f3c4-6d2e-7b1a-8c3f-5e9d2a7b4c10";
    const pagedExecution = foldSequence([
      { method: "item/updated", params: { item: { itemId: sampleUuid, kind: "toolCall", status: "inProgress", revision: 1, background: true } } },
    ]);
    assert.deepStrictEqual(pagedExecution.crew.tasks[sampleUuid], {
      firstSeenAt: uuidTime(sampleUuid),
      approx: true,
      lastOutputAt: null,
      endedAt: null,
    });
  });

  it("notes when a request was raised and when it was answered", () => {
    let requestsFold = foldSequence([
      { method: "approval/requested", at: BASE_EPOCH, params: { approvalId: "ap1", itemId: "tool-1", sessionId: "s" } },
      { method: "approval/updated", at: BASE_EPOCH + 500, params: { approvalId: "ap1", itemId: "tool-1", sessionId: "s" } },
      { method: "userInput/requested", at: BASE_EPOCH + 1_000, params: { userInputId: "q1", questions: [] } },
      { method: "approval/requested", params: { approvalId: "ap2", sessionId: "s" } },
    ]);

    assert.deepStrictEqual(requestsFold.crew.requests, {
      ap1: { kind: "approval", itemId: "tool-1", askedAt: BASE_EPOCH, decidedAt: null },
      q1: { kind: "input", itemId: null, askedAt: BASE_EPOCH + 1_000, decidedAt: null },
      ap2: { kind: "approval", itemId: null, askedAt: null, decidedAt: null },
    });

    requestsFold = applyEvents(requestsFold, [
      { method: "approval/resolved", at: BASE_EPOCH + 100_000, params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } },
      { method: "userInput/settled", at: BASE_EPOCH + 120_000, params: { userInputId: "q1", outcome: "answered", answers: [] } },
    ]);

    assert.strictEqual(requestsFold.crew.requests["ap1"]?.decidedAt, BASE_EPOCH + 100_000);
    assert.strictEqual(requestsFold.crew.requests["q1"]?.decidedAt, BASE_EPOCH + 120_000);
    assert.strictEqual(requestsFold.crew.requests["ap2"]?.decidedAt, null);
  });
});
