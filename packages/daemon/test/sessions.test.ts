import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SessionManager,
  isApprovalMode,
  isGoalAction,
  isSubagentAction,
  isWorkflowChildAction,
  parseSubscriptionUsage,
  textInput,
  turnInput,
  type CommandConnection,
} from "../src/sessions.js";

class StubRpcBridge implements CommandConnection {
  readonly recordedInvocations: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly programmedResponses = new Map<string, unknown>();

  setResponse(verb: string, data: unknown): void {
    this.programmedResponses.set(verb, data);
  }

  async command(verb: string, payload?: Record<string, unknown>): Promise<unknown> {
    this.recordedInvocations.push({ method: verb, params: payload });
    if (this.programmedResponses.has(verb)) {
      return this.programmedResponses.get(verb);
    }
    return { ok: true };
  }

  onNotification(): void {}
}

function fetchLatestCall(bridge: StubRpcBridge) {
  const latest = bridge.recordedInvocations[bridge.recordedInvocations.length - 1];
  assert.ok(latest, "Expected at least one recorded RPC invocation");
  return latest;
}

describe("SessionManager", () => {
  it("dispatches shell commands and performs session branching via fork", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.userShell("session-alpha", "git status");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "session/userShell",
      params: { sessionId: "session-alpha", commandText: "git status" },
    });

    bridge.setResponse("session/fork", {
      session: { sessionId: "session-beta", forkedFrom: { sessionId: "session-alpha" } },
    });
    const branched = await manager.forkSession("session-alpha");
    assert.strictEqual(branched.sessionId, "session-beta");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "session/fork",
      params: { sessionId: "session-alpha", excludeItems: true },
    });
  });

  it("queries session collections filtered by workspace directory", async () => {
    const bridge = new StubRpcBridge();
    bridge.setResponse("session/list", {
      sessions: [{ session: { sessionId: "sess-100" } }],
    });
    const manager = new SessionManager(bridge);

    const results = await manager.listSessions("/home/user/workspace", 25);
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "session/list",
      params: { limit: 25, workspaceRoot: "/home/user/workspace" },
    });
    assert.strictEqual(results.length, 1);
  });

  it("returns an empty collection when session listing payload is malformed", async () => {
    const bridge = new StubRpcBridge();
    bridge.setResponse("session/list", { invalidShape: true });
    const manager = new SessionManager(bridge);
    assert.deepStrictEqual(await manager.listSessions(), []);
  });

  it("encodes prompt text alongside multiple image payload structures", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.sendTurn("sess-1", "analyze diagram", {
      images: [
        { base64Data: "iVBORw0KGgo=", mediaType: "image/png", width: 64, height: 48 },
        { base64Data: "dHJ1ZQ==", mediaType: "image/jpeg" },
      ],
    });

    assert.deepStrictEqual(fetchLatestCall(bridge).params?.["input"], [
      { type: "text", text: "analyze diagram" },
      { type: "image", base64Data: "iVBORw0KGgo=", mediaType: "image/png", width: 64, height: 48 },
      { type: "image", base64Data: "dHJ1ZQ==", mediaType: "image/jpeg" },
    ]);

    await manager.sendTurn("sess-1", "", {
      images: [{ base64Data: "cG5n", mediaType: "image/png" }],
    });
    assert.deepStrictEqual(fetchLatestCall(bridge).params?.["input"], [
      { type: "image", base64Data: "cG5n", mediaType: "image/png" },
    ]);

    assert.deepStrictEqual(turnInput("standard prompt"), [{ type: "text", text: "standard prompt" }]);
  });

  it("initiates new sessions and enforces valid returned session identifiers", async () => {
    const bridge = new StubRpcBridge();
    bridge.setResponse("session/start", { session: { sessionId: "init-id-123" } });
    const manager = new SessionManager(bridge);

    const sessionAck = await manager.startSession({
      workspaceRoot: "/project/dir",
      approvalMode: "onRequest",
      modelId: "muse-spark-1.3",
    });

    assert.strictEqual(sessionAck.sessionId, "init-id-123");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      workspaceRoot: "/project/dir",
      approvalMode: "onRequest",
      modelId: "muse-spark-1.3",
    });

    bridge.setResponse("session/start", { session: {} });
    await assert.rejects(() => manager.startSession({}), { message: /sessionId/ });
  });

  it("handles conversational turn operations across lifecycle states", async () => {
    const bridge = new StubRpcBridge();
    bridge.setResponse("turn/start", { status: "accepted", turnId: "turn-9", disposition: "started" });
    const manager = new SessionManager(bridge);

    const turnResult = await manager.sendTurn("sess-x", "run build", { ifBusy: "queue" });
    assert.strictEqual(turnResult.turnId, "turn-9");
    assert.strictEqual(turnResult.status, "accepted");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "sess-x",
      input: textInput("run build"),
      ifBusy: "queue",
    });

    await manager.steerTurn("sess-x", "turn-9", "stop and test instead");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "turn/steer",
      params: { sessionId: "sess-x", expectedTurnId: "turn-9", input: textInput("stop and test instead") },
    });

    await manager.interruptTurn("sess-x", "turn-9", true);
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "sess-x",
      turnId: "turn-9",
      retract: true,
    });

    await manager.cancelTurn("sess-x", "turn-9");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "sess-x",
      turnId: "turn-9",
    });

    await manager.unqueueTurn("sess-x", "turn-10");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "turn/unqueue",
      params: { sessionId: "sess-x", turnId: "turn-10" },
    });
  });

  it("submits approval decisions retaining structured requirement tracking", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.decideApproval({
      sessionId: "sess-a",
      approvalId: "appr-1",
      requirementId: { approvalId: "appr-1", sourceIndex: 0 },
      choiceId: "allow_once",
      feedback: null,
    });

    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "approval/decide",
      params: {
        sessionId: "sess-a",
        approvalId: "appr-1",
        requirementId: { approvalId: "appr-1", sourceIndex: 0 },
        choiceId: "allow_once",
        feedback: null,
      },
    });
  });

  it("manages session reads, model changes, and user input interactions", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.resumeSession("s-1");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, { sessionId: "s-1", excludeItems: false });

    await manager.readSession("s-1");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, { sessionId: "s-1", excludeItems: true });

    await manager.listModels("s-1");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, { sessionId: "s-1" });

    await manager.setSessionModel("s-1", { modelId: "muse-spark-1.3" });
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "s-1",
      model: { modelId: "muse-spark-1.3" },
    });

    await manager.setSessionApprovalMode("s-1", "denyUnmatched");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, { sessionId: "s-1", mode: "denyUnmatched" });

    await manager.answerUserInput("s-1", "input-4", [{ questionId: "q-1", freeText: "approved" }]);
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "s-1",
      userInputId: "input-4",
      answers: [{ questionId: "q-1", freeText: "approved" }],
    });
  });

  it("routes read queries via connection.request when supported by transport", async () => {
    const bridge = new StubRpcBridge();
    const issuedQueries: Array<{ method: string; params?: Record<string, unknown> }> = [];

    const requestCapableBridge: CommandConnection = {
      command: (verb, params) => bridge.command(verb, params),
      request: async (verb, params) => {
        issuedQueries.push({ method: verb, params });
        if (verb === "view/page") {
          return { events: [{ method: "turn/started", params: {} }], nextCursor: "page-cursor-2" };
        }
        if (verb === "approval/listPending") {
          return { approvals: [{ approvalId: "appr-5" }], userInputs: [] };
        }
        return { sessions: [], nextCursor: null };
      },
      onNotification: () => {},
    };

    const manager = new SessionManager(requestCapableBridge);
    await manager.listSessions();

    const viewPage = await manager.pageView("s-99", { direction: "backward", limit: 10 });
    assert.strictEqual(viewPage.nextCursor, "page-cursor-2");
    assert.strictEqual(viewPage.events.length, 1);

    const pending = await manager.listPending("s-99");
    assert.strictEqual(pending.approvals.length, 1);

    assert.deepStrictEqual(
      issuedQueries.map((q) => q.method),
      ["session/list", "view/page", "approval/listPending"],
    );
    assert.deepStrictEqual(issuedQueries[1]?.params, { sessionId: "s-99", limit: 10, direction: "backward" });
    assert.strictEqual(bridge.recordedInvocations.length, 0);
  });

  it("processes cancellation and clarification of interactive questions", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.cancelUserInput("s-1", "input-9", "dismissed");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "userInput/cancel",
      params: { sessionId: "s-1", userInputId: "input-9", reason: "dismissed" },
    });

    await manager.clarifyUserInput("s-1", "input-9", "Only modify test fixtures");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "s-1",
      userInputId: "input-9",
      clarification: { format: "text", content: "Only modify test fixtures" },
    });
  });

  it("updates reasoning effort settings and performs session renaming", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.setReasoningEffort("s-1", "low");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "session/setReasoningEffort",
      params: { sessionId: "s-1", reasoningEffort: "low" },
    });

    bridge.setResponse("session/rename", { commandId: "cmd-r", status: "accepted", name: "feature-branch" });
    const resultingName = await manager.renameSession("s-1", "feature-branch");
    assert.strictEqual(resultingName, "feature-branch");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "session/rename",
      params: { sessionId: "s-1", name: "feature-branch" },
    });
  });

  it("manages autonomous goals and verifies objective presence requirements", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    bridge.setResponse("goal/set", { commandId: "g-1", status: "accepted", turnId: "turn-goal-1" });
    assert.deepStrictEqual(await manager.goal("s-1", "set", "  stabilize harnesses  "), { turnId: "turn-goal-1" });
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "goal/set",
      params: { sessionId: "s-1", objective: "stabilize harnesses" },
    });

    await manager.goal("s-1", "edit", "deploy updates");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, { sessionId: "s-1", objective: "deploy updates" });

    for (const action of ["pause", "resume", "clear"] as const) {
      assert.deepStrictEqual(await manager.goal("s-1", action, "dropped-arg"), { turnId: null });
      assert.deepStrictEqual(fetchLatestCall(bridge), { method: `goal/${action}`, params: { sessionId: "s-1" } });
    }

    await assert.rejects(() => manager.goal("s-1", "set", "   "), { message: /objective/ });
    assert.strictEqual(isGoalAction("pause"), true);
    assert.strictEqual(isGoalAction("terminate"), false);
  });

  it("manages subagent delegation, background tasks, and pipeline workflows", async () => {
    const bridge = new StubRpcBridge();
    const manager = new SessionManager(bridge);

    await manager.subagent("s-1", "stop", "agent-3", { reason: "unneeded branch" });
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "subagent/stop",
      params: { sessionId: "s-1", subagentId: "agent-3", reason: "unneeded branch" },
    });

    await manager.subagent("s-1", "sendMessage", "agent-3", { body: " verify build outputs " });
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "s-1",
      subagentId: "agent-3",
      body: "verify build outputs",
    });

    await manager.subagent("s-1", "reopen", "agent-3", { reason: "ignored", body: "ignored" });
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "subagent/reopen",
      params: { sessionId: "s-1", subagentId: "agent-3" },
    });

    await assert.rejects(() => manager.subagent("s-1", "followupTask", "agent-3", { body: "" }), { message: /message/ });
    assert.strictEqual(isSubagentAction("interrupt"), true);
    assert.strictEqual(isSubagentAction("terminate"), false);

    await manager.backgroundTask("s-1", "item-99");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "task/background",
      params: { sessionId: "s-1", taskId: "item-99" },
    });

    await manager.stopTask("s-1", "item-99");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "task/stop",
      params: { sessionId: "s-1", taskId: "item-99" },
    });

    await manager.stopAllTasks("s-1");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "task/stopAll",
      params: { sessionId: "s-1" },
    });

    await manager.cancelWorkflow("s-1", "workflow-run-8");
    assert.deepStrictEqual(fetchLatestCall(bridge), {
      method: "workflow/cancel",
      params: { sessionId: "s-1", workflowRunId: "workflow-run-8" },
    });

    await manager.controlWorkflowChild("s-1", "workflow-run-8", "node-b", 1, "retry");
    assert.deepStrictEqual(fetchLatestCall(bridge).params, {
      sessionId: "s-1",
      workflowRunId: "workflow-run-8",
      childId: "node-b",
      attempt: 1,
      action: "retry",
    });

    assert.strictEqual(isWorkflowChildAction("skip"), true);
    assert.strictEqual(isWorkflowChildAction("reboot"), false);
  });

  it("retrieves usage stats, registered skills, and chunked output logs via read queries", async () => {
    const bridge = new StubRpcBridge();
    const queryHistory: Array<{ method: string; params?: Record<string, unknown> }> = [];

    const mockUsageData = {
      tier: "high",
      observedAtMs: 1_700_000_000_000,
      window: { usedPercent: 42, resetsAtMs: 1_700_000_900_000, windowDurationMins: 300 },
      weekly: { usedPercent: 18, resetsAtMs: 1_700_400_000_000 },
    };

    const mockResponses: Record<string, unknown> = {
      "usage/read": { usage: mockUsageData },
      "skill/list": {
        skills: [
          { selector: "doctor", displayName: "Doctor", description: "Verifies configuration", source: "bundled" },
          { selector: "plugin:sync", displayName: "sync", description: "", source: "plugin", pluginId: "sync-tool", argumentHint: "<target>" },
          { displayName: "selector-missing" },
        ],
      },
      "item/readOutput": {
        content: "buffered line\n",
        encoding: "utf8",
        mediaType: "text/plain",
        offsetBytes: 0,
        byteLen: 14,
        eof: true,
      },
    };

    const queryBridge: CommandConnection = {
      command: (verb, params) => bridge.command(verb, params),
      request: async (verb, params) => {
        queryHistory.push({ method: verb, params });
        return mockResponses[verb];
      },
      onNotification: () => {},
    };

    const manager = new SessionManager(queryBridge);
    assert.deepStrictEqual(await manager.readSubscriptionUsage(), {
      ...mockUsageData,
      weekly: { ...mockUsageData.weekly, windowDurationMins: null },
    });

    mockResponses["usage/read"] = {};
    assert.strictEqual(await manager.readSubscriptionUsage(), null);

    const activeSkills = await manager.listSessionSkills("s-1");
    assert.deepStrictEqual(activeSkills.map((s) => s.selector), ["doctor", "plugin:sync"]);
    assert.deepStrictEqual(activeSkills[1], {
      selector: "plugin:sync",
      displayName: "sync",
      description: "",
      source: "plugin",
      argumentHint: "<target>",
      pluginId: "sync-tool",
    });

    const chunk = await manager.readItemOutput("s-1", "item-55", "ref-out", { offsetBytes: 0, lengthBytes: 2048 });
    assert.strictEqual(chunk.eof, true);
    assert.strictEqual(chunk.content, "buffered line\n");

    assert.deepStrictEqual(
      queryHistory.map((q) => q.method),
      ["usage/read", "usage/read", "skill/list", "item/readOutput"],
    );
    assert.deepStrictEqual(queryHistory[3]?.params, {
      sessionId: "s-1",
      itemId: "item-55",
      outputRef: "ref-out",
      offsetBytes: 0,
      lengthBytes: 2048,
    });
    assert.strictEqual(bridge.recordedInvocations.length, 0);
  });

  it("accepts only structurally complete subscription usage objects", () => {
    assert.strictEqual(parseSubscriptionUsage(null), null);
    assert.strictEqual(parseSubscriptionUsage({ tier: "dev", observedAtMs: 1, window: { usedPercent: 10 } }), null);
    assert.strictEqual(
      parseSubscriptionUsage({
        observedAtMs: 5,
        window: { usedPercent: 3, resetsAtMs: 9, windowDurationMins: 300 },
        weekly: { usedPercent: 1, resetsAtMs: 10 },
      })?.tier,
      "unknown",
    );
  });

  it("rejects non-finite subscription observations and preserves over-quota values", () => {
    const usage = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 135, resetsAtMs: 300, windowDurationMins: 300 },
      weekly: { usedPercent: 40, resetsAtMs: 900 } };
    assert.equal(parseSubscriptionUsage(usage)?.window.usedPercent, 135);
    assert.equal(parseSubscriptionUsage({ ...usage, observedAtMs: NaN }), null);
    assert.equal(parseSubscriptionUsage({ ...usage, window: { ...usage.window, usedPercent: Infinity } }), null);
    assert.equal(parseSubscriptionUsage({ ...usage, weekly: { ...usage.weekly, resetsAtMs: 1e20 } }), null);
    assert.equal(parseSubscriptionUsage({ ...usage, window: { ...usage.window, windowDurationMins: -1 } })?.window.windowDurationMins, null);
  });

  it("validates the closed approval mode set", () => {
    assert.strictEqual(isApprovalMode("onRequest"), true);
    assert.strictEqual(isApprovalMode("allowAll"), true);
    assert.strictEqual(isApprovalMode("denyUnmatched"), true);
    assert.strictEqual(isApprovalMode("promptUnmatched"), true);
    assert.strictEqual(isApprovalMode("unrestricted"), false);
  });
});
