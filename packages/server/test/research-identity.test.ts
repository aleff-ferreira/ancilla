/**
 * Execution identity of a research turn: a control call gets a session of its own, a start acknowledgement that
 * lands after the turn was given up on is cancelled by id, and text that merely mentions "cancel" is not a
 * cancellation. Every scenario runs on scripted connections and a fake clock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResearchFailure, type ExecResult } from "@ancilla/daemon";
import { TURN_HARD_DEADLINE_SLACK_MS, classifyExecFailure, failureKindOf } from "../src/research/index.js";
import { waitFor } from "./harness.js";
import { BUDGETS, TASK, controlRig, deliverAnswer, modelRequest, noSink, sleep, workerRig } from "./research-rigs.js";

/** The hard deadline of a 60 s turn in a rig with a 30 s cancel grace: wall time, grace and slack. */
const PAST_HARD_DEADLINE = 60_000 + 30_000 + TURN_HARD_DEADLINE_SLACK_MS;

/** Collects unhandled rejections for the length of one test; Node 22 would end the process on one. */
async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    await run();
    await sleep(30);
    assert.deepEqual(seen, [], "no rejection escaped");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

describe("control calls never share a session", () => {
  /**
   * Call A never hears its start acknowledgement and is given up on at the hard deadline. Call B then starts, and
   * before B's own acknowledgement arrives the host delivers A's late terminal on A's session.
   */
  async function staleTerminalScenario(terminal: string): Promise<{ text: string | null; error: ResearchFailure | null; sessionStarts: number }> {
    const { connection, client, clock } = controlRig();
    let turns = 0;
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      turns += 1;
      if (turns === 1) {
        return new Promise(() => undefined);
      }
      // A's late output, on the session A used, before B's acknowledgement is returned.
      deliverAnswer(connection, "ctl-1", "tA", "ANSWER-TO-A", terminal);
      const sessionId = params["sessionId"] as string;
      setTimeout(() => deliverAnswer(connection, sessionId, "tB", "ANSWER-TO-B"), 5);
      return { turnId: "tB", status: "accepted" };
    });
    const first = client.complete(modelRequest("supervisor", "A?", new AbortController().signal, 60_000));
    const firstSettled = first.catch(() => undefined);
    await waitFor(() => connection.of("turn/start").length === 1, "A's turn start", 1000);
    clock.advance(PAST_HARD_DEADLINE);
    await assert.rejects(first, (error: ResearchFailure) => error.kind === "timeout");
    await firstSettled;
    try {
      const second = await client.complete(modelRequest("supervisor", "B?", new AbortController().signal, 60_000));
      return { text: second.text, error: null, sessionStarts: connection.of("session/start").length };
    } catch (error) {
      return { text: null, error: error as ResearchFailure, sessionStarts: connection.of("session/start").length };
    }
  }

  it("does not let an earlier call's late output complete the next call", async () => {
    const result = await staleTerminalScenario("completed");
    assert.equal(result.error, null);
    assert.equal(result.text, "ANSWER-TO-B");
    assert.equal(result.sessionStarts, 2, "each call opened its own session");
  });

  it("does not let an earlier call's late cancelled terminal cancel the next call", async () => {
    const result = await staleTerminalScenario("cancelled");
    assert.equal(result.error, null, `B failed with ${result.error?.kind}: ${result.error?.message}`);
    assert.equal(result.text, "ANSWER-TO-B");
  });

  it("starts a new session for every call, so the supervisor and the writer never share one", async () => {
    const { connection, client, starts } = controlRig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      const turnId = `t-${sessionId}`;
      setTimeout(() => deliverAnswer(connection, sessionId, turnId, `answer from ${sessionId}`), 5);
      return { turnId, status: "accepted" };
    });
    const supervisor = await client.complete(modelRequest("supervisor"));
    const writer = await client.complete(modelRequest("writer"));
    const supervisorAgain = await client.complete(modelRequest("supervisor"));
    assert.deepEqual([supervisor.text, writer.text, supervisorAgain.text], ["answer from ctl-1", "answer from ctl-2", "answer from ctl-3"]);
    assert.equal(starts.length, 3);
    const turns = connection.of("turn/start").map((c) => c.params?.["sessionId"]);
    assert.deepEqual(turns, ["ctl-1", "ctl-2", "ctl-3"]);
  });

  it("ends a call whose session closes, and the next call opens a new session", async () => {
    const { connection, client } = controlRig();
    let turns = 0;
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      turns += 1;
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        if (turns === 1) {
          connection.notify("session/closed", { sessionId, reason: "hostShutdown" });
        } else {
          deliverAnswer(connection, sessionId, "t2", "after the close");
        }
      }, 5);
      return { turnId: `t${turns}`, status: "accepted" };
    });
    await assert.rejects(client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "unavailable" && /session closed/.test(error.message));
    const next = await client.complete(modelRequest("supervisor"));
    assert.equal(next.text, "after the close");
    assert.equal(connection.of("session/start").length, 2);
    assert.equal(connection.of("turn/start")[1]?.params?.["sessionId"], "ctl-2");
  });
});

