import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AncillaStore,
  DEFAULT_RESEARCH_CONFIG,
  ResearchFailure,
  SessionManager,
  runResearch,
  type ExecFn,
  type ModelClient,
  type ModelRequest,
  type ResearchConfig,
  type ResearchEvent,
  type ResearchEventType,
  type ResearchInput,
  type ResearchOutcome,
  type ResearchRunState,
  type WorkerBudgets,
  type WorkerResult,
  type WorkerRunner,
  type WorkerTask,
} from "@ancilla/daemon";
import {
  CONTROL_INPUT_DECLINED,
  CONTROL_TURN_INSTRUCTION,
  MAX_EXEC_PROMPT_CHARS_POSIX,
  MAX_EXEC_PROMPT_CHARS_WIN32,
  MuseExecModelClient,
  MuseModelClient,
  MuseSessionModelClient,
  MuseSessionWorkerRunner,
  RESEARCH_INPUT_DECLINED,
  ResearchJobManager,
  TURN_HARD_DEADLINE_SLACK_MS,
  WORKER_CANCEL_GRACE_MS,
  argUrlsOf,
  classifyTool,
  extractUrls,
  museExecArgs,
  parseExecOutput,
  parseFindings,
  runView,
  uuidv7,
  workerApprovalAllowed,
  type ResearchEngine,
  type WorkerClock,
  type WorkerUpdate,
} from "../src/research/index.js";
import { FakeConnection, get, send, sseEvents, start, waitFor } from "./harness.js";

// ---------------------------------------------------------------- fakes

function stateFor(input: ResearchInput, config: ResearchConfig, patch: Partial<ResearchRunState> = {}): ResearchRunState {
  return {
    version: 1,
    runId: input.runId,
    eventSeq: 0,
    question: input.question,
    config,
    phase: "researching",
    brief: "A brief",
    inputLanguage: "en",
    targetLanguage: "en",
    draft: null,
    rounds: [],
    registry: [],
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
    ...patch,
  };
}

function eventOf(input: ResearchInput, seq: number, type: ResearchEventType, extra: Partial<ResearchEvent> = {}): ResearchEvent {
  return { type, runId: input.runId, seq, at: new Date().toISOString(), phase: "scoping", round: null, agentId: null, payload: {}, ...extra };
}

/** An engine that emits a few events, checkpoints once, and returns a finished report. */
const completingEngine: ResearchEngine = async (input, config, deps) => {
  deps.events.emit(eventOf(input, 1, "run_started"));
  deps.events.emit(eventOf(input, 2, "scope_started"));
  deps.events.emit(eventOf(input, 3, "scope_completed"));
  const state = stateFor(input, config, {
    registry: [
      { code: "A1-S1", url: "https://example.com/a", title: "A", agentId: 1, round: 1, verified: true },
      { code: "A1-S2", url: "https://example.com/b", title: "B", agentId: 1, round: 1, verified: false },
    ],
    curated: [{ url: "https://example.com/a", title: "A", reason: "primary", excerpt: null, agentId: 1, round: 1, verified: true }],
  });
  await deps.checkpoint(state);
  deps.events.emit(eventOf(input, 4, "run_completed", { phase: "done" }));
  return { status: "completed", report: `# ${input.question}\n\nAn answer [1].\n\n## Sources\n1. https://example.com/a\n`, state: { ...state, phase: "done" }, failure: null };
};

/** An engine that runs until the signal fires, then comes back cancelled. */
const waitingEngine: ResearchEngine = async (input, config, deps, signal) => {
  deps.events.emit(eventOf(input, 1, "run_started"));
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  deps.events.emit(eventOf(input, 2, "run_cancelled"));
  return { status: "cancelled", report: null, state: stateFor(input, config, { aborted: true, abortReason: "stopped" }), failure: "cancelled: stopped" };
};

async function startThread(connection: FakeConnection, base: string, cwd: string, sessionId = "s1"): Promise<void> {
  connection.replies.set("session/start", (params: Record<string, unknown>) => ({ session: { sessionId: typeof params["modelId"] === "string" && params["modelId"].startsWith("worker") ? `w-${connection.of("session/start").length}` : sessionId } }));
  const started = await send(base, "/api/sessions", { cwd });
  assert.equal(started.status, 200);
}

// ---------------------------------------------------------------- routes and the job manager through the server

