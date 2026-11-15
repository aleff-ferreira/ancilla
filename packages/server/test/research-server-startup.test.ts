/**
 * The server's side of bounded research: how long a session start may take, how many abandoned starts a host
 * absorbs, what a closing server writes, the longest question, and how `discover` pages past hidden sessions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESEARCH_CONFIG, type ResearchRunState, type ServeTarget, type WorkerBudgets, type WorkerResult, type WorkerTask } from "@ancilla/daemon";
import { MAX_RESEARCH_QUESTION_CHARS, type ResearchEngine } from "../src/research/index.js";
import type { HostHandle } from "../src/server.js";
import { FakeConnection, fakeFactory, get, send, start, waitFor } from "./harness.js";
import { sleep } from "./research-rigs.js";

function stateFor(runId: string, question: string): ResearchRunState {
  return {
    version: 1,
    runId,
    eventSeq: 0,
    question,
    config: DEFAULT_RESEARCH_CONFIG,
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
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
  };
}

const BUDGETS: WorkerBudgets = { maxToolCalls: 25, maxSearches: 3, maxReads: 10, maxSaves: 10, wallTimeMs: 60_000 };
const noSink = { onToolCall: () => undefined, onProgress: () => undefined };

const taskOf = (runId: string, agentId: number): WorkerTask => ({ runId, round: 1, agentId, topic: `topic ${agentId}`, discovery: false, instructions: "go", maxReads: null });

async function startThread(connection: FakeConnection, base: string, cwd: string): Promise<void> {
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
}

/** Starts a server while `ANCILLA_RESEARCH_STARTUP_MS` holds `value` (unset when undefined); the server reads it when it is built. */
async function startWithEnv(value: string | undefined, extra: Parameters<typeof start>[1]): ReturnType<typeof start> {
  const name = "ANCILLA_RESEARCH_STARTUP_MS";
  const before = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await start(new FakeConnection(), extra);
  } finally {
    if (before === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = before;
    }
  }
}

/** The lines written to stderr while `run` ran. */
async function captureStderr(run: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

/** A host whose `session/start` waits for the test: every call is parked, and `open` answers them all. */
function wedgedSessionStarts(connection: FakeConnection): { open: () => void; parked: () => number } {
  const parked: ((reply: unknown) => void)[] = [];
  connection.replies.set("session/start", () => new Promise((resolve) => parked.push(resolve)));
  return {
    parked: () => parked.length,
    open: () => {
      parked.forEach((resolve, index) => resolve({ session: { sessionId: `late-${index + 1}` } }));
      parked.length = 0;
    },
  };
}

/** An engine that runs the given number of workers one after another and records what each came back with. */
function sequentialEngine(count: number, results: WorkerResult[], between: (index: number) => Promise<void> = async () => undefined): ResearchEngine {
  return async (input, _config, deps, signal) => {
    for (let index = 1; index <= count; index += 1) {
      await between(index);
      results.push(await deps.worker.run(taskOf(input.runId, index), BUDGETS, signal, noSink));
    }
    // No report, so no file is written under the project folder.
    return { status: "completed", report: null, state: stateFor(input.runId, input.question), failure: null };
  };
}

const quickTurn = (connection: FakeConnection): void => {
  connection.replies.set("turn/start", (params: Record<string, unknown>) => {
    const sessionId = params["sessionId"] as string;
    setTimeout(() => {
      connection.notify("turn/started", { sessionId, turnId: "wt1" });
      connection.notify("item/completed", { sessionId, item: { itemId: "m1", kind: "agentMessage", status: "completed", turnId: "wt1", revision: 1, text: "Found it." } });
      connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: "completed" });
    }, 5);
    return { turnId: "wt1", status: "accepted" };
  });
};

async function runResearch(base: string, commandId: string, question = "q"): Promise<string> {
  const started = await send(base, "/api/research", { commandId, sessionId: "s1", question });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  return started.json.run.runId as string;
}

