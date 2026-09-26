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