describe("research routes", () => {
  it("runs a job from queued to completed, persisting events, the report and its file", async () => {
    const connection = new FakeConnection();
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-research-"));
    const { base } = await start(connection, { researchEngine: completingEngine });
    await startThread(connection, base, cwd);

    let runId = "";
    const broadcasts = await sseEvents(base, "research-run", async () => {
      const started = await send(base, "/api/research", { commandId: "cmd-1", sessionId: "s1", question: "What is SQLite?", config: { maxRounds: 2 } });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      runId = started.json.run.runId;
      assert.ok(["queued", "running"].includes(started.json.run.status));
      assert.equal(started.json.run.config.maxRounds, 2, "per-run overrides land in the stored config");
      assert.equal(started.json.run.report, null);
      await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "run completion");
    }, 300);
    assert.ok(broadcasts.length >= 1, "at least one research-run broadcast");
    assert.ok(broadcasts.every((b) => b.sessionId === "s1" && b.run.runId === runId));
    assert.equal(broadcasts[broadcasts.length - 1].run.status, "completed");
    assert.equal(broadcasts[broadcasts.length - 1].run.report, null, "broadcasts carry no report body");

    const full = (await get(base, `/api/research/${runId}`)).run;
    assert.equal(full.status, "completed");
    assert.equal(full.phase, "done");
    assert.equal(full.brief, "A brief");
    assert.equal(full.reportAvailable, true);
    assert.match(full.report, /^# What is SQLite\?/);
    assert.equal(full.reportPath, `.ancilla/research/${runId}/report.md`);
    assert.deepEqual(full.sources, { registry: 2, verified: 1, curated: 1 });
    assert.equal(full.usage.totalTokens, 15);
    assert.ok(full.startedAt && full.endedAt, "started and ended stamps");
    assert.equal(await readFile(join(cwd, ".ancilla", "research", runId, "report.md"), "utf8"), full.report);
    const sources = JSON.parse(await readFile(join(cwd, ".ancilla", "research", runId, "sources.json"), "utf8"));
    assert.equal(sources.registry.length, 2);
    assert.equal(sources.curated.length, 1);

    const events = (await get(base, `/api/research/${runId}/events`)).events;
    assert.deepEqual(events.map((e: ResearchEvent) => [e.seq, e.type]), [[1, "run_started"], [2, "scope_started"], [3, "scope_completed"], [4, "run_completed"]]);
    const page = await get(base, `/api/research/${runId}/events?after=2`);
    assert.deepEqual(page.events.map((e: ResearchEvent) => e.seq), [3, 4]);
    assert.equal(page.nextAfter, 4);

    const listed = (await get(base, `/api/research?sessionId=s1`)).runs;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].runId, runId);
    assert.equal(listed[0].report, null);
    assert.equal(listed[0].reportAvailable, true);

    const transcript = await send(base, "/api/sessions/s1/resume", {});
    assert.equal(transcript.status, 200);
    assert.equal(transcript.json.researchRuns.length, 1);
    assert.equal(transcript.json.researchRuns[0].runId, runId);
    assert.equal(transcript.json.researchRuns[0].report, null);
  });

  it("returns the existing run for a repeated commandId, 409 for a second start, 400 when disabled, 404 for unknown runs", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { researchEngine: waitingEngine });
    await startThread(connection, base, "/work/p");
    const first = await send(base, "/api/research", { commandId: "cmd-a", sessionId: "s1", question: "q" });
    assert.equal(first.status, 200);
    const again = await send(base, "/api/research", { commandId: "cmd-a", sessionId: "s1", question: "something else" });
    assert.equal(again.status, 200);
    assert.equal(again.json.run.runId, first.json.run.runId);
    const second = await send(base, "/api/research", { commandId: "cmd-b", sessionId: "s1", question: "q2" });
    assert.equal(second.status, 409);
    assert.equal((await send(base, "/api/research", { sessionId: "s1", question: "q" })).status, 400, "commandId is required");
    assert.equal((await send(base, "/api/research", { commandId: "cmd-c", sessionId: "nope", question: "q" })).status, 404, "unknown session");
    assert.equal((await send(base, "/api/research", { commandId: "cmd-d", sessionId: "s1" })).status, 400, "question is required");
    assert.equal((await fetch(`${base}/api/research/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/research/nope/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    assert.equal((await send(base, `/api/research/${first.json.run.runId}/resume`, {})).status, 501);

    const stopped = await send(base, `/api/research/${first.json.run.runId}/stop`, { writeReport: false });
    assert.equal(stopped.status, 200);
    await waitFor(async () => (await get(base, `/api/research/${first.json.run.runId}`)).run.status === "cancelled", "cancel");

    const settings = await send(base, "/api/research-settings", { enabled: false, config: { maxParallel: 99 } }, "PATCH");
    assert.equal(settings.status, 200);
    assert.equal(settings.json.enabled, false);
    assert.equal(settings.json.config.maxParallel, 12, "clamped to the ceiling");
    assert.equal((await get(base, "/api/research-settings")).enabled, false);
    const disabled = await send(base, "/api/research", { commandId: "cmd-e", sessionId: "s1", question: "q" });
    assert.equal(disabled.status, 400);
    assert.match(disabled.json.error, /switched off/);
    assert.equal((await send(base, "/api/research-settings", { enabled: "yes" }, "PATCH")).status, 400);
  });

  it("stops a run: the engine sees the abort, the status becomes cancelled, and a second stop is harmless", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { researchEngine: waitingEngine });
    await startThread(connection, base, "/work/p");
    const started = await send(base, "/api/research", { commandId: "cmd-stop", sessionId: "s1", question: "q" });
    const runId = started.json.run.runId;
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "running", "running");
    const stop = await send(base, `/api/research/${runId}/stop`, { writeReport: true });
    assert.equal(stop.status, 200);
    assert.equal(stop.json.run.runId, runId);
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "cancelled", "cancelled");
    const run = (await get(base, `/api/research/${runId}`)).run;
    assert.equal(run.failure, "cancelled: stopped");
    assert.equal(run.report, null);
    assert.equal(run.reportAvailable, false);
    const events = (await get(base, `/api/research/${runId}/events`)).events;
    assert.deepEqual(events.map((e: ResearchEvent) => e.type), ["run_started", "run_cancelled"]);
    const again = await send(base, `/api/research/${runId}/stop`, {});
    assert.equal(again.status, 200);
    assert.equal(again.json.run.status, "cancelled");
  });

  it("marks a run the previous process left running as interrupted on boot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-research-db-"));
    const connection = new FakeConnection();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first server's engine ignores the signal until the test lets it go, so the row stays `running`.
    const stuckEngine: ResearchEngine = async (input, config, deps) => {
      deps.events.emit(eventOf(input, 1, "run_started"));
      await gate;
      return { status: "cancelled", report: null, state: stateFor(input, config), failure: "cancelled" };
    };
    const first = await start(connection, { dataDir, researchEngine: stuckEngine });
    after(() => release());
    await startThread(connection, first.base, "/work/p");
    const started = await send(first.base, "/api/research", { commandId: "cmd-boot", sessionId: "s1", question: "q" });
    const runId = started.json.run.runId;
    await waitFor(async () => (await get(first.base, `/api/research/${runId}`)).run.status === "running", "running");

    const second = await start(new FakeConnection(), { dataDir, researchEngine: completingEngine });
    const run = (await get(second.base, `/api/research/${runId}`)).run;
    assert.equal(run.status, "interrupted");
    assert.match(run.failure, /interrupted/);
    const events = (await get(second.base, `/api/research/${runId}/events`)).events;
    assert.deepEqual(events.map((e: ResearchEvent) => [e.seq, e.type]), [[1, "run_started"], [2, "run_interrupted"]]);
    assert.equal((await get(second.base, "/api/research?sessionId=s1")).runs[0].status, "interrupted");
    release();
  });

  it("starts worker sessions archived on the thread's host and decides their approvals by policy", async () => {
    const connection = new FakeConnection();
    // An engine that delegates one task and reports what the worker brought back.
    const delegatingEngine: ResearchEngine = async (input, config, deps, signal) => {
      deps.events.emit(eventOf(input, 1, "run_started"));
      const task: WorkerTask = { runId: input.runId, round: 1, agentId: 1, topic: "SQLite history", discovery: false, instructions: "Find the history of SQLite.", maxReads: null };
      const budgets: WorkerBudgets = { maxToolCalls: 25, maxSearches: 3, maxReads: 10, maxSaves: 10, wallTimeMs: 60_000 };
      const result = await deps.worker.run(task, budgets, signal, { onToolCall: () => undefined, onProgress: () => undefined });
      const state = stateFor(input, config, {
        rounds: [{ round: 1, startedAt: "2026-09-26T10:00:00.000Z", endedAt: "2026-09-26T10:01:00.000Z", reflection: "", verdict: "RESEARCH_COMPLETE", delegations: [{ agentId: 1, topic: task.topic, discovery: false, maxReads: null }], results: [{ agentId: 1, status: result.status, findingsChars: result.findings.length, savedCount: result.saved.length, verifiedCount: 0, observedCount: result.observed.length, usage: result.usage, error: result.error, startedAt: "2026-09-26T10:00:00.000Z", endedAt: "2026-09-26T10:01:00.000Z" }], exit: "complete" }],
      });
      deps.events.emit(eventOf(input, 2, "run_completed", { phase: "done" }));
      return { status: "completed", report: `# Report\n\n${result.findings}\n`, state, failure: null };
    };
    const { base } = await start(connection, { researchEngine: delegatingEngine });
    await startThread(connection, base, "/work/p");
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        connection.notify("approval/requested", {
          sessionId,
          approvalId: "ap-shell",
          turnId: "wt1",
          subject: { kind: "shell", command: "rm -rf /" },
          currentRequirementId: { approvalId: "ap-shell", turnId: "wt1", viewCursor: "v:1" },
          availableChoices: [{ choiceId: "allow-once", decision: "approved", label: "Allow", scope: "once" }, { choiceId: "deny-once", decision: "denied", label: "Deny", scope: "once", acceptsFeedback: true }],
        });
        connection.notify("approval/requested", {
          sessionId,
          approvalId: "ap-net",
          turnId: "wt1",
          subject: { kind: "network", host: "example.com", toolName: "web_fetch" },
          currentRequirementId: { approvalId: "ap-net", turnId: "wt1", viewCursor: "v:2" },
          availableChoices: [{ choiceId: "allow-once", decision: "approved", label: "Allow", scope: "once" }, { choiceId: "deny-once", decision: "denied", label: "Deny", scope: "once" }],
        });
        // A worker that asks the user something gets its prompt declined; nothing pends for the user.
        connection.notify("userInput/requested", { sessionId, userInputId: "ui-1", turnId: "wt1", toolName: "ask_user", questions: [{ id: "q1", header: "Which?", question: "Which source?", options: [], selection: { mode: "single" } }] });
        connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", turnId: "wt1", revision: 1, status: "completed", text: "SQLite began in 2000.\n\n```findings\n{\"saved\":[{\"url\":\"https://sqlite.org/history.html\",\"title\":\"History\",\"reason\":\"primary\"}]}\n```" } });
        connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      }, 10);
      return { turnId: "wt1", status: "accepted" };
    });
    const started = await send(base, "/api/research", { commandId: "cmd-worker", sessionId: "s1", question: "q", config: { models: { supervisor: null, worker: "worker-model", writer: null } } });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId = started.json.run.runId;
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "completion");

    const run = (await get(base, `/api/research/${runId}`)).run;
    assert.match(run.report, /SQLite began in 2000/);
    assert.equal(run.workers.length, 1);
    assert.equal(run.workers[0].agentId, 1);
    assert.equal(run.workers[0].topic, "SQLite history");
    assert.equal(run.workers[0].state, "completed");
    assert.equal(run.workers[0].saved, 1);

    const workerStart = connection.of("session/start")[1];
    assert.ok(workerStart, "a second session/start for the worker");
    assert.equal(workerStart.params?.["modelId"], "worker-model");
    assert.equal(workerStart.params?.["workspaceRoot"], "/work/p");
    const turn = connection.of("turn/start")[0];
    assert.equal(turn?.params?.["sessionId"], "w-2");
    assert.deepEqual(turn?.params?.["input"], [{ type: "text", text: "Find the history of SQLite." }]);

    const visible = (await get(base, "/api/sessions?cwd=%2Fwork%2Fp")).sessions;
    assert.deepEqual(visible.map((s: { sessionId: string }) => s.sessionId), ["s1"], "the worker session stays out of the sidebar");
    const all = (await get(base, "/api/sessions?cwd=%2Fwork%2Fp&archived=1")).sessions;
    const worker = all.find((s: { sessionId: string }) => s.sessionId === "w-2");
    assert.ok(worker, "the worker session is recorded");
    assert.equal(worker.title, "Research worker A1");
    assert.equal(worker.archived, true);
    assert.equal(worker.live.pendingApprovals, 0, "worker approvals never pend for the user");
    assert.equal(worker.live.pendingInputs, 0, "worker prompts never pend for the user");

    const decisions = connection.of("approval/decide").map((c) => [c.params?.["approvalId"], c.params?.["choiceId"], c.params?.["feedback"]]);
    assert.deepEqual(decisions, [["ap-shell", "deny-once", "Research workers may only use web search and fetch tools."], ["ap-net", "allow-once", null]]);
    assert.deepEqual(connection.of("userInput/cancel").map((c) => c.params), [{ sessionId: "w-2", userInputId: "ui-1", reason: RESEARCH_INPUT_DECLINED }]);
    assert.equal(connection.of("turn/interrupt").length, 1, "the prompt ends the worker's turn");
  });

  it("refuses a commandId that belongs to another session and closes out a stale in-flight row", async () => {
    const connection = new FakeConnection();
    const { server, base } = await start(connection, { researchEngine: completingEngine });
    await startThread(connection, base, "/work/p");
    await startThread(connection, base, "/work/p", "s2");
    const first = await send(base, "/api/research", { commandId: "cmd-shared", sessionId: "s1", question: "q" });
    assert.equal(first.status, 200);
    await waitFor(async () => (await get(base, `/api/research/${first.json.run.runId}`)).run.status === "completed", "completion");
    const clash = await send(base, "/api/research", { commandId: "cmd-shared", sessionId: "s2", question: "q" });
    assert.equal(clash.status, 409);
    assert.match(clash.json.error, /belongs to a research run on another session/);
    assert.equal((await send(base, "/api/research", { commandId: "cmd-shared", question: "q" })).status, 400, "sessionId is checked before the handle is looked up");

    // A row left `running` by a job nobody runs (a process that died without a clean boot) must not block the thread.
    const store = server["store"];
    const stale = store.createResearchRun({ id: uuidv7(), sessionId: "s2", commandId: "cmd-stale", question: "old", config: DEFAULT_RESEARCH_CONFIG, status: "running" });
    const started = await send(base, "/api/research", { commandId: "cmd-fresh", sessionId: "s2", question: "new" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const marked = (await get(base, `/api/research/${stale.id}`)).run;
    assert.equal(marked.status, "interrupted");
    assert.match(marked.failure, /^interrupted: the run was found in flight without a job running it/);
    const events = (await get(base, `/api/research/${stale.id}/events`)).events;
    assert.deepEqual(events.map((e: ResearchEvent) => e.type), ["run_interrupted"]);
    await waitFor(async () => (await get(base, `/api/research/${started.json.run.runId}`)).run.status === "completed", "the fresh run completes");
    // A run that is in flight in this process still blocks a second start.
    const blocked = await send(base, "/api/research", { commandId: "cmd-blocked", sessionId: "s2", question: "again" });
    assert.equal(blocked.status, 200, "the completed run does not block");
    await waitFor(async () => (await get(base, `/api/research/${blocked.json.run.runId}`)).run.status === "completed", "third run");
  });

  it("keeps knowing research sessions across a restart, from the store", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-research-restart-"));
    const connection = new FakeConnection();
    const first = await start(connection, { dataDir, researchEngine: completingEngine });
    await startThread(connection, first.base, "/work/p");
    // A worker session as a run records it: archived, origin research-worker.
    const store = first.server["store"];
    const project = store.getProject("/work/p")!;
    store.recordSession({ id: "w-old", projectId: project.id, title: "Research worker A1", titleSource: "auto", origin: "research-worker" });
    store.updateSession("w-old", { archived: true });
    await first.server.close();

    const connection2 = new FakeConnection();
    const second = await start(connection2, { dataDir, researchEngine: completingEngine });
    // Notifications reach the server through a host; a thread start brings the project's host up.
    await startThread(connection2, second.base, "/work/p", "s3");
    connection2.notify("approval/requested", { sessionId: "w-old", approvalId: "late-1", turnId: "t9", subject: { kind: "shell" }, currentRequirementId: { approvalId: "late-1" }, availableChoices: [] });
    connection2.notify("userInput/requested", { sessionId: "w-old", userInputId: "late-2", turnId: "t9", toolName: "ask", questions: [] });
    connection2.notify("userInput/requested", { sessionId: "s1", userInputId: "mine-1", turnId: "t1", toolName: "ask", questions: [] });
    const sessions = (await get(second.base, "/api/sessions?cwd=%2Fwork%2Fp&archived=1")).sessions;
    const worker = sessions.find((s: { sessionId: string }) => s.sessionId === "w-old");
    assert.ok(worker, "the worker session is still recorded");
    assert.equal(worker.live.pendingApprovals, 0, "a research session's approvals never pend, restart or not");
    assert.equal(worker.live.pendingInputs, 0, "a research session's prompts never pend, restart or not");
    const thread = sessions.find((s: { sessionId: string }) => s.sessionId === "s1");
    assert.equal(thread.live.pendingInputs, 1, "a thread's prompt still pends");
  });
});