describe("research startup through the server", () => {
  it("gives up on a session start that never answers after researchStartupMs", async () => {
    const connection = new FakeConnection();
    const results: WorkerResult[] = [];
    const { base } = await start(connection, { researchEngine: sequentialEngine(1, results), researchStartupMs: 40 });
    await startThread(connection, base, "/work/p");
    wedgedSessionStarts(connection);
    const runId = await runResearch(base, "cmd-startup");
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "the run to finish", 2000);
    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.error ?? "", /^unavailable: could not start a worker session/);
  });

  it("takes the allowance from ANCILLA_RESEARCH_STARTUP_MS when the option is not given, and the option wins", async () => {
    const fromEnv = await startWithEnv("45000", {});
    assert.equal(fromEnv.server["researchStartupMs"](), 45_000);
    const optionWins = await startWithEnv("45000", { researchStartupMs: 9000 });
    assert.equal(optionWins.server["researchStartupMs"](), 9000);
  });

  it("ignores an environment value that is under a second or not plain milliseconds, and says so once on stderr", async () => {
    for (const bad of ["30", "999", "0x2710", "1e4", "soon"]) {
      const written = await captureStderr(async () => {
        const { server } = await startWithEnv(bad, {});
        assert.equal(server["researchStartupMs"](), 120_000, `${bad} fell back to the default`);
        assert.equal(server["researchStartupMs"](), 120_000);
      });
      const warnings = written.filter((line) => line.includes("ANCILLA_RESEARCH_STARTUP_MS"));
      assert.equal(warnings.length, 1, `${bad} is reported once, not at every start: ${JSON.stringify(warnings)}`);
      assert.ok(warnings[0]!.includes(bad), "the line names the value it ignored");
    }
    for (const fine of [undefined, "", "1000", "120000"]) {
      const written = await captureStderr(async () => {
        await startWithEnv(fine, {});
      });
      assert.deepEqual(written.filter((line) => line.includes("ANCILLA_RESEARCH_STARTUP_MS")), [], `${JSON.stringify(fine)} is no cause for a warning`);
    }
  });

  it("allows three minutes on Windows with Muse in WSL, and when Windows has not settled where Muse runs yet", async () => {
    const wsl = await start(new FakeConnection(), { platform: "win32", runtime: "wsl", musePath: "/home/dev/.local/bin/muse" });
    assert.equal(wsl.server["researchStartupMs"](), 180_000);
    // The first research start after boot can come before anything probed the environment: that is the cold distro.
    const unsettled = await start(new FakeConnection(), { platform: "win32" });
    assert.equal(unsettled.server["researchStartupMs"](), 180_000);
    const native = await start(new FakeConnection(), { platform: "win32", runtime: "native", musePath: "C:\\muse\\muse.exe" });
    assert.equal(native.server["researchStartupMs"](), 120_000);
    const linux = await start(new FakeConnection(), {});
    assert.equal(linux.server["researchStartupMs"](), 120_000);
    const overridden = await start(new FakeConnection(), { platform: "win32", runtime: "wsl", researchStartupMs: 9000, musePath: "/home/dev/.local/bin/muse" });
    assert.equal(overridden.server["researchStartupMs"](), 9000);
  });

  it("stops sending sessions into a host that never answers: two abandoned starts, then a start that waits and is not sent, then it recovers", async () => {
    const connection = new FakeConnection();
    const results: WorkerResult[] = [];
    let wedge: ReturnType<typeof wedgedSessionStarts> | null = null;
    let server: Awaited<ReturnType<typeof start>>["server"] | null = null;
    let waitersLeftBehind = -1;
    const engine = sequentialEngine(4, results, async (index) => {
      if (index === 4) {
        waitersLeftBehind = server!["startWaiters"].size;
        // The host recovers: the parked starts are answered, and the fourth worker starts once the count has dropped.
        wedge?.open();
        await waitFor(() => server!["abandonedStarts"].size === 0, "the host's late answers to drop the count", 4000);
        connection.replies.set("session/start", { session: { sessionId: "w-fresh" } });
        quickTurn(connection);
      }
    });
    const started = await start(connection, { researchEngine: engine, researchStartupMs: 500 });
    server = started.server;
    const base = started.base;
    await startThread(connection, base, "/work/p");
    wedge = wedgedSessionStarts(connection);
    const runId = await runResearch(base, "cmd-abandoned");
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "the run to finish", 6000);

    assert.deepEqual(results.map((r) => r.status), ["failed", "failed", "failed", "completed"]);
    assert.match(results[0]?.error ?? "", /did not open it within/);
    assert.match(results[1]?.error ?? "", /did not open it within/);
    assert.match(results[2]?.error ?? "", /^unavailable: could not start a worker session: .*did not open it within/, "the third start waited for a slot and ran out of allowance");
    assert.equal(connection.of("session/start").length, 1 + 2 + 1, "the thread, two abandoned starts, and the one after recovery; the waiting one never reached the host");
    assert.equal(server["abandonedStarts"].size, 0, "the count drops back once the host answers");
    assert.equal(waitersLeftBehind, 0, "the third start, which ran out of allowance while waiting, did not stay registered as a waiter");
  });

  it("lets a start that waits at the cap go ahead as soon as the host answers the earlier ones", async () => {
    const connection = new FakeConnection();
    const results: WorkerResult[] = [];
    let wedge: ReturnType<typeof wedgedSessionStarts> | null = null;
    let server: Awaited<ReturnType<typeof start>>["server"] | null = null;
    const engine = sequentialEngine(3, results, async (index) => {
      if (index === 3) {
        // Not awaited: the host answers once the third worker is registered as waiting for a slot, not after a delay.
        void waitFor(() => server!["startWaiters"].size === 1, "the third worker to wait for a slot", 4000).then(() => {
          wedge?.open();
          connection.replies.set("session/start", { session: { sessionId: "w3" } });
          quickTurn(connection);
        });
      }
    });
    const started = await start(connection, { researchEngine: engine, researchStartupMs: 1000 });
    server = started.server;
    const base = started.base;
    await startThread(connection, base, "/work/p");
    wedge = wedgedSessionStarts(connection);
    const runId = await runResearch(base, "cmd-waiting");
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "the run to finish", 6000);

    assert.deepEqual(results.map((r) => r.status), ["failed", "failed", "completed"], "the third worker waited, then started on the recovered host");
    assert.equal(connection.of("session/start").length, 1 + 2 + 1);
    await waitFor(() => server["abandonedStarts"].size === 0, "the count to drop", 2000);
  });

  it("does not hold a stop against the host: a run started right after a stop, on a host that is only slow, is not refused", async () => {
    const connection = new FakeConnection();
    const first: WorkerResult[] = [];
    const second: WorkerResult[] = [];
    let runs = 0;
    const engine: ResearchEngine = async (input, _config, deps, signal) => {
      runs += 1;
      const into = runs === 1 ? first : second;
      const tasks = runs === 1 ? [1, 2, 3] : [1];
      await Promise.all(tasks.map(async (agent) => void into.push(await deps.worker.run(taskOf(input.runId, agent), BUDGETS, signal, noSink))));
      return { status: "completed", report: null, state: stateFor(input.runId, input.question), failure: null };
    };
    const { server, base } = await start(connection, { researchEngine: engine, researchStartupMs: 60_000 });
    await startThread(connection, base, "/work/p");
    let starts = 0;
    const slow: ((reply: unknown) => void)[] = [];
    // A cold host: it answers every one of the first three starts, but only after the test lets it (after the Stop).
    connection.replies.set("session/start", () => {
      starts += 1;
      const n = starts;
      return n <= 3 ? new Promise((resolve) => slow.push(() => resolve({ session: { sessionId: `slow-${n}` } }))) : { session: { sessionId: `quick-${n}` } };
    });
    quickTurn(connection);
    const firstRun = await runResearch(base, "cmd-first");
    await waitFor(() => starts === 3, "three worker starts in flight", 4000);
    assert.equal((await send(base, `/api/research/${firstRun}/stop`, {})).status, 200);
    await waitFor(() => !server["researchJobs"].isActive(firstRun), "the first run to end", 4000);
    assert.deepEqual(first.map((r) => r.status), ["cancelled", "cancelled", "cancelled"]);
    assert.equal(server["abandonedStarts"].size, 0, "a stop is not an abandoned start in the host's books");
    // The slow host answers the stopped run's starts now, a while after the Stop.
    slow.forEach((answer) => answer(undefined));

    const secondRun = await runResearch(base, "cmd-second");
    await waitFor(async () => (await get(base, `/api/research/${secondRun}`)).run.status === "completed", "the second run to finish", 6000);
    assert.deepEqual(second.map((r) => r.status), ["completed"], `the second run's worker: ${second[0]?.error}`);
    await waitFor(() => connection.of("session/start").length === 1 + 3 + 1, "the second run's session start", 4000);
  });

  it("sends no session start for a worker that gave up while the host was still coming up", async () => {
    const connection = new FakeConnection();
    const results: WorkerResult[] = [];
    let comeUp: () => void = () => undefined;
    const hostComesUp = new Promise<void>((resolve) => {
      comeUp = resolve;
    });
    const base0 = fakeFactory(connection);
    // A cold host: the folder's host answers its start only when the test says so.
    const hostFactory = (target: ServeTarget): HostHandle => ({
      ...base0(target),
      start: async () => {
        await hostComesUp;
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
    });
    const { server, base } = await start(connection, { researchEngine: sequentialEngine(1, results), researchStartupMs: 100, hostFactory });
    const project = server["store"].upsertProject("/work/cold");
    server["store"].recordSession({ id: "cold-1", projectId: project.id, origin: "tui", title: "cold", titleSource: "user" });
    const started = await send(base, "/api/research", { commandId: "cmd-cold", sessionId: "cold-1", question: "q" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId = started.json.run.runId as string;
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "completed", "the run to finish", 6000);
    assert.equal(results[0]?.status, "failed");
    assert.match(results[0]?.error ?? "", /did not open it within/);
    assert.deepEqual([...server["abandonedStarts"].values()], [1], "the start the worker gave up on is still counted against the host");

    comeUp();
    // The count drops when the abandoned start has run its course, one way or the other.
    await waitFor(() => server["abandonedStarts"].size === 0, "the abandoned start to run its course", 4000);
    assert.equal(connection.of("session/start").length, 0, "no session was started for a worker nobody waits for");
  });

  it("writes nothing to the store for a session that opens after the server closed", async () => {
    const connection = new FakeConnection();
    const results: WorkerResult[] = [];
    const { server, base } = await start(connection, { researchEngine: sequentialEngine(1, results), researchStartupMs: 60_000 });
    await startThread(connection, base, "/work/p");
    const wedge = wedgedSessionStarts(connection);
    const store = server["store"];
    let writes = 0;
    const recordSession = store.recordSession.bind(store);
    const upsertProject = store.upsertProject.bind(store);
    await runResearch(base, "cmd-closed");
    await waitFor(() => wedge.parked() === 1, "the worker's session start parked", 2000);
    store.recordSession = (...args: Parameters<typeof recordSession>) => {
      writes += 1;
      return recordSession(...args);
    };
    store.upsertProject = (...args: Parameters<typeof upsertProject>) => {
      writes += 1;
      return upsertProject(...args);
    };
    await server.close();
    wedge.open();
    await sleep(50);
    assert.equal(writes, 0, "a start that finished after the close touched the store");
  });
});