describe("a start acknowledgement that arrives after the turn was given up on", () => {
  it("cancels the control turn by id", async () => {
    const { connection, client, clock } = controlRig();
    let acknowledge: (ack: unknown) => void = () => undefined;
    connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
    const pending = client.complete(modelRequest("supervisor", "x", new AbortController().signal, 60_000));
    await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
    clock.advance(PAST_HARD_DEADLINE);
    await assert.rejects(pending, (error: ResearchFailure) => error.kind === "timeout");
    assert.equal(connection.of("turn/cancel").length, 0, "nothing to cancel by id before the acknowledgement");
    acknowledge({ turnId: "late-1", status: "accepted" });
    await waitFor(() => connection.of("turn/cancel").length === 1, "the late cancel", 1000);
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "ctl-1", turnId: "late-1" });
    assert.equal(connection.of("turn/unqueue").length, 0);
    assert.equal(clock.timers.length, 0, "the late acknowledgement arms no timer");
  });

  it("cancels the worker turn by id", async () => {
    const { connection, runner, clock } = workerRig({ cancelGraceMs: 30_000 });
    let acknowledge: (ack: unknown) => void = () => undefined;
    connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
    const pending = runner.run(TASK, { ...BUDGETS, wallTimeMs: 60_000 }, new AbortController().signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
    clock.advance(PAST_HARD_DEADLINE);
    const result = await pending;
    assert.equal(result.status, "timed_out");
    acknowledge({ turnId: "late-w", status: "accepted" });
    await waitFor(() => connection.of("turn/cancel").length === 1, "the late cancel", 1000);
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "w1", turnId: "late-w" });
    assert.equal(clock.timers.length, 0);
  });

  it("unqueues a turn the host queued", async () => {
    const { connection, client, clock } = controlRig();
    let acknowledge: (ack: unknown) => void = () => undefined;
    connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
    const pending = client.complete(modelRequest("supervisor", "x", new AbortController().signal, 60_000));
    await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
    clock.advance(PAST_HARD_DEADLINE);
    await assert.rejects(pending);
    acknowledge({ turnId: "late-q", status: "accepted", disposition: "queued" });
    await waitFor(() => connection.of("turn/unqueue").length === 1, "the unqueue", 1000);
    assert.deepEqual(connection.of("turn/unqueue")[0]?.params, { sessionId: "ctl-1", turnId: "late-q" });
    assert.equal(connection.of("turn/cancel").length, 0, "a queued turn is unqueued, not cancelled");
  });

  it("sends nothing when the whole turn arrived before the acknowledgement", async () => {
    const { connection, client, clock } = controlRig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      deliverAnswer(connection, params["sessionId"] as string, "t-fast", "Instant answer.");
      return new Promise((resolve) => setTimeout(() => resolve({ turnId: "t-fast", status: "accepted" }), 30));
    });
    const response = await client.complete(modelRequest("supervisor"));
    assert.equal(response.text, "Instant answer.");
    await sleep(60);
    assert.equal(connection.of("turn/cancel").length, 0);
    assert.equal(connection.of("turn/unqueue").length, 0);
    assert.equal(connection.of("turn/interrupt").length, 0);
    assert.equal(clock.timers.length, 0);
  });

  it("swallows a cancel the host rejects, and an unqueue too", async () => {
    await withoutUnhandledRejections(async () => {
      for (const disposition of [undefined, "queued"]) {
        const { connection, client, clock, logs } = controlRig();
        let acknowledge: (ack: unknown) => void = () => undefined;
        connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
        connection.replies.set("turn/cancel", new Error("the host refused the cancel"));
        connection.replies.set("turn/unqueue", new Error("the host refused the unqueue"));
        const pending = client.complete(modelRequest("supervisor", "x", new AbortController().signal, 60_000));
        await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
        clock.advance(PAST_HARD_DEADLINE);
        await assert.rejects(pending);
        acknowledge({ turnId: "late-r", status: "accepted", ...(disposition ? { disposition } : {}) });
        const method = disposition ? "turn/unqueue" : "turn/cancel";
        await waitFor(() => connection.of(method).length === 1, `the late ${method}`, 1000);
        await waitFor(() => logs.some((line) => /cancel failed|unqueue failed/.test(line)), "the failure is logged", 1000);
      }
    });
  });
});