// ---------------------------------------------------------------- the job manager's global worker cap

describe("ResearchJobManager", () => {
  it("caps workers across runs", async () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "s1", projectId: project.id });
    store.recordSession({ id: "s2", projectId: project.id });
    let running = 0;
    let peak = 0;
    let total = 0;
    const innerRunner: WorkerRunner = {
      async run(task, budgets, signal, sink) {
        running += 1;
        peak = Math.max(peak, running);
        total += 1;
        void budgets;
        void signal;
        sink.onProgress({ toolCalls: 0, searches: 0, reads: 0 });
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return { status: "completed", findings: `found ${task.agentId}`, saved: [], observed: [], usage: null, error: null } satisfies WorkerResult;
      },
    };
    const engine: ResearchEngine = async (input, config, deps, signal) => {
      const tasks = [1, 2, 3].map((agentId): WorkerTask => ({ runId: input.runId, round: 1, agentId, topic: `t${agentId}`, discovery: false, instructions: "go", maxReads: null }));
      const budgets: WorkerBudgets = { maxToolCalls: 1, maxSearches: 1, maxReads: 1, maxSaves: 1, wallTimeMs: 1000 };
      await Promise.all(tasks.map((task) => deps.worker.run(task, budgets, signal, { onToolCall: () => undefined, onProgress: () => undefined })));
      return { status: "completed", report: "done", state: stateFor(input, config), failure: null } satisfies ResearchOutcome;
    };
    const manager = new ResearchJobManager({
      store,
      engine,
      globalWorkerCap: 2,
      createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }),
      createWorkerRunner: () => innerRunner,
      broadcast: () => undefined,
      writeReport: async () => null,
    });
    const thread = (sessionId: string) => ({ sessionId, cwd: "/work/p", accountId: null, modelId: null });
    const r1 = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c1", question: "a", config: DEFAULT_RESEARCH_CONFIG });
    const r2 = store.createResearchRun({ id: uuidv7(), sessionId: "s2", commandId: "c2", question: "b", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(r1, thread("s1"));
    manager.start(r2, thread("s2"));
    assert.equal(manager.isActive(r1.id), true);
    await waitFor(() => store.getResearchRun(r1.id)?.status === "completed" && store.getResearchRun(r2.id)?.status === "completed", "both runs");
    assert.equal(total, 6);
    assert.equal(peak, 2, "never more than the global cap at once");
    assert.equal(manager.activeWorkers, 0);
    assert.equal(manager.isActive(r1.id), false);
    await manager.close();
  });

  it("mints time-ordered v7 ids", () => {
    const a = uuidv7(1_000_000);
    const b = uuidv7(2_000_000);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(a < b);
  });
});

// ---------------------------------------------------------------- MuseExecModelClient

describe("MuseExecModelClient", () => {
  function client(exec: ExecFn, extra: Partial<ConstructorParameters<typeof MuseExecModelClient>[0]> = {}) {
    return new MuseExecModelClient({
      exec,
      plan: (args) => ({ command: "muse", args }),
      models: { supervisor: "m-sup", worker: null, writer: "m-writer" },
      fallbackModelId: "m-thread",
      platform: "linux",
      ...extra,
    });
  }

  const request = (role: "brief" | "draft" | "supervisor" | "writer", prompt = "Say hi", signal = new AbortController().signal) => ({ role, prompt, maxOutputTokens: 100, timeoutMs: 1234, signal });

  it("builds the title path's argument list with the role's model and parses the answer", async () => {
    const calls: { command: string; args: string[]; options: Record<string, unknown> | undefined }[] = [];
    const exec: ExecFn = async (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> | undefined });
      return {
        stdout: [
          "not json",
          JSON.stringify({ payload_type: "run.output.delta", payload: { kind: "run_output_delta", text: "Hel" } }),
          JSON.stringify({ payload_type: "run.output.delta", payload: { kind: "run_output_delta", text: "lo" } }),
          JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text: "Hello there", usage: { inputTokens: 12, outputTokens: 3, cachedTokens: 2 }, modelId: "m-sup-v2" } }),
        ].join("\n"),
        exitCode: 0,
      };
    };
    const response = await client(exec).complete(request("supervisor"));
    assert.equal(response.text, "Hello there");
    assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, totalTokens: 15 });
    assert.equal(response.modelId, "m-sup-v2");
    assert.equal(calls[0]?.command, "muse");
    assert.deepEqual(calls[0]?.args, museExecArgs("Say hi", "m-sup"));
    assert.deepEqual(calls[0]?.args.slice(0, 8), ["exec", "--json", "--no-session-log", "--disable-web-tools", "--reasoning-effort", "minimal", "--max-model-steps", "1"]);
    assert.equal(calls[0]?.options?.["timeoutMs"], 1234);
    assert.ok(calls[0]?.options?.["signal"] instanceof AbortSignal);

    await client(exec).complete(request("writer"));
    assert.deepEqual(calls[1]?.args.slice(8, 10), ["--model", "m-writer"]);
    await client(exec).complete(request("brief"));
    assert.deepEqual(calls[2]?.args.slice(8, 10), ["--model", "m-sup"], "the brief uses the supervisor's model");
    await client(exec, { models: { supervisor: null, worker: null, writer: null } }).complete(request("draft"));
    assert.deepEqual(calls[3]?.args.slice(8, 10), ["--model", "m-thread"], "the thread's model stands in");
    await client(exec, { models: { supervisor: null, worker: null, writer: null }, fallbackModelId: null }).complete(request("draft"));
    assert.equal(calls[4]?.args.length, 9, "no --model when nobody named one");
  });

  it("uses the deltas when the terminal record is missing and reports no usage when none was printed", async () => {
    const exec: ExecFn = async () => ({
      stdout: [JSON.stringify({ payload_type: "run.output.delta", payload: { text: "part " } }), JSON.stringify({ payload_type: "run.output.delta", payload: { text: "two" } })].join("\n"),
      exitCode: 0,
    });
    const response = await client(exec).complete(request("supervisor"));
    assert.equal(response.text, "part two");
    assert.equal(response.usage, null);
    assert.equal(response.modelId, "m-sup", "the requested model when the output names none");
  });

  it("maps exit codes and messages to failure kinds", async () => {
    const failing = (result: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; aborted?: boolean }): ExecFn => async () => ({ stdout: "", exitCode: 1, ...result });
    const kindOf = async (exec: ExecFn): Promise<string> => {
      try {
        await client(exec).complete(request("supervisor"));
        return "none";
      } catch (error) {
        assert.ok(error instanceof ResearchFailure, `a ResearchFailure, got ${String(error)}`);
        return error.kind;
      }
    };
    assert.equal(await kindOf(failing({ stderr: "Error: 401 Unauthorized" })), "auth");
    assert.equal(await kindOf(failing({ stdout: "you are not logged in" })), "auth");
    assert.equal(await kindOf(failing({ stderr: "403 forbidden" })), "auth");
    assert.equal(await kindOf(failing({ stderr: "402 payment required: quota exceeded" })), "quota");
    assert.equal(await kindOf(failing({ stderr: "insufficient credits" })), "quota");
    assert.equal(await kindOf(failing({ stderr: "HTTP 429 too many requests" })), "rate_limited");
    assert.equal(await kindOf(failing({ stderr: "boom", timedOut: true })), "timeout");
    assert.equal(await kindOf(failing({ aborted: true })), "cancelled");
    assert.equal(await kindOf(failing({ stderr: "segfault" })), "unavailable");
    assert.equal(await kindOf(async () => ({ stdout: "", exitCode: 0 })), "invalid_output");
    assert.equal(await kindOf(async () => ({ stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { terminal: "failed", text: "" } }), exitCode: 0 })), "unavailable");
  });

  it("refuses a prompt the command line cannot carry, per platform", async () => {
    let called = 0;
    const exec: ExecFn = async () => {
      called += 1;
      return { stdout: "", exitCode: 0 };
    };
    const logs: string[] = [];
    const posix = client(exec, { log: (m) => logs.push(m) });
    await assert.rejects(posix.complete(request("writer", "x".repeat(MAX_EXEC_PROMPT_CHARS_POSIX + 1))), (error: ResearchFailure) => error.kind === "invalid_output" && /prompt too long/.test(error.message));
    const win = client(exec, { platform: "win32" });
    await assert.rejects(win.complete(request("writer", "x".repeat(MAX_EXEC_PROMPT_CHARS_WIN32 + 1))), (error: ResearchFailure) => error.kind === "invalid_output");
    assert.equal(called, 0, "nothing is run");
    assert.equal(logs.length, 1);
    assert.ok(MAX_EXEC_PROMPT_CHARS_WIN32 < MAX_EXEC_PROMPT_CHARS_POSIX);
  });

  it("honours the abort signal", async () => {
    const controller = new AbortController();
    let called = 0;
    const exec: ExecFn = async (_command, _args, options) => {
      called += 1;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { stdout: "", exitCode: 1, aborted: true };
    };
    const pending = client(exec).complete(request("supervisor", "go", controller.signal));
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (error: ResearchFailure) => error.kind === "cancelled");
    assert.equal(called, 1);
    const early = new AbortController();
    early.abort();
    await assert.rejects(client(exec).complete(request("supervisor", "go", early.signal)), (error: ResearchFailure) => error.kind === "cancelled");
    assert.equal(called, 1, "an already-stopped run never starts the process");
  });
});