describe("the research question limit", () => {
  const instant: ResearchEngine = async (input) => ({ status: "completed", report: null, state: stateFor(input.runId, input.question), failure: null });

  it("refuses a question over the limit and names the limit", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { researchEngine: instant });
    await startThread(connection, base, "/work/p");
    assert.equal(MAX_RESEARCH_QUESTION_CHARS, 20_000);
    const tooLong = await send(base, "/api/research", { commandId: "cmd-long", sessionId: "s1", question: "x".repeat(MAX_RESEARCH_QUESTION_CHARS + 1) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /20000/);
    assert.match(tooLong.json.error, /question/i);
    const exact = await send(base, "/api/research", { commandId: "cmd-exact", sessionId: "s1", question: "x".repeat(MAX_RESEARCH_QUESTION_CHARS) });
    assert.equal(exact.status, 200, JSON.stringify(exact.json));
    assert.deepEqual((await get(base, "/api/research?sessionId=s1")).runs.length, 1, "the refused question created no run");
  });

  it("counts the trimmed question, so padding does not trip the limit", async () => {
    const connection = new FakeConnection();
    const { base } = await start(connection, { researchEngine: instant });
    await startThread(connection, base, "/work/p");
    const padded = await send(base, "/api/research", { commandId: "cmd-pad", sessionId: "s1", question: `   ${"x".repeat(MAX_RESEARCH_QUESTION_CHARS)}   ` });
    assert.equal(padded.status, 200, JSON.stringify(padded.json));
  });
});