describe("a start acknowledgement that arrives after a stop or a shutdown", () => {
  it("cancels by id once, when Stop came while the start was unanswered and the grace period ran out", async () => {
    const { connection, client, clock } = controlRig();
    let acknowledge: (ack: unknown) => void = () => undefined;
    connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
    const controller = new AbortController();
    const pending = client.complete(modelRequest("supervisor", "x", controller.signal, 60_000));
    const settled = pending.then(
      () => null,
      (error: ResearchFailure) => error,
    );
    await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
    controller.abort({ type: "stop", writeReport: false });
    await waitFor(() => connection.of("turn/interrupt").length === 1, "the interrupt without a turn id", 1000);
    assert.equal(connection.of("turn/cancel").length, 0, "no turn id to cancel yet");
    clock.advance(30_000);
    const error = await settled;
    assert.equal(error?.kind, "cancelled");
    assert.equal(connection.of("turn/cancel").length, 0, "still nothing to cancel by id before the acknowledgement");
    acknowledge({ turnId: "late-stop", status: "accepted" });
    await waitFor(() => connection.of("turn/cancel").length === 1, "the late cancel", 1000);
    await sleep(30);
    assert.equal(connection.of("turn/cancel").length, 1, "exactly one cancel");
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "ctl-1", turnId: "late-stop" });
    assert.equal(clock.timers.length, 0);
  });

  it("cancels by id at once on a shutdown, without waiting out the grace period", async () => {
    const { connection, client, clock } = controlRig();
    let acknowledge: (ack: unknown) => void = () => undefined;
    connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
    const controller = new AbortController();
    const pending = client.complete(modelRequest("supervisor", "x", controller.signal, 60_000));
    const settled = pending.then(
      () => null,
      (error: ResearchFailure) => error,
    );
    await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
    controller.abort({ type: "shutdown" });
    const error = await settled;
    assert.equal(error?.kind, "cancelled", "the shutdown ends the call without the clock moving");
    acknowledge({ turnId: "late-shutdown", status: "accepted" });
    await waitFor(() => connection.of("turn/cancel").length === 1, "the late cancel", 1000);
    await sleep(30);
    assert.equal(connection.of("turn/cancel").length, 1);
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "ctl-1", turnId: "late-shutdown" });
    assert.equal(clock.timers.length, 0);
  });

  it("cancels a worker turn by id after a stop that gave up on the host", async () => {
    const { connection, runner, clock } = workerRig({ cancelGraceMs: 30_000 });
    let acknowledge: (ack: unknown) => void = () => undefined;
    connection.replies.set("turn/start", () => new Promise((resolve) => (acknowledge = resolve)));
    const controller = new AbortController();
    const pending = runner.run(TASK, { ...BUDGETS, wallTimeMs: 60_000 }, controller.signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start", 1000);
    controller.abort({ type: "shutdown" });
    const result = await pending;
    assert.equal(result.status, "cancelled");
    acknowledge({ turnId: "late-w-stop", status: "accepted" });
    await waitFor(() => connection.of("turn/cancel").length === 1, "the late cancel", 1000);
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "w1", turnId: "late-w-stop" });
  });
});

describe("a session that opens after its call gave up", () => {
  it("is named in the log as idle, and nothing runs in it", async () => {
    let open: (session: { sessionId: string; manager: never }) => void = () => undefined;
    const { connection, client, clock, logs, manager } = controlRig({
      startupMs: 10_000,
      start: () => new Promise((resolve) => (open = resolve as typeof open)),
    });
    const pending = client.complete(modelRequest("writer", "x", new AbortController().signal, 60_000));
    const settled = pending.then(
      () => null,
      (error: ResearchFailure) => error,
    );
    await waitFor(() => clock.timers.length === 1, "the startup allowance armed", 1000);
    clock.advance(10_000);
    const error = await settled;
    assert.equal(error?.kind, "unavailable");
    open({ sessionId: "ctl-straggler", manager: manager as never });
    await waitFor(() => logs.some((line) => /ctl-straggler.*opened after the call gave up/.test(line)), "the straggler to be logged", 1000);
    assert.equal(connection.of("turn/start").length, 0, "no turn was started in the session that came too late");
  });
});