// ---------------------------------------------------------------- MuseSessionWorkerRunner

/** A clock whose timers fire only when the test says so. */
class FakeClock implements WorkerClock {
  time = 1_000_000;
  timers: { id: number; at: number; callback: () => void }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Advances the clock and fires every timer that came due, in order. */
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.time).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        return;
      }
      this.timers = this.timers.filter((t) => t.id !== due.id);
      due.callback();
    }
  }
}

interface RunnerRig {
  connection: FakeConnection;
  runner: MuseSessionWorkerRunner;
  updates: WorkerUpdate[];
  clock: FakeClock;
  logs: string[];
}

function rig(options: { cancelGraceMs?: number; startFails?: boolean } = {}): RunnerRig {
  const connection = new FakeConnection();
  const manager = new SessionManager(connection as never);
  const listeners = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  connection.onNotification((n) => {
    const params = (n.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : null;
    for (const listener of [...(sessionId ? listeners.get(sessionId) ?? [] : [])]) {
      listener(n.method, params);
    }
  });
  connection.replies.set("session/start", { session: { sessionId: "w1" } });
  const updates: WorkerUpdate[] = [];
  const clock = new FakeClock();
  const logs: string[] = [];
  const runner = new MuseSessionWorkerRunner({
    host: {
      startWorkerSession: async (task, modelId) => {
        if (options.startFails) {
          throw new Error("Could not start Muse: connection refused");
        }
        const started = await manager.startSession({ workspaceRoot: "/work/p", ...(modelId ? { modelId } : {}) });
        void task;
        return { sessionId: started.sessionId, manager };
      },
      subscribe: (sessionId, handler) => {
        const set = listeners.get(sessionId) ?? new Set();
        listeners.set(sessionId, set);
        set.add(handler);
        return () => {
          set.delete(handler);
        };
      },
      onWorkerUpdate: (update) => updates.push(update),
      log: (message) => logs.push(message),
    },
    models: { supervisor: null, worker: "worker-model", writer: null },
    fallbackModelId: "thread-model",
    clock,
    cancelGraceMs: options.cancelGraceMs,
  });
  return { connection, runner, updates, clock, logs };
}

const TASK: WorkerTask = { runId: "r1", round: 1, agentId: 1, topic: "SQLite history", discovery: false, instructions: "Research SQLite's history.", maxReads: null };
const BUDGETS: WorkerBudgets = { maxToolCalls: 25, maxSearches: 3, maxReads: 10, maxSaves: 10, wallTimeMs: 600_000 };
const noSink = { onToolCall: () => undefined, onProgress: () => undefined };

describe("MuseSessionWorkerRunner", () => {
  it("runs one turn, observes searches and fetches, reads a stored search output, and parses the findings", async () => {
    const { connection, runner, updates } = rig();
    const searchOutput = JSON.stringify({ results: [{ url: "https://sqlite.org/history.html", title: "History of SQLite" }, { url: "https://en.wikipedia.org/wiki/SQLite", title: "SQLite - Wikipedia" }] });
    connection.replies.set("item/readOutput", { content: "Results:\n- [Hipp interview](https://corecursive.com/066-sqlite-with-richard-hipp/)\n- https://example.org/plain", encoding: "utf8", mediaType: "text/plain", offsetBytes: 0, byteLen: 120, eof: true });
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        connection.notify("item/started", { sessionId, item: { itemId: "c1", kind: "toolCall", tool: "web_search", args: JSON.stringify({ query: "SQLite history" }), status: "inProgress", turnId: "wt1", revision: 1 } });
        connection.notify("item/completed", { sessionId, item: { itemId: "c1", kind: "toolCall", tool: "web_search", args: JSON.stringify({ query: "SQLite history" }), status: "completed", turnId: "wt1", revision: 2, visibleOutput: searchOutput } });
        connection.notify("item/started", { sessionId, item: { itemId: "c2", kind: "toolCall", tool: "WebSearch", args: JSON.stringify({ q: "Richard Hipp SQLite" }), status: "inProgress", turnId: "wt1", revision: 1 } });
        connection.notify("item/completed", { sessionId, item: { itemId: "c2", kind: "toolCall", tool: "WebSearch", args: JSON.stringify({ q: "Richard Hipp SQLite" }), status: "completed", turnId: "wt1", revision: 2, truncated: true, visibleOutput: "Results:\n- [Hipp int", outputRef: { id: "out-2", kind: "tool_output", availability: "available", byteLen: 120, uri: "muse://out-2" } } });
        connection.notify("item/started", { sessionId, item: { itemId: "c3", kind: "toolCall", tool: "web_fetch", args: JSON.stringify({ url: "https://sqlite.org/history.html" }), status: "inProgress", turnId: "wt1", revision: 1 } });
        connection.notify("item/completed", { sessionId, item: { itemId: "c3", kind: "toolCall", tool: "web_fetch", args: JSON.stringify({ url: "https://sqlite.org/history.html" }), status: "completed", turnId: "wt1", revision: 2, visibleOutput: "SQLite was designed by D. Richard Hipp in the spring of 2000. See https://sqlite.org/about.html" } });
        connection.notify("item/completed", { sessionId, item: { itemId: "c4", kind: "toolCall", tool: "think", args: "{}", status: "completed", turnId: "wt1", revision: 1 } });
        connection.notify("session/tokenUsage", { sessionId, turnId: "wt1", promptTokens: 100, totalTokens: 140, usage: { inputTokens: 100, outputTokens: 40, cachedTokens: 10, reasoningTokens: 0 } });
        connection.notify("session/tokenUsage", { sessionId, turnId: "wt1", promptTokens: 50, totalTokens: 60, usage: { inputTokens: 50, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0 } });
        connection.notify("item/delta", { sessionId, itemId: "m1", delta: "SQLite began" });
        connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId: "wt1", revision: 1, text: "SQLite began in 2000 as a Tcl extension.\n\n```findings\n{\"findings\": \"SQLite began in 2000 as a Tcl extension, written by D. Richard Hipp.\", \"saved\": [{\"url\": \"https://sqlite.org/history.html\", \"title\": \"History\", \"reason\": \"primary source\", \"excerpt\": \"spring of 2000\"}, {\"url\": \"not a url\"}, \"https://en.wikipedia.org/wiki/SQLite\"]}\n```\n" } });
        connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const observedLive: string[] = [];
    const progress: number[] = [];
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, {
      onToolCall: (call) => observedLive.push(call.kind),
      onProgress: (p) => progress.push(p.toolCalls),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.error, null);
    assert.equal(result.findings, "SQLite began in 2000 as a Tcl extension, written by D. Richard Hipp.");
    assert.deepEqual(result.saved, [
      { url: "https://sqlite.org/history.html", title: "History", reason: "primary source", excerpt: "spring of 2000" },
      { url: "https://en.wikipedia.org/wiki/SQLite", title: null, reason: "", excerpt: null },
    ]);
    assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 50, cachedInputTokens: 10, totalTokens: 200 });
    assert.deepEqual(observedLive, ["search", "search", "fetch", "other"]);
    assert.deepEqual(progress, [1, 2, 3, 4]);
    assert.equal(result.observed.length, 4);
    const [first, second, third] = result.observed;
    assert.equal(first?.tool, "web_search");
    assert.equal(first?.query, "SQLite history");
    assert.deepEqual(first?.results, [{ url: "https://sqlite.org/history.html", title: "History of SQLite" }, { url: "https://en.wikipedia.org/wiki/SQLite", title: "SQLite - Wikipedia" }]);
    assert.deepEqual(first?.urls, ["https://sqlite.org/history.html", "https://en.wikipedia.org/wiki/SQLite"]);
    assert.equal(second?.query, "Richard Hipp SQLite");
    assert.deepEqual(second?.results, [{ url: "https://corecursive.com/066-sqlite-with-richard-hipp/", title: "Hipp interview" }, { url: "https://example.org/plain", title: null }], "a truncated search output is read through item/readOutput");
    assert.equal(third?.kind, "fetch");
    assert.deepEqual(third?.urls, ["https://sqlite.org/history.html"], "a fetch names the URL it was asked for");
    const read = connection.requests.find((r) => r.method === "item/readOutput");
    assert.deepEqual(read?.params, { sessionId: "w1", itemId: "c2", outputRef: "out-2", offsetBytes: 0, lengthBytes: 256 * 1024 });
    assert.equal(connection.of("session/start")[0]?.params?.["modelId"], "worker-model");
    assert.equal(connection.of("turn/interrupt").length, 0);
    assert.equal(updates[0]?.state, "working");
    const last = updates[updates.length - 1]!;
    assert.equal(last.state, "completed");
    assert.equal(last.toolCalls, 4);
    assert.equal(last.searches, 2);
    assert.equal(last.reads, 1);
    assert.equal(last.saved, 2);
    assert.equal(last.workerSessionId, "w1");
    assert.ok(last.endedAt);
  });

  it("interrupts the turn when the tool-call budget is passed and keeps what the worker wrote", async () => {
    const { connection, runner, logs } = rig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        for (const n of [1, 2]) {
          connection.notify("item/completed", { sessionId, item: { itemId: `c${n}`, kind: "toolCall", tool: "web_search", args: JSON.stringify({ query: `q${n}` }), status: "completed", turnId: "wt1", revision: 1, visibleOutput: `https://example.com/${n}` } });
        }
        connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId: "wt1", revision: 1, text: "Partial notes so far." } });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    connection.replies.set("turn/interrupt", (params: Record<string, unknown>) => {
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId: "wt1", terminal: "interrupted" }), 5);
      return { ok: true };
    });
    const result = await runner.run(TASK, { ...BUDGETS, maxToolCalls: 1 }, new AbortController().signal, noSink);
    assert.equal(result.status, "completed", "a budget breach still counts as a completed worker");
    assert.equal(result.findings, "Partial notes so far.");
    assert.deepEqual(result.saved, [], "no findings block means nothing was saved");
    assert.equal(result.observed.length, 2);
    assert.deepEqual(connection.of("turn/interrupt").map((c) => c.params), [{ sessionId: "w1", turnId: "wt1", retract: false }]);
    assert.equal(connection.of("turn/cancel").length, 0, "the turn ended within the grace period");
    assert.ok(logs.some((l) => /passed its budget \(2 tool calls of 1/.test(l)));
  });

  it("counts searches and reads past their soft caps without interrupting", async () => {
    const { connection, runner, logs, updates } = rig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        for (const n of [1, 2, 3]) {
          connection.notify("item/completed", { sessionId, item: { itemId: `s${n}`, kind: "toolCall", tool: "web_search", args: JSON.stringify({ query: `q${n}` }), status: "completed", turnId: "wt1", revision: 1, visibleOutput: `https://example.com/${n}` } });
          connection.notify("item/completed", { sessionId, item: { itemId: `f${n}`, kind: "toolCall", tool: "web_fetch", args: JSON.stringify({ url: `https://example.com/${n}` }), status: "completed", turnId: "wt1", revision: 1, visibleOutput: "page" } });
        }
        connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId: "wt1", revision: 1, text: "Read three pages." } });
        connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const result = await runner.run(TASK, { ...BUDGETS, maxSearches: 1, maxReads: 2, maxToolCalls: 25 }, new AbortController().signal, noSink);
    assert.equal(result.status, "completed");
    assert.equal(result.findings, "Read three pages.");
    assert.equal(result.observed.length, 6);
    assert.equal(connection.of("turn/interrupt").length, 0, "soft caps never interrupt");
    const last = updates[updates.length - 1]!;
    assert.equal(last.searches, 3);
    assert.equal(last.reads, 3);
    assert.ok(logs.some((l) => /passed its search allowance \(2 of 1\)/.test(l)));
    assert.ok(logs.some((l) => /passed its read allowance \(3 of 2\)/.test(l)));
    assert.equal(logs.filter((l) => /allowance/.test(l)).length, 2, "each soft cap is logged once");
  });

  it("interrupts at the wall time and cancels when the turn is still running after the grace period", async () => {
    const { connection, runner, clock } = rig({ cancelGraceMs: 30_000 });
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        connection.notify("item/delta", { sessionId, itemId: "m1", delta: "Half an answer" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const pending = runner.run(TASK, { ...BUDGETS, wallTimeMs: 60_000 }, new AbortController().signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connection.of("turn/interrupt").length, 0);
    clock.advance(60_000);
    await waitFor(() => connection.of("turn/interrupt").length === 1, "interrupt at the wall time");
    assert.equal(connection.of("turn/cancel").length, 0);
    // The grace timer is armed once the interrupt's reply has settled, a few microtasks after the call was seen.
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(30_000);
    await waitFor(() => connection.of("turn/cancel").length === 1, "cancel after the grace period");
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "w1", turnId: "wt1" });
    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.match(result.error ?? "", /^timeout: /);
    assert.equal(result.findings, "Half an answer", "streamed text stands in for a final message that never came");
  });

  it("stops on the run's signal and reports cancelled", async () => {
    const { connection, runner } = rig();
    connection.replies.set("turn/start", () => ({ turnId: "wt1", status: "accepted" }));
    connection.replies.set("turn/interrupt", (params: Record<string, unknown>) => {
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId: "wt1", terminal: "cancelled" }), 5);
      return { ok: true };
    });
    const controller = new AbortController();
    const pending = runner.run(TASK, BUDGETS, controller.signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start");
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.match(result.error ?? "", /^cancelled: /);
    assert.equal(connection.of("turn/interrupt").length, 1);
    const early = new AbortController();
    early.abort();
    const skipped = await runner.run(TASK, BUDGETS, early.signal, noSink);
    assert.equal(skipped.status, "cancelled");
    assert.equal(connection.of("session/start").length, 1, "an already-stopped run starts no session");
  });

  it("decides approvals by policy with Muse's decision vocabulary: web tools approved, everything else denied", async () => {
    const { connection, runner, logs } = rig();
    // The real choice shapes: `approved*` and `denied*` decisions, scopes, and feedback accepted on some only.
    const choices = [
      { choiceId: "allow-policy", decision: "approvedPolicyAmendment", scope: "localPersistent", label: "Always allow", rulePreview: "allow *" },
      { choiceId: "allow-session", decision: "approvedForSession", scope: "session", label: "Allow for this session" },
      { choiceId: "allow-once", decision: "approved", scope: "once", label: "Allow" },
      { choiceId: "deny-policy", decision: "deniedPolicyAmendment", scope: "localPersistent", label: "Always deny", acceptsFeedback: true },
      { choiceId: "deny-once", decision: "denied", scope: "once", label: "Deny", acceptsFeedback: true },
    ];
    const sessionOnly = [
      { choiceId: "allow-session", decision: "approvedForSession", scope: "session", label: "Allow for this session" },
      { choiceId: "allow-policy", decision: "approvedPolicyAmendment", scope: "localPersistent", label: "Always allow" },
      { choiceId: "deny-session", decision: "denied", scope: "session", label: "Deny", acceptsFeedback: false },
    ];
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("approval/requested", { sessionId, approvalId: "a-shell", subject: { kind: "shell", command: "ls" }, currentRequirementId: { approvalId: "a-shell", turnId: "wt1", viewCursor: "v:1" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-file", subject: { kind: "fileAccess", path: "/etc/passwd" }, currentRequirementId: { approvalId: "a-file", turnId: "wt1", viewCursor: "v:2" }, availableChoices: sessionOnly });
        connection.notify("approval/requested", { sessionId, approvalId: "a-net", subject: { kind: "network", host: "example.com" }, toolName: "web_fetch", currentRequirementId: { approvalId: "a-net", turnId: "wt1", viewCursor: "v:3" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-net-bare", subject: { kind: "network", host: "example.org" }, currentRequirementId: { approvalId: "a-net-bare", turnId: "wt1", viewCursor: "v:4" }, availableChoices: sessionOnly });
        connection.notify("approval/requested", { sessionId, approvalId: "a-tool", subject: { kind: "tool", toolName: "WebSearch" }, currentRequirementId: { approvalId: "a-tool", turnId: "wt1", viewCursor: "v:5" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-tool2", subject: { kind: "tool", toolName: "run_python" }, currentRequirementId: { approvalId: "a-tool2", turnId: "wt1", viewCursor: "v:6" }, availableChoices: choices });
        connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(result.status, "completed");
    const decisions = connection.of("approval/decide").map((c) => [c.params?.["approvalId"], c.params?.["choiceId"], (c.params?.["requirementId"] as { viewCursor: string }).viewCursor, c.params?.["feedback"]]);
    assert.deepEqual(decisions, [
      ["a-shell", "deny-once", "v:1", "Research workers may only use web search and fetch tools."],
      ["a-file", "deny-session", "v:2", null],
      ["a-net", "allow-once", "v:3", null],
      ["a-net-bare", "allow-session", "v:4", null],
      ["a-tool", "allow-once", "v:5", null],
      ["a-tool2", "deny-once", "v:6", "Research workers may only use web search and fetch tools."],
    ]);
    assert.equal(connection.of("turn/interrupt").length, 0);
    assert.ok(logs.some((l) => /approval a-net-bare \(network\) approvedForSession \(allow-session\)/.test(l)));
    assert.equal(workerApprovalAllowed("network", null), true);
    assert.equal(workerApprovalAllowed("network", "run_python"), false);
    assert.equal(workerApprovalAllowed("tool", null), false);
    assert.equal(workerApprovalAllowed("shell", "web_fetch"), false);
  });

  it("interrupts the turn instead of guessing a choiceId when no choice matches the policy", async () => {
    const { connection, runner, logs } = rig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("item/delta", { sessionId, itemId: "m1", delta: "So far: nothing." });
        connection.notify("approval/requested", { sessionId, approvalId: "a-odd", subject: { kind: "mystery" }, currentRequirementId: { approvalId: "a-odd", turnId: "wt1", viewCursor: "v:1" }, availableChoices: [{ choiceId: "only-allow", decision: "approved", scope: "once", label: "Allow" }] });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    connection.replies.set("turn/interrupt", (params: Record<string, unknown>) => {
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId: "wt1", terminal: "interrupted" }), 5);
      return { ok: true };
    });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(connection.of("approval/decide").length, 0, "no decision is sent with a made-up choiceId");
    assert.equal(connection.of("turn/interrupt").length, 1);
    assert.equal(result.status, "completed");
    assert.equal(result.findings, "So far: nothing.");
    assert.ok(logs.some((l) => /approval a-odd \(mystery\) offers no deny choice; interrupting/.test(l)));
  });

  it("comes back failed, with a kind, when the session or the turn cannot start or the turn fails", async () => {
    const failing = rig({ startFails: true });
    const noSession = await failing.runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(noSession.status, "failed");
    assert.match(noSession.error ?? "", /^unavailable: could not start a worker session/);

    const { connection, runner } = rig();
    connection.replies.set("turn/start", new Error("429 rate limited"));
    const noTurn = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(noTurn.status, "failed");
    assert.match(noTurn.error ?? "", /^rate_limited: could not start the worker turn/);

    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId: "wt1", terminal: "failed", error: { message: "quota exhausted" } }), 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const failedTurn = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(failedTurn.status, "failed");
    assert.equal(failedTurn.error, "quota: quota exhausted");
  });

  it("classifies tools by name and parses findings leniently", () => {
    assert.equal(classifyTool("web_search"), "search");
    assert.equal(classifyTool("WebSearch"), "search");
    assert.equal(classifyTool("web_fetch"), "fetch");
    assert.equal(classifyTool("read_url"), "fetch");
    assert.equal(classifyTool("browse"), "fetch");
    assert.equal(classifyTool("open_url"), "fetch");
    assert.equal(classifyTool("webget"), "fetch");
    assert.equal(classifyTool("bash"), "other");
    assert.deepEqual(parseFindings("Just prose."), { findings: "Just prose.", saved: [] });
    // The form the worker prompt asks for: a closing ```json block with findings and saved.
    const contract = parseFindings(
      'Searched three venues.\n\n```json\n{"findings": "**Findings**: A rose 4% [1].", "saved": [{"url": "https://a.example/x", "title": "A", "reason": "primary", "excerpt": null}]}\n```',
    );
    assert.equal(contract.findings, "**Findings**: A rose 4% [1].");
    assert.deepEqual(contract.saved, [{ url: "https://a.example/x", title: "A", reason: "primary", excerpt: null }]);
    // A block without its own findings text takes the prose around it.
    const around = parseFindings('Read two pages, nothing conclusive.\n```json\n{"saved": [{"url": "https://b.example", "reason": "context"}]}\n```');
    assert.equal(around.findings, "Read two pages, nothing conclusive.");
    assert.equal(around.saved.length, 1);
    const tagged = parseFindings("Notes here.\n<findings>{\"sources\": [{\"url\": \"https://a.example\", \"why\": \"good\"}]}</findings>");
    assert.equal(tagged.findings, "Notes here.");
    assert.deepEqual(tagged.saved, [{ url: "https://a.example", title: null, reason: "good", excerpt: null }]);
    const broken = parseFindings("Text\n```findings\nnot json at all\n```");
    assert.equal(broken.findings, "Text");
    assert.deepEqual(broken.saved, []);
  });
});

describe("research report files", () => {
  it("keeps the run complete when the report file cannot be written", async () => {
    const connection = new FakeConnection();
    // A workspace path that is a file: `mkdir` under it fails, and the report stays in the store only.
    const cwd = join(await mkdtemp(join(tmpdir(), "ancilla-research-")), "notadir");
    await writeFile(cwd, "x");
    const { base } = await start(connection, { researchEngine: completingEngine });
    await startThread(connection, base, cwd);
    const started = await send(base, "/api/research", { commandId: "cmd-file", sessionId: "s1", question: "q" });
    const runId = started.json.run.runId;
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "completion");
    const run = (await get(base, `/api/research/${runId}`)).run;
    assert.equal(run.status, "completed");
    assert.equal(run.reportAvailable, true);
    assert.equal(run.reportPath, null);
  });
});

// ---------------------------------------------------------------- ending a turn: grace, deadline, shutdown, hygiene

describe("MuseSessionWorkerRunner turn ending", () => {
  const ackOnly = (connection: FakeConnection): void => {
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        connection.notify("item/delta", { sessionId, itemId: "m1", delta: "Half an answer" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
  };

  it("arms the cancel grace timer before the interrupt is answered, so a silent host still gets turn/cancel", async () => {
    const { connection, runner, clock } = rig({ cancelGraceMs: 30_000 });
    ackOnly(connection);
    // The host never answers the interrupt at all.
    connection.replies.set("turn/interrupt", () => new Promise(() => undefined));
    const pending = runner.run(TASK, { ...BUDGETS, wallTimeMs: 60_000 }, new AbortController().signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start");
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(60_000);
    await waitFor(() => connection.of("turn/interrupt").length === 1, "interrupt at the wall time");
    assert.equal(connection.of("turn/cancel").length, 0);
    clock.advance(30_000);
    await waitFor(() => connection.of("turn/cancel").length === 1, "cancel after the grace period, with the interrupt still unanswered");
    assert.deepEqual(connection.of("turn/cancel")[0]?.params, { sessionId: "w1", turnId: "wt1" });
    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.equal(result.findings, "Half an answer");
    assert.equal(clock.timers.length, 0, "no timer outlives the run");
  });

  it("gives up at the hard deadline when the host never acknowledges the turn", async () => {
    const { connection, runner, clock, logs } = rig({ cancelGraceMs: 30_000 });
    connection.replies.set("turn/start", () => new Promise(() => undefined));
    const pending = runner.run(TASK, { ...BUDGETS, wallTimeMs: 60_000 }, new AbortController().signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start");
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(60_000 + 30_000);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connection.of("turn/interrupt").length, 0, "no wall timer runs before the turn is acknowledged");
    clock.advance(TURN_HARD_DEADLINE_SLACK_MS);
    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.match(result.error ?? "", /^timeout: the worker turn passed its hard deadline of 95 s/);
    // Without a turn id there is nothing to cancel by id; the session's current turn is interrupted instead.
    assert.deepEqual(connection.of("turn/interrupt").map((c) => c.params), [{ sessionId: "w1", retract: false }]);
    assert.equal(connection.of("turn/cancel").length, 0);
    assert.ok(logs.some((l) => /passed its hard deadline/.test(l)));
    assert.equal(clock.timers.length, 0);
    assert.ok(WORKER_CANCEL_GRACE_MS + TURN_HARD_DEADLINE_SLACK_MS + 60_000 === 95_000);
  });

  it("cancels at once, without the grace period, when the abort reason is a shutdown", async () => {
    const { connection, runner, clock } = rig({ cancelGraceMs: 30_000 });
    ackOnly(connection);
    const controller = new AbortController();
    const pending = runner.run(TASK, BUDGETS, controller.signal, noSink);
    await waitFor(() => connection.of("turn/start").length === 1, "turn start");
    await new Promise((r) => setTimeout(r, 20));
    controller.abort({ type: "shutdown" });
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(connection.of("turn/cancel").map((c) => c.params), [{ sessionId: "w1", turnId: "wt1" }]);
    assert.equal(connection.of("turn/interrupt").length, 0, "a shutdown does not interrupt and wait");
    assert.equal(clock.timers.length, 0);
    assert.equal(result.findings, "Half an answer");
  });

  it("leaves no timer and sends no stray interrupt when the turn completes before its start acknowledgement settles", async () => {
    const { connection, runner, clock } = rig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      // The whole turn is delivered before the acknowledgement, which lands only after the run has returned.
      connection.notify("turn/started", { sessionId, turnId: "wt1" });
      connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId: "wt1", revision: 1, text: "Instant answer." } });
      connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      return new Promise((resolve) => setTimeout(() => resolve({ turnId: "wt1", status: "accepted" }), 30));
    });
    const result = await runner.run(TASK, { ...BUDGETS, wallTimeMs: 60_000 }, new AbortController().signal, noSink);
    assert.equal(result.status, "completed");
    assert.equal(result.findings, "Instant answer.");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(clock.timers.length, 0, "the wall timer was never armed after the turn settled");
    clock.advance(10 * 60_000);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connection.of("turn/interrupt").length, 0);
    assert.equal(connection.of("turn/cancel").length, 0);
  });

  it("declines a user-input prompt and ends the worker's turn", async () => {
    const { connection, runner, logs } = rig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("turn/started", { sessionId, turnId: "wt1" });
        connection.notify("item/delta", { sessionId, itemId: "m1", delta: "Before asking." });
        connection.notify("userInput/requested", { sessionId, userInputId: "ui-7", turnId: "wt1", toolName: "ask_user", questions: [] });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    connection.replies.set("turn/interrupt", (params: Record<string, unknown>) => {
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId: "wt1", terminal: "interrupted" }), 5);
      return { ok: true };
    });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(result.status, "completed");
    assert.equal(result.findings, "Before asking.");
    assert.deepEqual(connection.of("userInput/cancel").map((c) => c.params), [{ sessionId: "w1", userInputId: "ui-7", reason: RESEARCH_INPUT_DECLINED }]);
    assert.equal(connection.of("turn/interrupt").length, 1);
    assert.ok(logs.some((l) => /asked for user input \(ui-7\); declining and interrupting/.test(l)));
  });
});

