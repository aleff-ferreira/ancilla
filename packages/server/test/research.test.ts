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
  type ExecFn,
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
  MAX_EXEC_PROMPT_CHARS_POSIX,
  MAX_EXEC_PROMPT_CHARS_WIN32,
  MuseExecModelClient,
  MuseSessionWorkerRunner,
  ResearchJobManager,
  classifyTool,
  museExecArgs,
  parseFindings,
  uuidv7,
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
          availableChoices: [{ choiceId: "allow-once", decision: "allow", label: "Allow", scope: "once" }, { choiceId: "deny-once", decision: "deny", label: "Deny", scope: "once" }],
        });
        connection.notify("approval/requested", {
          sessionId,
          approvalId: "ap-net",
          turnId: "wt1",
          subject: { kind: "network", host: "example.com", toolName: "web_fetch" },
          currentRequirementId: { approvalId: "ap-net", turnId: "wt1", viewCursor: "v:2" },
          availableChoices: [{ choiceId: "allow-once", decision: "allow", label: "Allow", scope: "once" }, { choiceId: "deny-once", decision: "deny", label: "Deny", scope: "once" }],
        });
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

    const decisions = connection.of("approval/decide").map((c) => [c.params?.["approvalId"], c.params?.["choiceId"]]);
    assert.deepEqual(decisions, [["ap-shell", "deny-once"], ["ap-net", "allow-once"]]);
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

  it("interrupts the turn when a budget is passed and keeps what the worker wrote", async () => {
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
    const result = await runner.run(TASK, { ...BUDGETS, maxSearches: 1 }, new AbortController().signal, noSink);
    assert.equal(result.status, "completed", "a budget breach still counts as a completed worker");
    assert.equal(result.findings, "Partial notes so far.");
    assert.deepEqual(result.saved, [], "no findings block means nothing was saved");
    assert.equal(result.observed.length, 2);
    assert.deepEqual(connection.of("turn/interrupt").map((c) => c.params), [{ sessionId: "w1", turnId: "wt1", retract: false }]);
    assert.equal(connection.of("turn/cancel").length, 0, "the turn ended within the grace period");
    assert.ok(logs.some((l) => /passed its budget/.test(l)));
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

  it("decides approvals by policy: web tools allowed, everything else denied", async () => {
    const { connection, runner } = rig();
    const choices = [{ choiceId: "allow-session", decision: "allow", scope: "session", label: "Always" }, { choiceId: "allow-once", decision: "allow", scope: "once", label: "Allow" }, { choiceId: "deny-once", decision: "deny", scope: "once", label: "Deny" }];
    connection.replies.set("turn/start", (params: Record<string, unknown>) => {
      const sessionId = params["sessionId"] as string;
      setTimeout(() => {
        connection.notify("approval/requested", { sessionId, approvalId: "a-shell", subject: { kind: "shell", command: "ls" }, currentRequirementId: { approvalId: "a-shell", turnId: "wt1", viewCursor: "v:1" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-file", subject: { kind: "fileAccess", path: "/etc/passwd" }, currentRequirementId: { approvalId: "a-file", turnId: "wt1", viewCursor: "v:2" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-net", subject: { kind: "network", host: "example.com" }, toolName: "web_fetch", currentRequirementId: { approvalId: "a-net", turnId: "wt1", viewCursor: "v:3" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-tool", subject: { kind: "tool", toolName: "WebSearch" }, currentRequirementId: { approvalId: "a-tool", turnId: "wt1", viewCursor: "v:4" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-tool2", subject: { kind: "tool", toolName: "run_python" }, currentRequirementId: { approvalId: "a-tool2", turnId: "wt1", viewCursor: "v:5" }, availableChoices: choices });
        connection.notify("approval/requested", { sessionId, approvalId: "a-odd", subject: { kind: "mystery" }, currentRequirementId: { approvalId: "a-odd", turnId: "wt1", viewCursor: "v:6" }, availableChoices: [] });
        connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
      }, 5);
      return { turnId: "wt1", status: "accepted" };
    });
    const result = await runner.run(TASK, BUDGETS, new AbortController().signal, noSink);
    assert.equal(result.status, "completed");
    const decisions = connection.of("approval/decide").map((c) => [c.params?.["approvalId"], c.params?.["choiceId"], (c.params?.["requirementId"] as { viewCursor: string }).viewCursor]);
    assert.deepEqual(decisions, [
      ["a-shell", "deny-once", "v:1"],
      ["a-file", "deny-once", "v:2"],
      ["a-net", "allow-once", "v:3"],
      ["a-tool", "allow-once", "v:4"],
      ["a-tool2", "deny-once", "v:5"],
      ["a-odd", "deny", "v:6"],
    ]);
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