describe("text that mentions cancel is not a cancellation", () => {
  it("keeps a failed control turn that says 'context canceled' non-fatal", async () => {
    const { connection, client } = controlRig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => connection.notify("turn/completed", { sessionId, turnId: "t1", terminal: "failed", error: { message: "rpc error: context canceled" } }), 5);
      return { turnId: "t1", status: "accepted" };
    });
    await assert.rejects(client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind !== "cancelled" && !error.fatal && /context canceled/.test(error.message));
  });

  it("keeps a control turn whose start was refused with 'operation cancelled' non-fatal", async () => {
    const { connection, client } = controlRig();
    connection.replies.set("turn/start", new Error("operation cancelled by the host"));
    await assert.rejects(client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "unavailable" && !error.fatal);
  });

  it("keeps a control session start that failed with 'cancelled' non-fatal", async () => {
    const { client } = controlRig({ start: async () => Promise.reject(new Error("request cancelled before the session existed")) });
    await assert.rejects(client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "unavailable" && !error.fatal);
  });

  it("keeps a failed worker turn that says 'context canceled' a plain failure", async () => {
    const { connection, runner } = workerRig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "failed", error: { message: "context canceled" } }), 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.error ?? "", /^cancelled:/);
  });

  it("keeps a worker session start that failed with 'cancelled' a plain unavailable failure", async () => {
    const { runner } = workerRig({ start: async () => Promise.reject(new Error("the request was cancelled")) });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /^unavailable: could not start a worker session/);
  });

  it("still reports a terminal that itself says cancelled as cancelled", async () => {
    const { connection, client } = controlRig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => connection.notify("turn/completed", { sessionId, turnId: "t1", terminal: "cancelled" }), 5);
      return { turnId: "t1", status: "accepted" };
    });
    await assert.rejects(client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "cancelled");
  });
});

describe("failure kinds read off text", () => {
  it("never reads a cancellation out of free text", () => {
    assert.equal(failureKindOf("context canceled"), "other");
    assert.equal(failureKindOf("operation cancelled"), "other");
    assert.equal(failureKindOf("the request was cancelled by the peer"), "other");
  });

  it("checks rate limits before quota, so a 429 about a quota is a rate limit", () => {
    assert.equal(failureKindOf("429 Too Many Requests: per-minute quota exceeded"), "rate_limited");
    assert.equal(failureKindOf("rate limit reached for this quota window"), "rate_limited");
  });

  it("narrows quota to the words that mean it", () => {
    assert.equal(failureKindOf("Insufficient context window"), "other");
    assert.equal(failureKindOf("insufficient credits"), "quota");
    assert.equal(failureKindOf("quota exhausted"), "quota");
    assert.equal(failureKindOf("402 payment required"), "quota");
    assert.equal(failureKindOf("insufficient quota for this model"), "quota");
  });

  it("keeps the other kinds as they were", () => {
    assert.equal(failureKindOf("Error: 401 Unauthorized"), "auth");
    assert.equal(failureKindOf("not logged in"), "auth");
    assert.equal(failureKindOf("the request timed out"), "timeout");
    assert.equal(failureKindOf("connection refused"), "unavailable");
    assert.equal(failureKindOf("something odd"), "other");
  });

  it("reads exec failures the same way", () => {
    const failing = (stderr: string): ExecResult => ({ stdout: "", stderr, exitCode: 1 });
    assert.equal(classifyExecFailure(failing("HTTP 429: per-minute quota exceeded")).kind, "rate_limited");
    assert.equal(classifyExecFailure(failing("Insufficient context window")).kind, "unavailable");
    assert.equal(classifyExecFailure(failing("context canceled")).kind, "unavailable");
    assert.equal(classifyExecFailure(failing("insufficient credits")).kind, "quota");
    assert.equal(classifyExecFailure(failing("402 payment required: quota exceeded")).kind, "quota");
    assert.equal(classifyExecFailure({ stdout: "", exitCode: 1, aborted: true }).kind, "cancelled");
  });
});