// ---------------------------------------------------------------- URLs and exec output

describe("url extraction", () => {
  it("keeps balanced parentheses and strips only unbalanced trailing ones and prose punctuation", () => {
    assert.deepEqual(extractUrls("See https://en.wikipedia.org/wiki/Foo_(bar) for details."), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(extractUrls("(see https://example.org/a) and https://example.org/b."), ["https://example.org/a", "https://example.org/b"]);
    assert.deepEqual(extractUrls("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(extractUrls("(https://en.wikipedia.org/wiki/Foo_(bar)),"), ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    assert.deepEqual(extractUrls("https://example.org/x, https://example.org/x"), ["https://example.org/x"]);
  });

  it("takes fetch URLs from the parsed arguments first and falls back to the text", () => {
    assert.deepEqual(argUrlsOf(JSON.stringify({ url: "https://en.wikipedia.org/wiki/Foo_(bar)." })), ["https://en.wikipedia.org/wiki/Foo_(bar)."]);
    assert.deepEqual(argUrlsOf(JSON.stringify({ urls: ["https://a.example/1", "https://a.example/2", "https://a.example/1"] })), ["https://a.example/1", "https://a.example/2"]);
    assert.deepEqual(argUrlsOf(JSON.stringify({ href: "https://a.example/h", note: "ignore https://a.example/inline" })), ["https://a.example/h"]);
    assert.deepEqual(argUrlsOf(JSON.stringify({ query: "no url here" })), []);
    assert.deepEqual(argUrlsOf("fetch https://a.example/plain) now"), ["https://a.example/plain"]);
    assert.deepEqual(argUrlsOf(null), []);
  });

  it("reads a Markdown link whose URL holds parentheses", async () => {
    const { connection, runner } = rig();
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("item/completed", { sessionId, item: { itemId: "c1", kind: "toolCall", tool: "web_search", args: JSON.stringify({ query: "foo" }), status: "completed", turnId: "wt1", revision: 1, visibleOutput: "- [Foo (bar)](https://en.wikipedia.org/wiki/Foo_(bar))\n- [Plain](https://example.org/p)" } });
        connection.notify("item/completed", { sessionId, item: { itemId: "c2", kind: "toolCall", tool: "web_fetch", args: JSON.stringify({ url: "https://en.wikipedia.org/wiki/Foo_(bar)" }), status: "completed", turnId: "wt1", revision: 1, visibleOutput: "Foo (bar) is a thing." } });
        connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.deepEqual(result.observed[0]?.results, [
      { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo (bar)" },
      { url: "https://example.org/p", title: "Plain" },
    ]);
    assert.deepEqual(result.observed[1]?.urls, ["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });
});

describe("parseExecOutput usage", () => {
  const delta = (text: string, usage?: Record<string, number>) => JSON.stringify({ payload_type: "run.output.delta", payload: { kind: "run_output_delta", text, ...(usage ? { usage } : {}) } });
  const terminal = (text: string, usage?: Record<string, number>) => JSON.stringify({ payload_type: "run.terminal.completed", payload: { kind: "run_terminal", terminal: "completed", text, ...(usage ? { usage } : {}) } });

  it("takes the terminal record's usage over the deltas' when both are printed", () => {
    const parsed = parseExecOutput([delta("Hel", { inputTokens: 5, outputTokens: 1 }), delta("lo", { inputTokens: 5, outputTokens: 1 }), terminal("Hello", { inputTokens: 12, outputTokens: 3, cachedTokens: 2 })].join("\n"));
    assert.equal(parsed.text, "Hello");
    assert.deepEqual(parsed.usage, { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2, totalTokens: 15 });
  });

  it("sums the deltas' usage when the terminal record carries none", () => {
    const parsed = parseExecOutput([delta("Hel", { inputTokens: 5, outputTokens: 1 }), delta("lo", { inputTokens: 0, outputTokens: 2 }), terminal("Hello")].join("\n"));
    assert.deepEqual(parsed.usage, { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0, totalTokens: 8 });
    assert.equal(parseExecOutput([delta("x"), terminal("x")].join("\n")).usage, null);
  });
});

// ---------------------------------------------------------------- MuseSessionModelClient and the composite client

interface ControlRig {
  connection: FakeConnection;
  client: MuseSessionModelClient;
  clock: FakeClock;
  logs: string[];
  starts: (string | null)[];
}

function controlRig(options: { startFails?: boolean; models?: { supervisor: string | null; worker: string | null; writer: string | null } } = {}): ControlRig {
  const connection = new FakeConnection();
  const manager = new SessionManager(connection as never);
  const listeners = new Map<string, Set<(method: string, params: Record<string, unknown>) => void>>();
  connection.onNotification((n) => {
    const params = (n.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : null;
    for (const listener of [...(sessionId ? listeners.get(sessionId) ?? [] : [])]) {
      listener(n.method, params);
    }
  });
  let started = 0;
  connection.replies.set("session/start", () => {
    started += 1;
    return { session: { sessionId: `ctl-${started}` } };
  });
  const clock = new FakeClock();
  const logs: string[] = [];
  const starts: (string | null)[] = [];
  const client = new MuseSessionModelClient({
    host: {
      startControlSession: async (modelId) => {
        starts.push(modelId);
        if (options.startFails) {
          throw new Error("Could not start Muse: connection refused");
        }
        const session = await manager.startSession({ workspaceRoot: "/work/p", ...(modelId ? { modelId } : {}) });
        return { sessionId: session.sessionId, manager };
      },
      subscribe: (sessionId, handler) => {
        const set = listeners.get(sessionId) ?? new Set();
        listeners.set(sessionId, set);
        set.add(handler);
        return () => {
          set.delete(handler);
        };
      },
      log: (message) => logs.push(message),
    },
    models: options.models ?? { supervisor: "m-sup", worker: null, writer: "m-writer" },
    fallbackModelId: "m-thread",
    clock,
    cancelGraceMs: 30_000,
  });
  return { connection, client, clock, logs, starts };
}

/** A turn/start reply that answers with `text` after a tick, with usage. */
function answering(connection: FakeConnection, text: string | ((sessionId: string) => void)): void {
  let turns = 0;
  connection.replies.set("turn/start", (params: Record<string, unknown>) => {
    const sessionId = params["sessionId"] as string;
    turns += 1;
    const turnId = `ct${turns}`;
    setTimeout(() => {
      if (typeof text === "function") {
        text(sessionId);
        return;
      }
      connection.notify("turn/started", { sessionId, turnId });
      connection.notify("session/tokenUsage", { sessionId, turnId, promptTokens: 200, totalTokens: 250, usage: { inputTokens: 200, outputTokens: 50, cachedTokens: 20 } });
      connection.notify("item/completed", { sessionId, item: { itemId: `m${turns}`, kind: "agentMessage", status: "completed", turnId, revision: 1, text } });
      connection.notify("turn/completed", { sessionId, turnId, terminal: "completed" });
    }, 5);
    return { turnId, status: "accepted" };
  });
}

const modelRequest = (role: "brief" | "draft" | "supervisor" | "writer", prompt = "Decide.", signal = new AbortController().signal, timeoutMs = 240_000) => ({ role, prompt, maxOutputTokens: 100, timeoutMs, signal });

describe("MuseSessionModelClient", () => {
  it("answers a prompt as one turn in a lazily started control session, reused across calls", async () => {
    const { connection, client, starts } = controlRig();
    answering(connection, "```json\n{\"verdict\": \"RESEARCH_COMPLETE\"}\n```");
    assert.equal(connection.of("session/start").length, 0, "nothing starts before the first call");
    const first = await client.complete(modelRequest("supervisor", "x".repeat(40_000)));
    assert.equal(first.text, "```json\n{\"verdict\": \"RESEARCH_COMPLETE\"}\n```");
    assert.deepEqual(first.usage, { inputTokens: 200, outputTokens: 50, cachedInputTokens: 20, totalTokens: 250 });
    assert.equal(first.modelId, "m-sup");
    const second = await client.complete(modelRequest("brief", "short"));
    assert.equal(second.text, first.text);
    assert.deepEqual(starts, ["m-sup"], "one control session serves every call of the same model");
    assert.equal(connection.of("session/start").length, 1);
    assert.equal(connection.of("session/start")[0]?.params?.["modelId"], "m-sup");
    const turns = connection.of("turn/start");
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.params?.["sessionId"], "ctl-1");
    assert.equal(turns[1]?.params?.["sessionId"], "ctl-1");
    const input = (turns[0]?.params?.["input"] as { text: string }[])[0]?.text ?? "";
    assert.ok(input.startsWith("x".repeat(40_000)));
    assert.ok(input.endsWith(`\n\n${CONTROL_TURN_INSTRUCTION}`), "the prompt ends with the no-tools instruction");
    // The writer's model gets its own session.
    await client.complete(modelRequest("writer", "write"));
    assert.deepEqual(starts, ["m-sup", "m-writer"]);
    assert.equal(connection.of("turn/start")[2]?.params?.["sessionId"], "ctl-2");
  });

  it("denies approvals, declines prompts as invalid output, and maps a silent host to a timeout", async () => {
    const { connection, client, clock } = controlRig();
    let call = 0;
    answering(connection, (sessionId) => {
      call += 1;
      const turnId = `ct${call}`;
      connection.notify("turn/started", { sessionId, turnId });
      if (call === 1) {
        connection.notify("approval/requested", { sessionId, approvalId: "ca-1", turnId, subject: { kind: "tool", toolName: "WebSearch" }, currentRequirementId: { approvalId: "ca-1", viewCursor: "v:1" }, availableChoices: [{ choiceId: "ok", decision: "approved", scope: "once", label: "Allow" }, { choiceId: "no", decision: "denied", scope: "once", label: "Deny", acceptsFeedback: true }] });
        connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId, revision: 1, text: "Answered without the tool." } });
        connection.notify("turn/completed", { sessionId, turnId, terminal: "completed" });
      } else if (call === 2) {
        connection.notify("userInput/requested", { sessionId, userInputId: "cu-1", turnId, toolName: "ask_user", questions: [] });
      }
      // The third turn never completes on its own.
    });
    connection.replies.set("turn/interrupt", (params: Record<string, unknown>) => {
      const turnId = params["turnId"] as string;
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId, terminal: "interrupted" }), 5);
      return { ok: true };
    });
    const first = await client.complete(modelRequest("supervisor"));
    assert.equal(first.text, "Answered without the tool.");
    assert.deepEqual(connection.of("approval/decide").map((c) => [c.params?.["approvalId"], c.params?.["choiceId"], c.params?.["feedback"]]), [["ca-1", "no", "Answer directly from the material in the prompt; tools are not available for this call."]]);

    await assert.rejects(client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "invalid_output" && /asked for user input/.test(error.message));
    assert.deepEqual(connection.of("userInput/cancel").map((c) => c.params), [{ sessionId: "ctl-1", userInputId: "cu-1", reason: CONTROL_INPUT_DECLINED }]);

    const pending = client.complete(modelRequest("supervisor", "slow", new AbortController().signal, 240_000));
    await waitFor(() => connection.of("turn/start").length === 3, "third turn");
    await new Promise((r) => setTimeout(r, 20));
    clock.advance(240_000);
    await assert.rejects(pending, (error: ResearchFailure) => error.kind === "timeout" && /240 s wall time/.test(error.message));
    assert.equal(connection.of("turn/interrupt").length, 2, "the prompt and the timeout each interrupted a turn");
    assert.equal(connection.of("session/start").length, 1, "the session is kept through failures");
  });

  it("comes back cancelled on the run's signal and unavailable when the control session cannot start", async () => {
    const { connection, client } = controlRig();
    answering(connection, () => undefined);
    connection.replies.set("turn/interrupt", (params: Record<string, unknown>) => {
      setTimeout(() => connection.notify("turn/completed", { sessionId: params["sessionId"], turnId: params["turnId"], terminal: "cancelled" }), 5);
      return { ok: true };
    });
    const controller = new AbortController();
    const pending = client.complete(modelRequest("writer", "go", controller.signal));
    await waitFor(() => connection.of("turn/start").length === 1, "turn start");
    controller.abort({ type: "stop", writeReport: false });
    await assert.rejects(pending, (error: ResearchFailure) => error.kind === "cancelled");
    const early = new AbortController();
    early.abort();
    await assert.rejects(client.complete(modelRequest("writer", "go", early.signal)), (error: ResearchFailure) => error.kind === "cancelled");
    assert.equal(connection.of("turn/start").length, 1);

    const failing = controlRig({ startFails: true });
    await assert.rejects(failing.client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "unavailable" && /could not start the research control session/.test(error.message));
    assert.equal(failing.starts.length, 1);
    await assert.rejects(failing.client.complete(modelRequest("supervisor")), (error: ResearchFailure) => error.kind === "unavailable");
    assert.equal(failing.starts.length, 2, "a failed start is tried again on the next call");
  });
});

describe("MuseModelClient", () => {
  it("uses muse exec while the prompt fits the command line and the control session when it does not, and logs which", async () => {
    const calls: string[] = [];
    const exec: ModelClient = { complete: async (request) => {
      calls.push(`exec:${request.role}`);
      return { text: "from exec", usage: null, modelId: "m-exec" };
    } };
    const session: ModelClient = { complete: async (request) => {
      calls.push(`session:${request.role}`);
      return { text: "from session", usage: null, modelId: "m-session" };
    } };
    const logs: string[] = [];
    const posix = new MuseModelClient({ exec, session, platform: "linux", log: (m) => logs.push(m) });
    assert.equal((await posix.complete(modelRequest("supervisor", "x".repeat(MAX_EXEC_PROMPT_CHARS_POSIX)))).text, "from exec");
    assert.equal((await posix.complete(modelRequest("writer", "x".repeat(MAX_EXEC_PROMPT_CHARS_POSIX + 1)))).text, "from session");
    const win = new MuseModelClient({ exec, session, platform: "win32", log: (m) => logs.push(m) });
    assert.equal((await win.complete(modelRequest("supervisor", "x".repeat(MAX_EXEC_PROMPT_CHARS_WIN32 + 1)))).text, "from session");
    assert.equal((await win.complete(modelRequest("brief", "short"))).text, "from exec");
    assert.deepEqual(calls, ["exec:supervisor", "session:writer", "session:supervisor", "exec:brief"]);
    assert.match(logs[0] ?? "", /^research: supervisor prompt is 100000 chars \(exec limit 100000\); using the exec transport\.$/);
    assert.match(logs[1] ?? "", /using the session transport\.$/);
    assert.match(logs[2] ?? "", /\(exec limit 28000\); using the session transport\.$/);
  });
});

// ---------------------------------------------------------------- stopping a salvage write, and bookkeeping that cannot throw

function fenced(value: unknown): string {
  return "```json\n" + JSON.stringify(value) + "\n```";
}

interface SalvageRig {
  manager: ResearchJobManager;
  writerRunning: Promise<void>;
  writerSignal: () => AbortSignal | null;
  waiting: () => boolean;
}

/**
 * The real engine over a scripted model and worker: round 1 finds a verified source, round 2's worker waits for
 * the stop, and the salvage writer waits on its signal until someone ends it.
 */
function salvageRig(store: AncillaStore, options: { log?: (m: string) => void } = {}): SalvageRig {
  let writerSignal: AbortSignal | null = null;
  let writerStarted!: () => void;
  const writerRunning = new Promise<void>((resolve) => {
    writerStarted = resolve;
  });
  let waiting = false;
  const model: ModelClient = {
    complete: async (request: ModelRequest) => {
      if (request.role === "brief") {
        return { text: fenced({ research_brief: "Brief.", input_language: "English", target_language: "English" }), usage: null, modelId: null };
      }
      if (request.role === "supervisor") {
        return { text: fenced({ reflection: "r", verdict: "CONTINUE_RESEARCH", delegations: [{ topic: "T", discovery: false }] }), usage: null, modelId: null };
      }
      writerSignal = request.signal;
      writerStarted();
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new ResearchFailure("cancelled", "the writer was stopped")), { once: true });
      });
    },
  };
  const runner: WorkerRunner = {
    async run(task, _budgets, signal) {
      if (task.agentId === 1) {
        const url = "https://example.org/a1";
        return { status: "completed", findings: `Found (${url}).`, saved: [{ url, title: "A1", reason: "primary", excerpt: null }], observed: [{ tool: "web_fetch", kind: "fetch", query: null, urls: [url], results: [], at: new Date().toISOString() }], usage: null, error: null };
      }
      waiting = true;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", findings: "", saved: [], observed: [], usage: null, error: "cancelled: stopped" };
    },
  };
  const manager = new ResearchJobManager({
    store,
    engine: runResearch,
    createModelClient: () => model,
    createWorkerRunner: () => runner,
    broadcast: () => undefined,
    writeReport: async () => null,
    log: options.log,
  });
  return { manager, writerRunning, writerSignal: () => writerSignal, waiting: () => waiting };
}

