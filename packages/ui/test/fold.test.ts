import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addEcho,
  applyEvent,
  applyEvents,
  buildTurns,
  emptyFold,
  foldFromLoad,
  gateFor,
  updateEcho,
  uuidTime,
} from "../src/model/fold.js";
import type { TranscriptLoad, ViewEvent } from "../src/types.js";
import { historyEvents, liveEvents } from "./fixtures/probe.js";

function foldAll(events: ViewEvent[]) {
  return applyEvents(emptyFold(), events);
}

describe("non-authoritative history recovery", () => {
  const partial = (events: ViewEvent[], activeTurnId: string | null = "active"): TranscriptLoad => ({
    session: null,
    msp: { status: activeTurnId ? "running" : "idle", activeTurnId, modelId: "model", approvalMode: "onRequest", workspaceRoot: "/w", turnCount: 2 },
    events, truncated: false, historyUnavailable: true,
    viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
    pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null,
  });

  it("preserves live terminal outcomes and cumulative totals while backfilling an unseen usage call", () => {
    const previous = foldAll([
      { method: "turn/completed", params: { turnId: "old", terminal: "completed", durationMs: 500 }, at: 500 },
      { method: "turn/started", params: { turnId: "active" }, at: 600 },
      { method: "session/tokenUsage", params: { viewCursor: "usage-new", turnId: "active", cumulative: { promptTokens: 200, outputTokens: 20, totalTokens: 220 }, usage: { inputTokens: 100, outputTokens: 10 } } },
    ]);
    const load = partial([
      { method: "turn/completed", params: { turnId: "old", terminal: "failed", reason: "incomplete", error: { kind: "incomplete", message: "old projection", retryable: false } } },
      { method: "session/tokenUsage", params: { viewCursor: "usage-old", turnId: "old", cumulative: { promptTokens: 100, outputTokens: 10, totalTokens: 110 }, usage: { inputTokens: 100, outputTokens: 10 } } },
      { method: "session/closed", params: {} },
    ]);
    const recovered = foldFromLoad(load, previous);
    assert.deepEqual(recovered.turns.old, previous.turns.old);
    assert.equal(recovered.activeTurnId, "active");
    assert.deepEqual(recovered.meta.tokenTotals, previous.meta.tokenTotals);
    assert.deepEqual(Object.keys(recovered.meta.calls).sort(), ["usage-new", "usage-old"]);
    assert.deepEqual(foldFromLoad(load, recovered).meta.calls, recovered.meta.calls, "repeated reads do not count usage twice");
    assert.deepEqual(Object.keys(previous.meta.calls), ["usage-new"], "the live fold stays immutable");
    const advanced = foldFromLoad(partial([{ method: "session/tokenUsage", params: { viewCursor: "usage-later", cumulative: { promptTokens: 300, outputTokens: 30, totalTokens: 330 } } }]), recovered);
    assert.equal(advanced.meta.tokenTotals?.totalTokens, 330);
  });

  it("rejects a partial terminal for the running session but recovers a genuinely ended active turn", () => {
    const previous = addEcho(foldAll([{ method: "turn/started", params: { turnId: "active" }, at: 10 }]), {
      localId: "echo", text: "Work", turnId: "active", disposition: "started", createdAt: 9,
    });
    const failure: ViewEvent = { method: "turn/completed", params: { turnId: "active", terminal: "failed", error: { kind: "incomplete", message: "partial", retryable: false } } };
    const running = foldFromLoad(partial([failure]), previous);
    assert.equal(running.turns.active?.terminal, undefined);
    assert.equal(running.echoes.length, 1);
    const ended = foldFromLoad(partial([{ method: "turn/completed", params: { turnId: "active", terminal: "completed" }, at: 30 }], null), running);
    assert.equal(ended.activeTurnId, null);
    assert.equal(ended.turns.active?.terminal, "completed");
    assert.equal(ended.turns.active?.startedAt, 10);
    assert.equal(ended.echoes.length, 0);
  });

  describe("Muse's failed/incomplete record for a run the projection cannot see the end of", () => {
    const said = (itemId: string, turnId: string, text: string, kind = "userMessage"): ViewEvent => ({
      method: "item/completed", params: { item: { itemId, kind, turnId, text, revision: 1, status: "completed" } },
    });
    const incomplete = (turnId: string): ViewEvent => ({ method: "turn/completed", params: { turnId, terminal: "failed", reason: "incomplete" } });
    const running = foldAll([{ method: "turn/started", params: { turnId: "A" }, at: 1 }, said("uA", "A", "refactor")]);

    it("is not taken as a failure of a turn the session no longer runs, and the real outcome replaces it later", () => {
      const ended = foldFromLoad(partial([said("uA", "A", "refactor"), incomplete("A")], null), running);
      assert.equal(ended.turns.A?.terminal, "unknown");
      assert.equal(ended.turns.A?.error, undefined);
      assert.equal(ended.activeTurnId, null);
      assert.notEqual(buildTurns(ended).at(-1)?.info?.terminal, "failed");
      const again = foldFromLoad(partial([said("uA", "A", "refactor"), incomplete("A")], null), ended);
      assert.equal(again.turns.A?.terminal, "unknown", "a repeated placeholder changes nothing");
      const saved = foldFromLoad(partial([
        said("uA", "A", "refactor"), said("fin", "A", "Done.", "agentMessage"),
        { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
      ], null), again);
      assert.equal(saved.turns.A?.terminal, "completed", "a later partial read with the real outcome replaces the placeholder");
      assert.equal(buildTurns(saved).at(-1)?.final?.text, "Done.");
      const stale = foldFromLoad(partial([said("uA", "A", "refactor"), incomplete("A")], null), saved);
      assert.equal(stale.turns.A?.terminal, "completed", "an older placeholder never replaces a real outcome");
      const live = applyEvent(ended, { method: "turn/completed", params: { turnId: "A", terminal: "completed" } });
      assert.equal(live.turns.A?.terminal, "completed");
      assert.equal(live.turns.A?.provisional, undefined, "a live outcome is final");
    });

    it("is not taken as a failure of a finished turn while the session runs the next one", () => {
      const next = foldFromLoad(partial([said("uA", "A", "refactor"), incomplete("A")], "B"), running);
      assert.equal(next.turns.A?.terminal, "unknown");
      assert.equal(next.activeTurnId, "B");
    });

    it("leaves the turn running when the session's own state is unknown", () => {
      const load = { ...partial([incomplete("A")]), msp: null };
      const kept = foldFromLoad(load, running);
      assert.equal(kept.turns.A?.terminal, undefined);
      assert.equal(kept.activeTurnId, "A");
    });

    it("keeps a real saved failure visible", () => {
      const failure: ViewEvent = { method: "turn/completed", params: { turnId: "A", terminal: "failed", error: { kind: "provider", message: "Provider down", retryable: true } } };
      const shown = foldFromLoad(partial([failure], null), running);
      assert.equal(shown.turns.A?.terminal, "failed");
      assert.equal(shown.turns.A?.error?.message, "Provider down");
      const later = foldFromLoad(partial([{ method: "turn/completed", params: { turnId: "A", terminal: "completed" } }], null), shown);
      assert.equal(later.turns.A?.terminal, "failed", "only a placeholder gives way to a later read");
    });

    it("gives way to a real outcome read or streamed later, and never softens one already shown", () => {
      const placeholder = foldFromLoad(partial([said("uA", "A", "refactor"), incomplete("A")], null), running);
      assert.equal(placeholder.turns.A?.terminal, "unknown");
      const failure: ViewEvent = { method: "turn/completed", params: { turnId: "A", terminal: "failed", error: { kind: "provider", message: "Provider down", retryable: true } } };
      const failed = foldFromLoad(partial([failure], null), placeholder);
      assert.equal(failed.turns.A?.terminal, "failed", "a real failure read later replaces the placeholder");
      assert.equal(failed.turns.A?.error?.message, "Provider down");
      assert.equal(foldFromLoad(partial([incomplete("A")], null), failed).turns.A?.terminal, "failed", "a later placeholder does not soften it");
      const streamed = applyEvent(placeholder, { method: "turn/completed", params: { turnId: "A", terminal: "completed" }, at: 5 });
      assert.equal(streamed.turns.A?.terminal, "completed", "a live outcome that arrived during the read replaces the placeholder");
      assert.equal(foldFromLoad(partial([said("uA", "A", "refactor"), incomplete("A")], null), streamed).turns.A?.terminal, "completed");
      const shown = applyEvent(running, failure);
      const contradicted = foldFromLoad(partial([{ method: "turn/completed", params: { turnId: "A", terminal: "completed" } }], null), shown);
      assert.equal(contradicted.turns.A?.error?.message, "Provider down", "a failure the live feed showed is never replaced by a page");
    });
  });

  it("lets a saved finished item replace an open one, and never reopens a finished one", () => {
    const wf = (revision: number, status: string): ViewEvent => ({
      method: "item/updated", params: { item: { itemId: "wf", kind: "workflow", turnId: "active", revision, status, children: [] } },
    });
    const open = foldAll([1, 2, 3, 4].map((revision) => wf(revision, "inProgress")));
    // History numbers revisions apart from the live feed, so a saved completion can carry a lower number.
    assert.equal(foldFromLoad(partial([wf(2, "completed")]), open).items.wf?.status, "completed");
    const done = foldAll([wf(1, "inProgress"), wf(2, "completed")]);
    assert.equal(foldFromLoad(partial([wf(5, "inProgress")]), done).items.wf?.status, "completed");
  });

  it("places backfilled items where the page has them, not after everything on screen", () => {
    const said = (itemId: string, turnId: string, kind = "toolCall", text?: string): ViewEvent => ({
      method: "item/completed", params: { item: { itemId, kind, turnId, text, revision: 1, status: "completed" } },
    });
    const previous = foldAll([
      { method: "turn/started", params: { turnId: "A" } },
      said("uA", "A", "userMessage", "do it"), said("t1", "A"), said("final", "A", "agentMessage", "All done."),
      { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
      { method: "turn/started", params: { turnId: "active" } },
      said("uB", "active", "userMessage", "next"), said("live", "active"),
    ]);
    // The live feed missed t2; the page stops before the newest step on screen.
    const merged = foldFromLoad(partial([said("uA", "A", "userMessage", "do it"), said("t1", "A"), said("t2", "A"), said("final", "A", "agentMessage", "All done."), said("uB", "active", "userMessage", "next")]), previous);
    assert.deepEqual(merged.order, ["uA", "t1", "t2", "final", "uB", "live"]);
    assert.equal(buildTurns(merged)[0]?.final?.text, "All done.", "the reply stays the reply");
    // An older turn first seen in a partial page goes before the newer one.
    const newest = foldAll([{ method: "turn/started", params: { turnId: "active" } }, said("uB", "active", "userMessage", "newest")]);
    const older = foldFromLoad(partial([
      said("uA", "A", "userMessage", "older"),
      { method: "turn/completed", params: { turnId: "A", terminal: "failed", error: { kind: "x", message: "boom", retryable: true } } },
      said("uB", "active", "userMessage", "newest"),
    ]), newest);
    assert.deepEqual(buildTurns(older).map((turn) => turn.turnId), ["A", "active"]);
    // Items only the screen holds, before and after what the page shares with it, keep their place.
    const edges = foldFromLoad(partial([said("t1", "A"), said("t2", "A")]), foldAll([said("t0", "A"), said("t1", "A"), said("t3", "A")]));
    assert.deepEqual(edges.order, ["t0", "t1", "t2", "t3"]);
  });

  it("merges approvals and questions with the history when the host's pending list is incomplete", () => {
    const approval = (approvalId: string, turnId: string) => ({ method: "approval/requested", params: { approvalId, itemId: `tool-${approvalId}`, turnId } });
    const previous = foldAll([
      { method: "turn/started", params: { turnId: "active" } },
      approval("X", "active"),
      approval("K", "active"),
    ]);
    const events: ViewEvent[] = [
      approval("X", "active"),
      { method: "approval/resolved", params: { approvalId: "X", decision: "approved", resolvedBy: "user" } },
      { method: "userInput/requested", params: { userInputId: "Q", itemId: "ask", turnId: "active", questions: [] } },
      approval("OLD", "earlier"),
    ];
    for (const authoritative of [false, true]) {
      const load = { ...partial(events), pendingComplete: false, ...(authoritative ? { historyUnavailable: false, viewHealth: null } : {}) };
      const fold = foldFromLoad(load, previous);
      assert.deepEqual(Object.keys(fold.approvals).sort(), ["K"], "resolved in history: closed; not contradicted: kept; another turn's: not revived");
      assert.deepEqual(Object.keys(fold.userInputs), ["Q"], "a question the running turn is waiting on is shown");
    }
  });

  it("promotes a queued prompt once the session reports its turn running, even if the page stops short of it", () => {
    const previous = addEcho(foldAll([{ method: "turn/started", params: { turnId: "A" } }]), {
      localId: "q", text: "then run tests", turnId: "B", disposition: "queued", createdAt: 2,
    });
    const fold = foldFromLoad(partial([], "B"), previous);
    assert.equal(fold.activeTurnId, "B");
    assert.deepEqual(fold.echoes.map((echo) => echo.disposition), ["started"]);
    // The same holds when the acknowledgement arrives after the turn already started.
    const queued = addEcho(foldAll([{ method: "turn/started", params: { turnId: "B" } }]), {
      localId: "q", text: "then run tests", turnId: null, disposition: "queued", createdAt: 2,
    });
    assert.equal(updateEcho(queued, "q", { turnId: "B", disposition: "queued" }).echoes[0]?.disposition, "started");
  });

  it("keeps the agent labels a partial page holds in an older revision", () => {
    const wf = (revision: number, children: unknown[]): ViewEvent => ({
      method: "item/updated", params: { item: { itemId: "wf", kind: "workflow", turnId: "active", revision, status: "inProgress", children } },
    });
    const previous = foldAll([wf(11, [{ childId: "a", attempt: 1, status: "started" }, { childId: "b", attempt: 1, status: "scheduled" }])]);
    const fold = foldFromLoad(partial([wf(2, [
      { childId: "a", attempt: 1, status: "scheduled", label: "Read alpha" },
      { childId: "b", attempt: 1, status: "scheduled", label: "Verify beta" },
    ])]), previous);
    assert.equal(fold.items.wf?.revision, 11);
    assert.deepEqual(fold.items.wf?.children?.map((child) => [child.label, child.status]), [["Read alpha", "started"], ["Verify beta", "scheduled"]]);
    assert.deepEqual(fold.agentItems?.wf?.children?.map((child) => child.label), ["Read alpha", "Verify beta"]);
  });

  it("neither duplicates nor drops an item across partial pages that overlap the screen differently", () => {
    const said = (itemId: string, turnId: string, kind = "toolCall", text?: string): ViewEvent => ({
      method: "item/completed", params: { item: { itemId, kind, turnId, text, revision: 1, status: "completed" } },
    });
    let fold = foldAll([
      { method: "turn/started", params: { turnId: "A" } },
      said("uA", "A", "userMessage", "a"), said("t1", "A"), said("final", "A", "agentMessage", "All done."),
      { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
      { method: "turn/started", params: { turnId: "active" } },
      said("uB", "active", "userMessage", "b"), said("l1", "active"), said("l2", "active"),
    ]);
    for (const page of [
      [said("uA", "A", "userMessage", "a"), said("t1", "A"), said("t2", "A")],
      [said("t2", "A"), said("t3", "A"), said("final", "A", "agentMessage", "All done.")],
      [said("uA", "A", "userMessage", "a"), said("t1", "A"), said("t2", "A"), said("t3", "A"), said("final", "A", "agentMessage", "All done."), said("uB", "active", "userMessage", "b"), said("l1", "active")],
    ]) {
      fold = foldFromLoad(partial(page), fold);
      assert.equal(new Set(fold.order).size, fold.order.length, "no item is shown twice");
      assert.deepEqual([...fold.order].sort(), Object.keys(fold.items).sort(), "no item is dropped");
    }
    assert.deepEqual(fold.order, ["uA", "t1", "t2", "t3", "final", "uB", "l1", "l2"]);
    assert.equal(buildTurns(fold)[0]?.final?.text, "All done.");
  });

  it("shows the running turn's open requests from the page when a thread first opens with an incomplete pending list", () => {
    const page: ViewEvent[] = [
      { method: "turn/started", params: { turnId: "old" } },
      { method: "approval/requested", params: { approvalId: "Y", itemId: "tool-Y", turnId: "old" } },
      { method: "approval/resolved", params: { approvalId: "Y", decision: "approved", resolvedBy: "user" } },
      { method: "turn/completed", params: { turnId: "old", terminal: "completed" } },
      { method: "turn/started", params: { turnId: "active" } },
      { method: "approval/requested", params: { approvalId: "X", itemId: "tool-X", turnId: "active" } },
      { method: "userInput/requested", params: { userInputId: "Q", itemId: "ask", turnId: "active", questions: [] } },
    ];
    for (const previous of [null, emptyFold()]) {
      const fold = foldFromLoad({ ...partial(page), pendingComplete: false }, previous);
      assert.deepEqual(Object.keys(fold.approvals), ["X"]);
      assert.deepEqual(Object.keys(fold.userInputs), ["Q"]);
    }
  });

  it("merges a long thread's partial page in a fraction of a second", () => {
    const step = (i: number): ViewEvent => ({
      method: "item/completed",
      params: { item: { itemId: `i${i}`, kind: i % 7 === 0 ? "userMessage" : "toolCall", turnId: `T${Math.floor(i / 50)}`, text: `step ${i}`, revision: 1, status: "completed" } },
    });
    let previous = foldAll([{ method: "turn/started", params: { turnId: "active" } }, ...Array.from({ length: 20_000 }, (_, i) => step(i))]);
    previous = addEcho(previous, { localId: "e", text: "step 7", turnId: null, disposition: "sending", createdAt: 1 });
    previous = addEcho(previous, { localId: "s", text: "steer", turnId: "active", disposition: "steered", createdAt: 2 });
    const started = Date.now();
    const merged = foldFromLoad(partial(Array.from({ length: 20_000 }, (_, i) => step(10_000 + i))), previous);
    const took = Date.now() - started;
    assert.equal(merged.order.length, 30_000);
    assert.equal(new Set(merged.order).size, 30_000);
    assert.equal(merged.echoes.length, 2);
    assert.ok(took < 2_000, `a 20k-item page onto 20k shown items took ${took}ms`);
  });

  it("keeps newer plan metadata and explicit clears, then accepts later saved plan changes", () => {
    const previous = foldAll([
      { method: "session/todoListChanged", params: { viewCursor: "v:s:20", items: [{ content: "Verify", status: "inProgress" }] }, at: 20 },
      { method: "session/goalChanged", params: { viewCursor: "v:s:21", goal: null }, at: 21 },
      { method: "session/branchChanged", params: { viewCursor: "v:s:22", branch: null }, at: 22 },
      { method: "session/modelChanged", params: { viewCursor: "v:s:23", modelId: "current-model" }, at: 23 },
    ]);
    const stale = foldFromLoad(partial([
      { method: "session/todoListChanged", params: { viewCursor: "v:s:10", items: [{ content: "Old", status: "pending" }] }, at: 100 },
      { method: "session/goalChanged", params: { viewCursor: "v:s:11", goal: { objective: "Old goal", status: "active" } }, at: 100 },
      { method: "session/branchChanged", params: { branch: "old-branch" } },
      { method: "session/started", params: { session: { modelId: "old-model", approvalMode: { mode: "allowAll" } } } },
    ]), previous);
    assert.deepEqual(stale.meta.todoList, previous.meta.todoList, "cursor order wins over a later read timestamp");
    assert.equal(stale.meta.goal, null, "a cleared goal is known metadata");
    assert.equal(stale.meta.branch, null, "unordered history cannot undo an explicit branch clear");
    assert.equal(stale.meta.modelId, "current-model");
    const advanced = foldFromLoad(partial([
      { method: "session/todoListChanged", params: { viewCursor: "v:s:30", items: [{ content: "Verify", status: "completed" }] } },
      { method: "session/goalChanged", params: { viewCursor: "v:s:31", goal: { objective: "Next goal", status: "active" } } },
      { method: "session/branchChanged", params: { viewCursor: "v:s:32", branch: "next-branch" } },
    ]), stale);
    assert.deepEqual(advanced.meta.todoList, [{ content: "Verify", status: "completed" }]);
    assert.equal(advanced.meta.goal?.objective, "Next goal");
    assert.equal(advanced.meta.branch, "next-branch");
    assert.equal(previous.meta.goal, null);
  });

  it("uses known event times when cursors are absent and preserves current metadata when order is unknown", () => {
    const previous = foldAll([{ method: "session/goalChanged", params: { goal: { objective: "Current", status: "active" } }, at: 20 }]);
    const stale = foldFromLoad(partial([{ method: "session/goalChanged", params: { goal: { objective: "Old", status: "active" } }, at: 10 }]), previous);
    assert.equal(stale.meta.goal?.objective, "Current");
    const unknown = foldFromLoad(partial([{ method: "session/goalChanged", params: { goal: null } }]), stale);
    assert.equal(unknown.meta.goal?.objective, "Current");
    const advanced = foldFromLoad(partial([{ method: "session/goalChanged", params: { goal: null }, at: 30 }]), unknown);
    assert.equal(advanced.meta.goal, null);
    assert.equal(advanced.meta.goalSeen, true);
    const initial = foldFromLoad(partial([{ method: "session/goalChanged", params: { goal: { objective: "Saved goal", status: "active" } } }]), emptyFold());
    assert.equal(initial.meta.goal?.objective, "Saved goal", "unknown metadata can still be backfilled");
  });
});

describe("thread fold against a real muse transcript", () => {
  it("retains each workflow assignment through status-only revisions without retaining an old phase", () => {
    const update = (revision: number, children: unknown[]): ViewEvent => ({
      method: "item/updated", params: { item: { itemId: "workflow-1", kind: "workflow", status: "inProgress", revision, children } },
    });
    let fold = foldAll([update(1, [
      { childId: "a", attempt: 1, label: "Audit navigation", phase: "Inspecting", status: "scheduled" },
      { childId: "b", attempt: 1, label: "Check tests", status: "scheduled" },
    ])]);
    fold = applyEvent(fold, update(2, [
      { childId: "a", attempt: 1, status: "started" },
      { childId: "b", attempt: 1, status: "terminal", terminal: "completed" },
    ]));
    assert.deepEqual(fold.items["workflow-1"]?.children?.map((child) => child.label), ["Audit navigation", "Check tests"]);
    assert.equal(fold.items["workflow-1"]?.children?.[0]?.phase, undefined);
    fold = applyEvent(fold, update(3, [{ childId: "a", attempt: 2, label: "Verify navigation fix", status: "scheduled" }]));
    assert.equal(fold.items["workflow-1"]?.children?.[0]?.label, "Verify navigation fix");
    assert.equal(fold.items["workflow-1"]?.children?.[0]?.terminal, undefined);
    assert.equal(fold.items["workflow-1"]?.children?.length, 1, "removed children are not resurrected");
    fold = applyEvent(fold, update(4, [{ childId: "a", attempt: 3, status: "scheduled" }]));
    assert.equal(fold.items["workflow-1"]?.children?.[0]?.label, undefined, "another attempt does not inherit obsolete metadata");
  });

  it("keeps the small agent index stable while the parent streams ordinary text", () => {
    let fold = foldAll([{ method: "item/started", params: { item: { itemId: "w", kind: "workflow", status: "inProgress", revision: 1 } } }]);
    const agents = fold.agentItems;
    fold = applyEvent(fold, { method: "item/started", params: { item: { itemId: "reply", kind: "agentMessage", status: "inProgress", revision: 1 } } });
    fold = applyEvent(fold, { method: "item/delta", params: { itemId: "reply", delta: "Working", field: "text" } });
    assert.equal(fold.agentItems, agents);
    assert.equal(fold.agentItems?.w, fold.items.w);
    fold = applyEvent(fold, { method: "item/updated", params: { item: { itemId: "w", kind: "workflow", status: "completed", revision: 2 } } });
    assert.notEqual(fold.agentItems, agents);
    assert.equal(fold.agentItems?.w?.status, "completed");
    assert.equal(agents?.w?.status, "inProgress", "the previous snapshot stays immutable");
  });

  it("preserves the visible transcript when the projection cannot supply history", () => {
    const previous = foldAll(historyEvents);
    const recovered = foldFromLoad({
      session: null, msp: null, events: [], truncated: false,
      pending: { approvals: [], userInputs: [] }, pendingComplete: false,
      historyUnavailable: true, readOnly: false, readOnlyReason: null,
    }, previous);
    assert.ok(previous.order.length > 0);
    assert.deepEqual(recovered.order, previous.order);
    assert.deepEqual(recovered.items, previous.items);
    assert.deepEqual(recovered.turns, previous.turns);
  });

  it("merges nonempty unavailable history without dropping newer displayed items or revisions", () => {
    const item = (itemId: string, revision: number, text: string): ViewEvent => ({ method: "item/updated", params: { item: {
      itemId, revision, text, kind: "agentMessage", status: "inProgress", turnId: "active",
    } } });
    const previous = foldAll([item("reply", 5, "Newer visible answer"), item("recent", 1, "Keep this too")]);
    const loaded = foldFromLoad({
      session: null, msp: null, events: [item("reply", 2, "Old answer"), item("new", 1, "Fresh work")], truncated: false,
      pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null,
      viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
    }, previous);
    assert.equal(loaded.items.reply.revision, 5);
    assert.equal(loaded.items.reply.text, "Newer visible answer");
    assert.equal(loaded.items.recent.text, "Keep this too");
    assert.equal(loaded.items.new.text, "Fresh work");
  });

  it("merges a partial stream snapshot once without replaying old deltas or shortening its text", () => {
    const start: ViewEvent = { method: "item/started", params: { item: {
      itemId: "reply", revision: 1, kind: "agentMessage", status: "inProgress", turnId: "active", text: "",
    } } };
    const delta = (text: string): ViewEvent => ({ method: "item/delta", params: { itemId: "reply", field: "text", delta: text } });
    const reload = (events: ViewEvent[], previous: ReturnType<typeof emptyFold>) => foldFromLoad({
      session: null, msp: null, events, truncated: false, historyUnavailable: true,
      pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null,
    }, previous);
    const previous = foldAll([start, delta("Hello")]);
    const grown = reload([start, delta("Hello"), delta(" world")], previous);
    assert.equal(grown.items.reply.text, "Hello world");
    const repeated = reload([start, delta("Hello"), delta(" world")], grown);
    assert.equal(repeated.items.reply.text, "Hello world");
    assert.equal(reload([start, delta("Hello")], grown).items.reply.text, "Hello world");
    assert.equal(previous.items.reply.text, "Hello");
  });

  it("drops a prompt's local copy once its turn ends, landed or not", () => {
    const sending = addEcho(emptyFold(), { localId: "e1", text: "hello", turnId: null, disposition: "sending", createdAt: 1 });
    const started = updateEcho(sending, "e1", { turnId: "t1", disposition: "started" });
    assert.equal(started.echoes.length, 1);

    // The turn died before Muse committed the prompt, so nothing in the transcript matches the echo.
    const failed = applyEvent(started, {
      method: "turn/completed",
      params: { sessionId: "s1", turnId: "t1", terminal: "failed", error: { kind: "rateLimit", message: "quota", retryable: true } },
      at: 2,
    });
    assert.equal(failed.echoes.length, 0, "a failed turn takes its pending bubble with it");

    const quiet = applyEvent(updateEcho(sending, "e1", { turnId: "t2", disposition: "started" }), {
      method: "turn/completed",
      params: { sessionId: "s1", turnId: "t2", terminal: "completed" },
      at: 3,
    });
    assert.equal(quiet.echoes.length, 0, "a turn that committed no prompt item leaves no ghost either");
  });


  it("folds the live stream into three finished turns", () => {
    const fold = liveEvents.reduce(applyEvent, emptyFold());
    const turns = buildTurns(fold);
    assert.equal(turns.length, 3);
    assert.equal(fold.activeTurnId, null);

    const [pong, shell, question] = turns;
    assert.equal(pong?.prompt?.text, "Reply with exactly one word: pong");
    assert.equal(pong?.final?.text, "pong");
    assert.equal(pong?.entries.length, 0, "reminder children stay hidden");
    assert.equal(pong?.info?.durationMs, 42316);

    assert.equal(shell?.entries.length, 1);
    assert.equal(shell?.entries[0]?.kind, "toolCall");
    assert.equal(shell?.entries[0]?.tool, "bash");
    assert.match(shell?.entries[0]?.visibleOutput ?? "", /README\.md/);
    assert.match(shell?.final?.text ?? "", /printed 4 entries/);

    assert.equal(question?.entries[0]?.tool, "request_user_input");
    assert.equal(question?.final?.text, "Blue");
    assert.deepEqual(Object.keys(fold.userInputs), []);
    const settled = Object.values(fold.settled)[0];
    assert.equal(settled?.outcome, "answered");
    assert.equal(settled?.answers[0]?.selectedLabel, "Blue");

    assert.equal(fold.meta.contextUsage?.windowTokens, 1007997);
    assert.equal(fold.meta.tokenTotals?.totalTokens, 108605);
    assert.equal(fold.meta.approvalMode, "onRequest");
    assert.equal(fold.meta.modelId, "muse-spark-1.3-contributor");
  });

  it("shows a turn as running with its streaming reply inline", () => {
    const firstDelta = liveEvents.findIndex((e) => e.method === "item/delta");
    const fold = foldAll(liveEvents.slice(0, firstDelta + 1));
    assert.notEqual(fold.activeTurnId, null);
    const [turn] = buildTurns(fold);
    assert.equal(turn?.running, true);
    assert.equal(turn?.final, null);
    const reply = turn?.entries.find((e) => e.kind === "agentMessage");
    assert.equal(reply?.text, "pong");
    assert.equal(reply?.status, "inProgress");
  });

  it("parks a pending question until it settles", () => {
    const requested = liveEvents.findIndex((e) => e.method === "userInput/requested");
    const fold = foldAll(liveEvents.slice(0, requested + 1));
    const [pending] = Object.values(fold.userInputs);
    assert.equal(pending?.questions[0]?.question, "Which color do you prefer?");
    const toolItem = Object.values(fold.items).find((i) => i.tool === "request_user_input");
    assert.equal(gateFor(fold, toolItem?.itemId ?? "")?.kind, "input");
  });

  it("renders paged history the same as the live stream", () => {
    const live = buildTurns(foldAll(liveEvents));
    const history = buildTurns(foldAll(historyEvents));
    assert.deepEqual(
      history.map((t) => [t.prompt?.text, t.final?.text, t.entries.map((e) => e.kind)]),
      live.map((t) => [t.prompt?.text, t.final?.text, t.entries.map((e) => e.kind)]),
    );
  });

  it("never duplicates items when history and live events overlap", () => {
    const fold = applyEvents(foldAll(historyEvents), liveEvents);
    const ids = fold.order;
    assert.equal(new Set(ids).size, ids.length);
    const live = foldAll(liveEvents);
    assert.equal(fold.order.length, live.order.length);
    const reply = Object.values(fold.items).find((i) => i.kind === "agentMessage" && i.text === "pong");
    assert.equal(reply?.revision, 2, "the higher live revision wins over the paged one");
  });

  it("keeps streamed text when the final arrives empty and ignores late deltas", () => {
    let fold = applyEvent(emptyFold(), {
      method: "item/started",
      params: { sessionId: "s", item: { itemId: "m1", kind: "agentMessage", status: "inProgress", revision: 1, turnId: "t1" } },
    });
    fold = applyEvent(fold, { method: "item/delta", params: { sessionId: "s", itemId: "m1", delta: "Hello world" } });
    fold = applyEvent(fold, {
      method: "item/completed",
      params: { sessionId: "s", item: { itemId: "m1", kind: "agentMessage", status: "completed", revision: 2, turnId: "t1", text: "" } },
    });
    assert.equal(fold.items["m1"]?.text, "Hello world");
    fold = applyEvent(fold, { method: "item/delta", params: { sessionId: "s", itemId: "m1", delta: " again" } });
    assert.equal(fold.items["m1"]?.text, "Hello world");
  });

  it("streams reasoning summaries and tool output by field path", () => {
    let fold = applyEvent(emptyFold(), {
      method: "item/started",
      params: { sessionId: "s", item: { itemId: "r1", kind: "reasoning", status: "inProgress", revision: 1, turnId: "t1" } },
    });
    fold = applyEvents(fold, [
      { method: "item/delta", params: { itemId: "r1", field: "summary.0", delta: "Checking " } },
      { method: "item/delta", params: { itemId: "r1", field: "summary.0", delta: "tests" } },
      { method: "item/delta", params: { itemId: "r1", field: "summary.1", delta: "Then build" } },
      { method: "item/delta", params: { itemId: "x9", field: "output", delta: "npm ok" } },
    ]);
    assert.deepEqual(fold.items["r1"]?.summary, ["Checking tests", "Then build"]);
    assert.equal(fold.items["x9"]?.kind, "toolCall");
    assert.equal(fold.items["x9"]?.visibleOutput, "npm ok");
  });

  it("tracks approvals from request to resolution", () => {
    const request = {
      sessionId: "s",
      approvalId: "a1",
      itemId: "tool1",
      currentRequirementId: { approvalId: "a1", sourceIndex: 0 },
      availableChoices: [{ choiceId: "yes", label: "Allow once", decision: "approved", scope: "once" }],
      subject: { kind: "shell", command: "rm -rf dist" },
    };
    let fold = applyEvent(emptyFold(), { method: "approval/requested", params: request });
    assert.equal(gateFor(fold, "tool1")?.kind, "approval");
    fold = applyEvent(fold, { method: "approval/resolved", params: { sessionId: "s", approvalId: "a1", decision: "approved", resolvedBy: "user" } });
    assert.deepEqual(fold.approvals, {});
    assert.equal(fold.resolved["a1"]?.decision, "approved");
    fold = applyEvent(fold, { method: "approval/requested", params: request });
    assert.deepEqual(fold.approvals, {}, "a redelivered request for a resolved approval stays resolved");
  });

  it("records failures, retries and cancellations per turn", () => {
    const fold = applyEvents(emptyFold(), [
      { method: "turn/started", params: { turnId: "t1" }, at: 1000 },
      { method: "turn/retryScheduled", params: { turnId: "t1", attempt: 1, maxAttempts: 3, nextAttempt: 2, reason: "rate limited", retryDelayMs: 2000 } },
      { method: "turn/completed", params: { turnId: "t1", terminal: "failed", error: { kind: "modelError", message: "Provider down", retryable: true } }, at: 5000 },
    ]);
    assert.equal(fold.activeTurnId, null);
    assert.equal(fold.turns["t1"]?.terminal, "failed");
    assert.equal(fold.turns["t1"]?.error?.message, "Provider down");
    assert.equal(fold.turns["t1"]?.retry, undefined);
    assert.equal(fold.turns["t1"]?.startedAt, 1000);
  });

  it("drops the local echo once the prompt comes back from the stream", () => {
    let fold = addEcho(emptyFold(), { localId: "l1", text: "hello  there", turnId: null, disposition: "sending", createdAt: 1 });
    fold = updateEcho(fold, "l1", { turnId: "t1", disposition: "started" });
    assert.equal(fold.echoes[0]?.turnId, "t1");
    fold = applyEvent(fold, {
      method: "item/completed",
      params: { item: { itemId: "u1", kind: "userMessage", status: "completed", revision: 1, turnId: "t1", text: "hello there" } },
    });
    assert.equal(fold.echoes.length, 0);

    let raced = applyEvent(emptyFold(), {
      method: "item/completed",
      params: { item: { itemId: "u2", kind: "userMessage", status: "completed", revision: 1, turnId: "t2", text: "fast" } },
    });
    raced = addEcho(raced, { localId: "l2", text: "fast", turnId: null, disposition: "sending", createdAt: 1 });
    raced = updateEcho(raced, "l2", { turnId: "t2", disposition: "started" });
    assert.equal(raced.echoes.length, 0, "an echo whose prompt already landed is dropped on ack");
  });

  it("clears an acknowledged slash turn's echo even before the shown text arrives", () => {
    let fold = addEcho(emptyFold(), { localId: "l1", text: "/plan tidy", turnId: null, disposition: "sending", createdAt: 1 });
    // The live start carries only the instructions the model got.
    fold = applyEvent(fold, {
      method: "item/started",
      params: { item: { itemId: "u1", kind: "userMessage", status: "inProgress", revision: 1, turnId: "t1", text: "Use skill bundled:plan first" } },
    });
    fold = updateEcho(fold, "l1", { turnId: "t1", disposition: "started" });
    assert.equal(fold.echoes.length, 0, "the acknowledged turn identifies the expanded prompt");
    fold = applyEvent(fold, {
      method: "item/completed",
      params: {
        item: { itemId: "u1", kind: "userMessage", status: "completed", revision: 2, turnId: "t1", text: "Use skill bundled:plan first", displayText: "/plan tidy" },
      },
    });
    assert.equal(fold.echoes.length, 0, "the revision with the shown text clears it");

    let stray = addEcho(emptyFold(), { localId: "l2", text: "typed", turnId: "t2", disposition: "started", createdAt: 1 });
    stray = applyEvent(stray, {
      method: "item/completed",
      params: { item: { itemId: "u2", kind: "userMessage", status: "completed", revision: 1, turnId: "t2", text: "sent" } },
    });
    assert.equal(stray.echoes.length, 0, "the saved prompt replaces its local copy despite rewritten text");
    stray = applyEvent(stray, { method: "turn/completed", params: { turnId: "t2", terminal: "completed" } });
    assert.equal(stray.echoes.length, 0, "a finished turn whose prompt landed needs no local copy");
  });

  it("keeps queued prompts until their turn launches or is reclaimed", () => {
    let fold = addEcho(emptyFold(), { localId: "q1", text: "next", turnId: "t5", disposition: "queued", createdAt: 1 });
    fold = applyEvent(fold, { method: "turn/started", params: { turnId: "t5" } });
    assert.equal(fold.echoes[0]?.disposition, "started");
    fold = addEcho(fold, { localId: "q2", text: "later", turnId: "t6", disposition: "queued", createdAt: 2 });
    fold = applyEvent(fold, { method: "turn/unqueued", params: { turnId: "t6", commandId: "t6" } });
    assert.deepEqual(fold.echoes.map((e) => e.localId), ["q1"]);
  });

  it("builds a fold from a resume load with the server's pending set", () => {
    const requested = liveEvents.findIndex((e) => e.method === "userInput/requested");
    const pendingInput = liveEvents[requested]?.params;
    const fold = foldFromLoad({
      session: null,
      msp: { status: "running", activeTurnId: "t-live", modelId: "m", approvalMode: "denyUnmatched", workspaceRoot: "/w", turnCount: 3 },
      events: historyEvents,
      truncated: false,
      pending: { approvals: [], userInputs: [pendingInput as never] },
      readOnly: false,
      readOnlyReason: null,
    });
    assert.equal(fold.activeTurnId, "t-live");
    assert.equal(Object.keys(fold.userInputs).length, 1);
    assert.equal(fold.meta.approvalMode, "onRequest", "events win over the resume snapshot");
  });

  it("does not show a prompt twice when the thread reloads while it is in flight (#55)", () => {
    const load = (events: ViewEvent[]) => ({
      session: null,
      msp: { status: "running", activeTurnId: "t2", modelId: "m", approvalMode: "onRequest", workspaceRoot: "/w", turnCount: 2 },
      events,
      truncated: false,
      pending: { approvals: [], userInputs: [] },
      readOnly: false,
      readOnlyReason: null,
    });
    const said = (itemId: string, turnId: string, text: string): ViewEvent => ({
      at: 1,
      method: "item/completed",
      params: { item: { itemId, kind: "userMessage", status: "completed", revision: 1, turnId, text } },
    });
    let previous = addEcho(emptyFold(), { localId: "l1", text: "continue", turnId: "t2", disposition: "started", createdAt: 1 });
    previous = addEcho(previous, { localId: "l2", text: "later", turnId: "t3", disposition: "queued", createdAt: 2 });
    previous = addEcho(previous, { localId: "l3", text: "continue", turnId: null, disposition: "sending", createdAt: 3 });

    const fold = foldFromLoad(
      load([
        { at: 1, method: "turn/started", params: { turnId: "t1" } },
        said("u1", "t1", "continue"),
        { at: 1, method: "turn/completed", params: { turnId: "t1", terminal: "completed" } },
        { at: 1, method: "turn/started", params: { turnId: "t2" } },
        said("u2", "t2", "continue"),
      ]),
      previous,
    );
    assert.deepEqual(
      fold.echoes.map((e) => e.localId),
      ["l2", "l3"],
      "the acknowledged echo the history already holds goes; a queued one and an unacknowledged one stay",
    );
    const shown = buildTurns(fold).filter((t) => t.prompt?.text === "continue").length + fold.echoes.filter((e) => e.text === "continue" && e.disposition !== "queued").length;
    assert.equal(shown, 3, "two prompts from history plus the one still being sent, each exactly once");
  });

  it("returns the same fold for an empty batch", () => {
    const fold = emptyFold();
    assert.equal(applyEvents(fold, []), fold);
  });
});

describe("subagent children", () => {
  const child = (i: number): ViewEvent => ({
    at: 1,
    method: "item/completed",
    params: {
      sessionId: "s1",
      item: { itemId: `c${i}`, kind: "reminderChild", status: "completed", revision: 1, turnId: "t1", text: "x".repeat(500) },
    },
  });

  it("are left out of the fold, since nothing ever renders them", () => {
    const fold = foldAll([child(1), child(2), child(3)]);
    assert.deepEqual(Object.keys(fold.items), []);
    assert.deepEqual(fold.order, []);
  });

  it("cost a thread nothing as they pile up", () => {
    // A plan that runs subagents produced tens of thousands of these, and keeping them made every later event in the
    // thread slower until it stopped updating at all (#32).
    let fold = emptyFold();
    const started = Date.now();
    for (let i = 0; i < 20_000; i += 1) {
      fold = applyEvent(fold, child(i));
    }
    assert.deepEqual(fold.order, []);
    assert.ok(Date.now() - started < 2_000, `20k subagent children took ${Date.now() - started}ms`);
  });
});

describe("crew trace", () => {
  const T = Date.UTC(2026, 8, 26, 14, 2, 0);
  const wf = (revision: number, children: unknown[], at?: number, status = "inProgress", extra: Record<string, unknown> = {}): ViewEvent => ({
    method: revision === 1 ? "item/started" : status === "inProgress" ? "item/updated" : "item/completed",
    ...(at !== undefined ? { at } : {}),
    params: { item: { itemId: "wf", kind: "workflow", status, revision, turnId: "t1", children, ...extra } },
  });

  it("stamps each attempt's lifecycle steps the first time they show, from the live event's time", () => {
    const fold = foldAll([
      wf(1, [{ childId: "a", attempt: 1, status: "scheduled", label: "read" }], T),
      wf(2, [{ childId: "a", attempt: 1, status: "started" }], T + 2_000),
      wf(3, [{ childId: "a", attempt: 1, status: "started" }], T + 3_000),
      wf(4, [{ childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 10, outputTokens: 2 } }], T + 60_000),
      wf(5, [{ childId: "a", attempt: 1, status: "completed" }], T + 61_000),
      wf(6, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed", durationMs: 59_000 }], T + 62_000),
    ]);
    const run = fold.crew.runs["wf"];
    assert.ok(run);
    assert.deepEqual(run.children["a:1"], {
      scheduledAt: T, startedAt: T + 2_000, usageAt: T + 60_000, completedAt: T + 61_000, terminalAt: T + 62_000,
      lastEventAt: T + 62_000, usage: { inputTokens: 10, outputTokens: 2 }, label: "read", terminal: "completed", durationMs: 59_000, approx: false,
    });
    assert.equal(run.startedAt, T);
    assert.equal(run.approx, false);
    assert.equal(run.endedAt, null);
    const minute = T / 60_000;
    assert.deepEqual(run.eventMinutes, [minute, minute, minute + 1, minute + 1, minute + 1], "a revision that changes nothing adds no minute");
  });

  it("falls back to the item's record time, and keeps an unchanged attempt's record by identity", () => {
    const recorded = (ms: number) => ({ recordedAt: new Date(ms).toISOString() });
    let fold = foldAll([
      wf(1, [{ childId: "a", attempt: 1, status: "scheduled" }, { childId: "b", attempt: 1, status: "scheduled" }], undefined, "inProgress", recorded(T)),
      wf(2, [{ childId: "a", attempt: 1, status: "started" }, { childId: "b", attempt: 1, status: "scheduled" }], undefined, "inProgress", recorded(T + 5_000)),
    ]);
    const before = fold.crew.runs["wf"]!;
    assert.equal(before.children["a:1"]?.startedAt, T + 5_000);
    assert.equal(before.children["b:1"]?.lastEventAt, T);
    fold = applyEvent(fold, wf(3, [{ childId: "a", attempt: 1, status: "started" }, { childId: "b", attempt: 1, status: "started" }], undefined, "inProgress", recorded(T + 9_000)));
    const after = fold.crew.runs["wf"]!;
    assert.notEqual(after, before, "the trace is copied for the revision");
    assert.equal(after.children["a:1"], before.children["a:1"], "an attempt the revision did not touch keeps its record");
    assert.equal(after.children["b:1"]?.startedAt, T + 9_000);
    assert.equal(before.children["b:1"]?.startedAt, undefined, "the fold on screen is never changed under it");
    const untimed = foldAll([wf(1, [{ childId: "a", attempt: 1, status: "scheduled" }])]);
    assert.deepEqual(untimed.crew.runs["wf"]?.children["a:1"], { lastEventAt: null, approx: false });
    assert.equal(untimed.crew.runs["wf"]?.startedAt, null);
  });

  it("latches the usage Muse sends once, and notes the run's start from revision 1 and its end", () => {
    let fold = foldAll([
      wf(1, [{ childId: "a", attempt: 1, status: "started" }], T),
      wf(2, [{ childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 } }], T + 10_000),
      wf(3, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], T + 11_000),
    ]);
    assert.deepEqual(fold.crew.runs["wf"]?.children["a:1"]?.usage, { inputTokens: 48_333, outputTokens: 4_004, reasoningTokens: 3_409 });
    assert.equal(fold.items["wf"]?.children?.[0]?.usage, undefined, "the item shows what Muse sent last");
    fold = applyEvent(fold, wf(4, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], T + 12_000, "completed"));
    assert.equal(fold.crew.runs["wf"]?.startedAt, T);
    assert.equal(fold.crew.runs["wf"]?.endedAt, T + 12_000);
    assert.equal(fold.crew.runs["wf"]?.children["a:1"]?.lastEventAt, T + 11_000, "the run ending is not the agent moving");
  });

  it("marks a run first seen past revision 1, and a child first seen under way, as approximate", () => {
    const id = "01a0dbae-727a-7543-b502-a584a609ad8b";
    const scheduled = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    const fold = foldAll([wf(22, [{ childId: id, attempt: 1, status: "started" }, { childId: "plain", attempt: 1, status: "terminal", terminal: "completed" }], scheduled + 90_000)]);
    const run = fold.crew.runs["wf"]!;
    assert.equal(run.approx, true);
    assert.equal(run.startedAt, scheduled + 90_000);
    assert.deepEqual(run.children[`${id}:1`], { scheduledAt: scheduled, startedAt: scheduled + 90_000, lastEventAt: scheduled + 90_000, approx: true });
    assert.deepEqual(run.children["plain:1"], { terminalAt: scheduled + 90_000, lastEventAt: scheduled + 90_000, terminal: "completed", approx: true });
    assert.equal(uuidTime(id), scheduled);
    assert.equal(uuidTime("0192f3a1-6b2e-4c40-9a1d-3e5f7b8c9d02"), null, "only version 7 carries a clock");
    assert.equal(uuidTime("plain"), null);
    // A retry shares the id, so its time says nothing about attempt 2.
    const retried = foldAll([wf(30, [{ childId: id, attempt: 2, status: "started" }], scheduled + 200_000)]);
    assert.deepEqual(retried.crew.runs["wf"]?.children[`${id}:2`], { startedAt: scheduled + 200_000, lastEventAt: scheduled + 200_000, approx: true });
  });

  it("keeps an attempt's record after a retry drops it from the item", () => {
    const fold = foldAll([
      wf(1, [{ childId: "a", attempt: 1, status: "scheduled", label: "design:x" }], T),
      wf(2, [{ childId: "a", attempt: 1, status: "terminal", terminal: "failed", durationMs: 5_000 }], T + 5_000),
      wf(3, [{ childId: "a", attempt: 2, status: "scheduled" }], T + 6_000),
    ]);
    assert.deepEqual(Object.keys(fold.crew.runs["wf"]?.children ?? {}), ["a:1", "a:2"]);
    assert.equal(fold.crew.runs["wf"]?.children["a:1"]?.terminal, "failed");
    assert.equal(fold.crew.runs["wf"]?.children["a:1"]?.label, "design:x");
    assert.equal(fold.crew.runs["wf"]?.children["a:2"]?.scheduledAt, T + 6_000);
  });

  it("carries the trace across a partial page and merges a full reload's record times with the live ones", () => {
    const live = foldAll([
      wf(1, [{ childId: "a", attempt: 1, status: "scheduled" }], T),
      wf(2, [{ childId: "a", attempt: 1, status: "started" }], T + 2_000),
      wf(3, [{ childId: "a", attempt: 1, status: "usage", usage: { inputTokens: 5 } }], T + 3_000),
    ]);
    const page = (events: ViewEvent[], partial: boolean): TranscriptLoad => ({
      session: null, msp: null, events, truncated: partial, readOnly: false, readOnlyReason: null,
      pending: { approvals: [], userInputs: [] }, ...(partial ? { historyUnavailable: true } : {}),
    });
    const recorded = (ms: number) => ({ recordedAt: new Date(ms).toISOString() });
    // A partial page that only holds the newest revision keeps everything the live stream traced.
    const partial = foldFromLoad(page([wf(4, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], undefined, "inProgress", recorded(T + 4_500))], true), live);
    assert.deepEqual(partial.crew.runs["wf"]?.children["a:1"], {
      scheduledAt: T, startedAt: T + 2_000, usageAt: T + 3_000, terminalAt: T + 4_500, lastEventAt: T + 4_500, usage: { inputTokens: 5 }, terminal: "completed", approx: false,
    });
    assert.equal(partial.crew.runs["wf"]?.startedAt, T);
    // A full reload replays the history's record times; where the live stream knew better, that stands.
    const full = foldFromLoad(page([
      wf(2, [{ childId: "a", attempt: 1, status: "started" }], undefined, "inProgress", recorded(T + 2_400)),
      wf(3, [{ childId: "a", attempt: 1, status: "usage" }], undefined, "inProgress", recorded(T + 3_400)),
      wf(4, [{ childId: "a", attempt: 1, status: "terminal", terminal: "completed" }], undefined, "inProgress", recorded(T + 4_400)),
    ], false), live);
    const merged = full.crew.runs["wf"]!;
    assert.equal(merged.startedAt, T, "the live start from revision 1 beats a capped page's first revision");
    assert.equal(merged.approx, false);
    assert.equal(merged.children["a:1"]?.scheduledAt, T, "the page never saw the scheduling revision; the live trace did");
    assert.equal(merged.children["a:1"]?.startedAt, T + 2_000, "the earlier of two exact readings");
    assert.deepEqual(merged.children["a:1"]?.usage, { inputTokens: 5 }, "usage the page never carried is kept");
    assert.equal(merged.children["a:1"]?.terminalAt, T + 4_400);
    assert.equal(merged.children["a:1"]?.approx, false);
    // A run the reload no longer holds takes its trace with it.
    const gone = foldFromLoad(page([wf(1, [{ childId: "z", attempt: 1, status: "started" }], undefined, "inProgress", { itemId: "other" })], false), live);
    assert.deepEqual(Object.keys(gone.crew.runs), ["other"]);
  });

  it("traces a tool call while it runs and keeps it only when it ran in the background", () => {
    const tool = (itemId: string, revision: number, status: string, at: number, extra: Record<string, unknown> = {}): ViewEvent => ({
      method: status === "inProgress" ? (revision === 1 ? "item/started" : "item/updated") : "item/completed", at,
      params: { item: { itemId, kind: "toolCall", status, revision, tool: "bash", args: JSON.stringify({ command: "npm test" }), ...extra } },
    });
    let fold = foldAll([tool("t1", 1, "inProgress", T), tool("t2", 1, "inProgress", T + 1_000)]);
    assert.deepEqual(fold.crew.tasks["t1"], { firstSeenAt: T, approx: false, lastOutputAt: null, endedAt: null });
    fold = applyEvents(fold, [
      { method: "item/delta", at: T + 30_000, params: { itemId: "t1", field: "output", delta: "12 passed\n" } },
      { method: "item/delta", params: { itemId: "t2", field: "output", delta: "no time on this one\n" } },
      tool("t1", 2, "inProgress", T + 40_000, { background: true, backgroundInitiator: "user" }),
    ]);
    assert.equal(fold.crew.tasks["t1"]?.lastOutputAt, T + 30_000);
    assert.equal(fold.crew.tasks["t1"]?.firstSeenAt, T, "backgrounding it later does not move its start");
    assert.equal(fold.crew.tasks["t2"]?.lastOutputAt, null);
    fold = applyEvents(fold, [tool("t1", 3, "completed", T + 90_000, { background: true }), tool("t2", 2, "completed", T + 91_000)]);
    assert.equal(fold.crew.tasks["t1"]?.endedAt, T + 90_000);
    assert.equal(fold.crew.tasks["t2"], undefined, "an ordinary call that finished needs no trace");
    // A history page without event times reads the start off the UUIDv7 item id.
    const id = "01a0f3c4-6d2e-7b1a-8c3f-5e9d2a7b4c10";
    const paged = foldAll([{ method: "item/updated", params: { item: { itemId: id, kind: "toolCall", status: "inProgress", revision: 1, background: true } } }]);
    assert.deepEqual(paged.crew.tasks[id], { firstSeenAt: uuidTime(id), approx: true, lastOutputAt: null, endedAt: null });
  });

  it("notes when a request was raised and when it was answered", () => {
    let fold = foldAll([
      { method: "approval/requested", at: T, params: { approvalId: "ap1", itemId: "tool-1", sessionId: "s" } },
      { method: "approval/updated", at: T + 500, params: { approvalId: "ap1", itemId: "tool-1", sessionId: "s" } },
      { method: "userInput/requested", at: T + 1_000, params: { userInputId: "q1", questions: [] } },
      { method: "approval/requested", params: { approvalId: "ap2", sessionId: "s" } },
    ]);
    assert.deepEqual(fold.crew.requests, {
      ap1: { kind: "approval", itemId: "tool-1", askedAt: T, decidedAt: null },
      q1: { kind: "input", itemId: null, askedAt: T + 1_000, decidedAt: null },
      ap2: { kind: "approval", itemId: null, askedAt: null, decidedAt: null },
    });
    fold = applyEvents(fold, [
      { method: "approval/resolved", at: T + 100_000, params: { approvalId: "ap1", decision: "approved", resolvedBy: "user" } },
      { method: "userInput/settled", at: T + 120_000, params: { userInputId: "q1", outcome: "answered", answers: [] } },
    ]);
    assert.equal(fold.crew.requests["ap1"]?.decidedAt, T + 100_000);
    assert.equal(fold.crew.requests["q1"]?.decidedAt, T + 120_000);
    assert.equal(fold.crew.requests["ap2"]?.decidedAt, null);
  });
});