describe("discover pages past hidden research sessions and never loops", () => {
  const page = (sessions: unknown[], nextCursor: string | null) => ({ sessions, nextCursor });
  const real = (n: number) => ({ sessionId: `tui-${n}`, workspaceRoot: "/work/p", turnCount: 1 });

  it("stops at an empty page even when the host hands back a cursor", async () => {
    const connection = new FakeConnection();
    let calls = 0;
    connection.replies.set("session/list", () => {
      calls += 1;
      // A host that never stops: HEAD would page until this safety stop.
      return page([], calls < 50 ? `c${calls}` : null);
    });
    const { base } = await start(connection, {});
    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.sessions, []);
    assert.ok(calls <= 2, `the empty page ended the paging (asked ${calls} times)`);
  });

  it("stops when the host repeats a cursor", async () => {
    const connection = new FakeConnection();
    let calls = 0;
    connection.replies.set("session/list", () => {
      calls += 1;
      return page([real(calls)], calls < 50 ? "same" : null);
    });
    const { base } = await start(connection, {});
    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.ok(calls <= 3, `the repeated cursor ended the paging (asked ${calls} times)`);
    assert.ok(found.json.sessions.length >= 1);
  });

  it("pages past research sessions so that they do not use up the window", async () => {
    const connection = new FakeConnection();
    const { server, base } = await start(connection, {});
    const store = server["store"];
    const project = store.upsertProject("/work/p");
    const hidden = Array.from({ length: 250 }, (_, i) => `rw-${i}`);
    for (const id of hidden) {
      store.recordSession({ id, projectId: project.id, origin: "research-worker", title: "Research worker A1", titleSource: "auto" });
    }
    const hiddenItems = hidden.map((id) => ({ sessionId: id, workspaceRoot: "/work/p", turnCount: 1 }));
    connection.replies.set("session/list", (params: Record<string, unknown>) => {
      const cursor = params["cursor"] as string | undefined;
      if (!cursor) return page(hiddenItems.slice(0, 100), "p2");
      if (cursor === "p2") return page(hiddenItems.slice(100, 200), "p3");
      if (cursor === "p3") return page(hiddenItems.slice(200, 250), "p4");
      return page([real(1), real(2), real(3)], null);
    });
    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.sessions.map((s: { sessionId: string }) => s.sessionId).sort(), ["tui-1", "tui-2", "tui-3"]);
    assert.equal(connection.requests.filter((c) => c.method === "session/list").length, 4);
  });

  it("caps the number of pages it reads when every page is hidden sessions", async () => {
    const connection = new FakeConnection();
    const { server, base } = await start(connection, {});
    const store = server["store"];
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "rw-only", projectId: project.id, origin: "research-worker", title: "Research worker A1", titleSource: "auto" });
    let calls = 0;
    connection.replies.set("session/list", () => {
      calls += 1;
      return page([{ sessionId: "rw-only", workspaceRoot: "/work/p" }], `c${calls}`);
    });
    const found = await send(base, "/api/discover", {});
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.sessions, []);
    assert.ok(calls <= 25, `the page cap ended the paging (asked ${calls} times)`);
  });
});