describe("ResearchJobManager stops and bookkeeping", () => {
  const thread = (sessionId: string) => ({ sessionId, cwd: "/work/p", accountId: null, modelId: null });

  function seeded(): AncillaStore {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "s1", projectId: project.id });
    return store;
  }

  it("ends a salvage write on a second stop that no longer wants a report", async () => {
    const store = seeded();
    const rigged = salvageRig(store);
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-salvage", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    rigged.manager.start(run, thread("s1"));
    await waitFor(() => rigged.waiting(), "round 2's worker waiting");
    assert.equal(rigged.manager.stop(run.id, true), true);
    await rigged.writerRunning;
    assert.equal(store.getResearchRun(run.id)?.state?.phase, "writing", "the salvage write is under way");
    assert.equal(rigged.manager.stop(run.id, true), false, "a repeated stop-and-write changes nothing");
    assert.equal(rigged.manager.stop(run.id, false), true, "a stop without a report ends the salvage write");
    await waitFor(() => store.getResearchRun(run.id)?.status === "cancelled", "cancelled");
    assert.equal(rigged.writerSignal()?.aborted, true, "the writer's signal followed the second stop");
    assert.equal(store.getResearchRun(run.id)?.report, null);
    const types = store.listResearchEvents(run.id).map((e) => e.type);
    assert.ok(types.includes("run_cancelled") && types.includes("report_started"), types.join(","));
    assert.equal(rigged.manager.isActive(run.id), false);
    assert.equal(rigged.manager.stop(run.id, false), false, "a finished run is left as it is");
    await rigged.manager.close();
  });

  it("ends a salvage write on close, well within the close timeout", async () => {
    const store = seeded();
    const rigged = salvageRig(store);
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-close", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    rigged.manager.start(run, thread("s1"));
    await waitFor(() => rigged.waiting(), "round 2's worker waiting");
    rigged.manager.stop(run.id, true);
    await rigged.writerRunning;
    const t0 = Date.now();
    await rigged.manager.close();
    assert.ok(Date.now() - t0 < 4000, "close did not wait out its timeout");
    assert.equal(rigged.writerSignal()?.aborted, true);
    assert.equal(store.getResearchRun(run.id)?.status, "cancelled", "the outcome was persisted before close returned");
    assert.throws(() => rigged.manager.start(run, thread("s1")), /closed/);
  });

  it("writes a terminal status, an event and drops the job when the engine throws", async () => {
    const store = seeded();
    const logs: string[] = [];
    const throwing: ResearchEngine = async (input, _config, deps) => {
      deps.events.emit(eventOf(input, 1, "run_started"));
      throw new Error("boom");
    };
    const manager = new ResearchJobManager({ store, engine: throwing, createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }), createWorkerRunner: () => ({ run: async () => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) }), broadcast: () => undefined, writeReport: async () => null, log: (m) => logs.push(m) });
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-throw", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(run, thread("s1"));
    await waitFor(() => store.getResearchRun(run.id)?.status === "failed", "failed");
    assert.equal(store.getResearchRun(run.id)?.failure, "other: boom");
    assert.ok(store.getResearchRun(run.id)?.endedAt);
    assert.deepEqual(store.listResearchEvents(run.id).map((e) => [e.seq, e.type]), [[1, "run_started"], [2, "run_failed"]]);
    assert.equal(manager.isActive(run.id), false);
    assert.ok(logs.some((l) => /threw: boom/.test(l)));

    // A throw after a stop is the stop's doing.
    const stopped: ResearchEngine = async (input, _config, deps, signal) => {
      deps.events.emit(eventOf(input, 1, "run_started"));
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("torn down");
    };
    const manager2 = new ResearchJobManager({ store, engine: stopped, createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }), createWorkerRunner: () => ({ run: async () => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) }), broadcast: () => undefined, writeReport: async () => null });
    const run2 = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-throw-2", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager2.start(run2, thread("s1"));
    await waitFor(() => store.getResearchRun(run2.id)?.status === "running", "running");
    manager2.stop(run2.id, false);
    await waitFor(() => store.getResearchRun(run2.id)?.status === "cancelled", "cancelled");
    assert.equal(store.getResearchRun(run2.id)?.failure, "cancelled: torn down");
    assert.equal(store.listResearchEvents(run2.id)[1]?.type, "run_cancelled");
    await manager.close();
    await manager2.close();
  });

  it("stays quiet after close: late checkpoints, events and worker updates neither write nor throw", async () => {
    const store = new AncillaStore();
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "s1", projectId: project.id });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let onUpdate: ((update: WorkerUpdate) => void) | null = null;
    const stuck: ResearchEngine = async (input, config, deps) => {
      deps.events.emit(eventOf(input, 1, "run_started"));
      await gate;
      // The store is closed by now; none of these may throw or reach it.
      await deps.checkpoint(stateFor(input, config));
      deps.events.emit(eventOf(input, 2, "scope_started"));
      onUpdate?.({ runId: input.runId, round: 1, agentId: 1, topic: "t", discovery: false, workerSessionId: "w9", state: "working", toolCalls: 0, searches: 0, reads: 0, saved: 0, startedAt: new Date().toISOString(), endedAt: null });
      return { status: "cancelled", report: null, state: stateFor(input, config), failure: "cancelled" };
    };
    const logs: string[] = [];
    const manager = new ResearchJobManager({ store, engine: stuck, createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }), createWorkerRunner: (_run, _thread, update) => {
      onUpdate = update;
      return { run: async () => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) };
    }, broadcast: () => undefined, writeReport: async () => null, log: (m) => logs.push(m) });
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-late", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    manager.start(run, thread("s1"));
    await waitFor(() => store.getResearchRun(run.id)?.status === "running", "running");
    // The close deadline is unref'd (a shutdown must not be held by it); in a bare test something must keep the loop alive.
    const keepAlive = setInterval(() => undefined, 10);
    try {
      await manager.close(50);
      assert.equal(manager.isActive(run.id), true, "the engine ignored the shutdown within the close timeout");
      assert.ok(logs.some((l) => /did not finish within 50 ms/.test(l)));
      store.close();
      release();
      await waitFor(() => !manager.isActive(run.id), "the job winds down");
      assert.ok(!logs.some((l) => /could not/.test(l)), `no write was attempted: ${logs.join(" | ")}`);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("views a run whose stored state is unusable as one with no checkpoint", () => {
    const store = seeded();
    const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId: "c-view", question: "q", config: DEFAULT_RESEARCH_CONFIG });
    const broken = store.updateResearchRun(run.id, { status: "running", state: {} as ResearchRunState })!;
    assert.equal(broken.state, null);
    const view = runView(broken, [], { withReport: false });
    assert.equal(view.phase, "scoping");
    assert.equal(view.round, 0);
    assert.deepEqual(view.sources, { registry: 0, verified: 0, curated: 0 });
    assert.equal(view.usage.totalTokens, 0);
    assert.equal(view.researchDeadlineAt, null);
    const manager = new ResearchJobManager({ store, engine: completingEngine, createModelClient: () => ({ complete: async () => ({ text: "", usage: null, modelId: null }) }), createWorkerRunner: () => ({ run: async () => ({ status: "failed", findings: "", saved: [], observed: [], usage: null, error: "unused" }) }), broadcast: () => undefined, writeReport: async () => null });
    assert.equal(manager.markInterrupted(broken, "Stale.")?.status, "interrupted", "a stale row with an unusable state is still marked");
    assert.equal(store.listResearchEvents(run.id)[0]?.phase, null);
  });
});
