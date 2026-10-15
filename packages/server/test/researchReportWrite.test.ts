/** Where a research report is saved, and what the run says when the project would not take it. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearchEvent } from "@ancilla/daemon";
import type { ResearchEngine } from "../src/research/index.js";
import { FakeConnection, get, send, start, waitFor } from "./harness.js";
import { tryLink, unlinkLink } from "./fsLinks.js";

const reportingEngine: ResearchEngine = async (input, config, deps) => {
  const state = {
    version: 1, runId: input.runId, eventSeq: 0, question: input.question, config, phase: "done", brief: null, inputLanguage: "en",
    targetLanguage: "en", draft: null, rounds: [], registry: [], curated: [], notes: [], consecutiveFailures: 0, aborted: false,
    abortReason: null, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2 }, startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z", nextAgentId: 1,
  } as never;
  deps.events.emit({ type: "run_started", runId: input.runId, seq: 1, at: new Date().toISOString(), phase: "scoping", round: null, agentId: null, payload: {} });
  await deps.checkpoint(state);
  deps.events.emit({ type: "run_completed", runId: input.runId, seq: 2, at: new Date().toISOString(), phase: "done", round: null, agentId: null, payload: {} });
  return { status: "completed", report: `# ${input.question}\n\nAn answer.\n`, state, failure: null };
};

async function runOnce(cwd: string) {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const { base } = await start(connection, { researchEngine: reportingEngine });
  assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
  const started = await send(base, "/api/research", { commandId: "cmd-1", sessionId: "s1", question: "What is saved?" });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const runId: string = started.json.run.runId;
  const view = async () => (await get(base, `/api/research/${runId}`)).run;
  await waitFor(async () => (await view()).status === "completed", "the run to complete");
  return { base, runId, view };
}

describe("a research report's file", () => {
  it("is written under a fresh run folder, with an ignore file for the project's .ancilla", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-report-"));
    const { runId, view } = await runOnce(cwd);
    await waitFor(async () => (await view()).reportPath !== null, "the report path");
    const run = await view();
    assert.equal(run.reportPath, `.ancilla/research/${runId}/report.md`);
    assert.ok(!run.reportWriteError, "a saved report carries no write error");
    assert.match(await readFile(join(cwd, ".ancilla", "research", runId, "report.md"), "utf8"), /An answer\./);
    assert.equal(await readFile(join(cwd, ".ancilla", ".gitignore"), "utf8"), "*\n");
  });

  it("says so on the run, and in its events, when the project's .ancilla is not a folder", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-report-"));
    await writeFile(join(cwd, ".ancilla"), "in the way");
    const { base, runId, view } = await runOnce(cwd);
    await waitFor(async () => Boolean((await view()).reportWriteError), "the write error to show on the run");
    const run = await view();
    assert.equal(run.reportPath, null);
    assert.equal(run.reportAvailable, true, "the report itself is still in Ancilla");
    assert.match(run.reportWriteError, /\.ancilla/, "it names what was in the way");
    const events: ResearchEvent[] = (await get(base, `/api/research/${runId}/events`)).events;
    const failure = events.find((event) => event.type === "report_write_failed");
    assert.ok(failure, `an event records it: ${events.map((e) => e.type).join(", ")}`);
    assert.equal(failure.payload["error"], run.reportWriteError);
    const listed = (await get(base, "/api/research?sessionId=s1")).runs[0];
    assert.equal(listed.reportWriteError, run.reportWriteError, "the list shows it too, for a thread that is reopened");
  });

  it("is read back from the last events of a long run, without paging through all of them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-report-"));
    await writeFile(join(cwd, ".ancilla"), "in the way");
    const longEngine: ResearchEngine = async (...args) => {
      const [input, , deps] = args;
      for (let step = 0; step < 1200; step += 1) {
        deps.events.emit({ type: "source_found", runId: input.runId, seq: step + 1, at: new Date().toISOString(), phase: "researching", round: null, agentId: null, payload: {} } as never);
      }
      return reportingEngine(...args);
    };
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base, server } = await start(connection, { researchEngine: longEngine });
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    const started = await send(base, "/api/research", { commandId: "cmd-1", sessionId: "s1", question: "What is saved?" });
    const runId: string = started.json.run.runId;
    const view = async () => (await get(base, `/api/research/${runId}`)).run;
    await waitFor(async () => Boolean((await view()).reportWriteError), "the write error to show on the run");
    const noted = (await view()).reportWriteError;
    // A process that did not see the failure happen only has the events to go by.
    const jobs = (server as unknown as { researchJobs: { reportWriteErrors: Map<string, string | null> } }).researchJobs;
    jobs.reportWriteErrors.clear();
    const store = (server as unknown as { store: { listResearchEvents: (...args: unknown[]) => unknown[] } }).store;
    const reads: unknown[][] = [];
    const real = store.listResearchEvents.bind(store);
    store.listResearchEvents = (...args: unknown[]) => {
      reads.push(args);
      return real(...args);
    };
    assert.equal((await view()).reportWriteError, noted, "the note comes back from the events");
    assert.equal(reads.length, 1, `one read of the tail, not a walk through the run: ${JSON.stringify(reads)}`);
  });

  it("refuses to write through a link, and says that it is one", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-report-"));
    const outside = await mkdtemp(join(tmpdir(), "ancilla-report-outside-"));
    await mkdir(join(cwd, ".ancilla"));
    if (!(await tryLink(outside, join(cwd, ".ancilla", "research"), "dir"))) {
      return t.skip("this machine cannot create a folder link");
    }
    const { runId, view } = await runOnce(cwd);
    await waitFor(async () => Boolean((await view()).reportWriteError), "the write error to show on the run");
    const run = await view();
    assert.match(run.reportWriteError, /link/i);
    assert.ok(run.reportWriteError.includes(join(cwd, ".ancilla", "research")), run.reportWriteError);
    assert.equal(run.reportPath, null);
    assert.deepEqual(await readdir(outside), [], `nothing reached ${runId} behind the link`);
    await rm(outside, { recursive: true, force: true });
  });

  it("is refused by an export in the same way, as a 409 that says what to do", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-report-"));
    const { base, runId, view } = await runOnce(cwd);
    await waitFor(async () => (await view()).reportPath !== null, "the report path");
    await rm(join(cwd, ".ancilla"), { recursive: true, force: true });
    await writeFile(join(cwd, ".ancilla"), "in the way");
    const exported = await send(base, `/api/research/${runId}/export`, { format: "html" });
    assert.equal(exported.status, 409, JSON.stringify(exported.json));
    assert.equal(exported.json.kind, "workspaceWrite");
    assert.match(exported.json.error, /\.ancilla/);
  });
});

type JobsProbe = {
  options: { reportWriteTimeoutMs?: number; log?: (line: string) => void; broadcast: (view: any) => void };
  reportWriteErrors: Map<string, string | null>;
};

/** A server whose report write the test holds open: `settle` resolves or rejects it, as late as the test likes. */
async function hungWrite(limitMs: number) {
  const connection = new FakeConnection();
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const { base, server } = await start(connection, { researchEngine: reportingEngine });
  const jobs = (server as unknown as { researchJobs: JobsProbe }).researchJobs;
  jobs.options.reportWriteTimeoutMs = limitMs;
  const logs: string[] = [];
  const realLog = jobs.options.log;
  jobs.options.log = (line) => {
    logs.push(line);
    realLog?.(line);
  };
  const views: any[] = [];
  const realBroadcast = jobs.options.broadcast;
  jobs.options.broadcast = (view) => {
    views.push(view);
    realBroadcast(view);
  };
  let settle: { resolve: (path: string | null) => void; reject: (error: Error) => void } | null = null;
  (server as unknown as { writeResearchReport: () => Promise<string | null> }).writeResearchReport = () =>
    new Promise<string | null>((resolve, reject) => {
      settle = { resolve, reject };
    });
  assert.equal((await send(base, "/api/sessions", { cwd: "/work/p" })).status, 200);
  const started = await send(base, "/api/research", { commandId: "cmd-1", sessionId: "s1", question: "What is saved?" });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const runId: string = started.json.run.runId;
  const view = async () => (await get(base, `/api/research/${runId}`)).run;
  await waitFor(async () => Boolean((await view()).reportWriteError), "the hung write to be given up on");
  return { base, runId, view, logs, views, settle: () => settle as unknown as NonNullable<typeof settle>, jobs };
}

describe("a research report's file that the project never answers for", () => {
  it("is let go of with a visible error on the run and a report_write_failed event", async () => {
    const { base, runId, view } = await hungWrite(100);
    const run = await view();
    assert.equal(run.status, "completed");
    assert.equal(run.reportPath, null);
    assert.equal(run.reportAvailable, true, "the report itself is still in Ancilla");
    assert.match(run.reportWriteError, /report file could not be written/);
    assert.match(run.reportWriteError, /100 ms/, "it says how long it waited");
    const events: ResearchEvent[] = (await get(base, `/api/research/${runId}/events`)).events;
    const failure = events.find((event) => event.type === "report_write_failed");
    assert.ok(failure, `an event records it: ${events.map((e) => e.type).join(", ")}`);
    assert.equal(failure.payload["error"], run.reportWriteError);
  });

  it("clears the error, stores the path and tells open clients when the write lands late", async () => {
    const { runId, view, settle, views } = await hungWrite(100);
    const before = views.length;
    settle().resolve(`.ancilla/research/${runId}/report.md`);
    await waitFor(async () => (await view()).reportPath !== null, "the late path to be stored");
    const run = await view();
    assert.equal(run.reportPath, `.ancilla/research/${runId}/report.md`);
    assert.ok(!run.reportWriteError, "the error is gone");
    await waitFor(() => views.slice(before).some((v) => v.runId === runId && v.reportPath !== null && !v.reportWriteError), "a broadcast of the updated row");
  });

  it("logs a write that fails late and leaves the error in place", async () => {
    const { runId, view, settle, logs } = await hungWrite(100);
    settle().reject(new Error("disk went away"));
    await waitFor(() => logs.some((line) => line.includes(runId) && line.includes("disk went away")), "the late failure to be logged");
    const run = await view();
    assert.equal(run.reportPath, null);
    assert.match(run.reportWriteError, /report file could not be written/);
  });
});

describe("the memo of report write errors", () => {
  it("does not grow without limit as runs are viewed", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { server } = await start(connection, { researchEngine: reportingEngine });
    const jobs = (server as unknown as { researchJobs: JobsProbe & { reportWriteErrorOf: (record: unknown) => unknown } }).researchJobs;
    for (let n = 0; n < 700; n += 1) {
      jobs.reportWriteErrorOf({ id: `run-${n}`, reportPath: null, report: "a report" });
    }
    assert.ok(jobs.reportWriteErrors.size <= 512, `the memo holds ${jobs.reportWriteErrors.size} runs`);
  });
});

describe("the files inside a run's own folder", () => {
  /** An engine that, before it returns its report, lets the test put something in the run's folder. */
  function plantingEngine(plant: (folder: string, runId: string) => Promise<void>, cwd: string): ResearchEngine {
    return async (...args) => {
      const [input] = args;
      const folder = join(cwd, ".ancilla", "research", input.runId);
      await mkdir(folder, { recursive: true });
      await plant(folder, input.runId);
      return reportingEngine(...args);
    };
  }

  async function runWith(engine: ResearchEngine, cwd: string) {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection, { researchEngine: engine });
    assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    const started = await send(base, "/api/research", { commandId: "cmd-leaf", sessionId: "s1", question: "What is saved?" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId: string = started.json.run.runId;
    const view = async () => (await get(base, `/api/research/${runId}`)).run;
    await waitFor(async () => (await view()).status === "completed", "the run to complete");
    return { base, runId, view };
  }

  for (const leaf of ["report.md", "sources.json"]) {
    it(`does not write through a link at ${leaf}, and the run says so`, async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "ancilla-leaf-"));
      const outside = await mkdtemp(join(tmpdir(), "ancilla-leaf-outside-"));
      const victim = join(outside, "victim.txt");
      await writeFile(victim, "untouched");
      let linked = true;
      const engine = plantingEngine(async (folder) => {
        linked = await tryLink(victim, join(folder, leaf), "file");
      }, cwd);
      const { base, runId, view } = await runWith(engine, cwd);
      if (!linked) {
        return t.skip("this machine cannot create a file link");
      }
      await waitFor(async () => Boolean((await view()).reportWriteError), "the write error to show on the run");
      const run = await view();
      assert.match(run.reportWriteError, /link/i);
      assert.ok(run.reportWriteError.includes(join(cwd, ".ancilla", "research", runId, leaf)), run.reportWriteError);
      assert.equal(run.reportPath, null);
      assert.equal(await readFile(victim, "utf8"), "untouched", "nothing was written through the link");
      const events: ResearchEvent[] = (await get(base, `/api/research/${runId}/events`)).events;
      assert.ok(events.some((event) => event.type === "report_write_failed"));
      await unlinkLink(join(cwd, ".ancilla", "research", runId, leaf));
      await rm(outside, { recursive: true, force: true });
    });

    it(`does not write over a folder at ${leaf}, and the run says so`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "ancilla-leaf-"));
      const engine = plantingEngine(async (folder) => {
        await mkdir(join(folder, leaf));
      }, cwd);
      const { runId, view } = await runWith(engine, cwd);
      await waitFor(async () => Boolean((await view()).reportWriteError), "the write error to show on the run");
      const run = await view();
      assert.match(run.reportWriteError, /folder/i);
      assert.ok(run.reportWriteError.includes(join(cwd, ".ancilla", "research", runId, leaf)), run.reportWriteError);
      assert.equal(run.reportPath, null);
    });
  }

  it("writes neither file when the second one is the one in the way", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-leaf-"));
    const outside = await mkdtemp(join(tmpdir(), "ancilla-leaf-outside-"));
    let linked = true;
    const engine = plantingEngine(async (folder) => {
      linked = await tryLink(join(outside, "victim.txt"), join(folder, "sources.json"), "file");
    }, cwd);
    const { runId, view } = await runWith(engine, cwd);
    if (!linked) {
      return t.skip("this machine cannot create a file link");
    }
    await waitFor(async () => Boolean((await view()).reportWriteError), "the write error to show on the run");
    await assert.rejects(readFile(join(cwd, ".ancilla", "research", runId, "report.md"), "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readdir(outside), [], "and nothing reached the link's target");
    await unlinkLink(join(cwd, ".ancilla", "research", runId, "sources.json"));
  });

  it("refuses an export whose file is a link, as a 409, and leaves the target alone", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-leaf-"));
    const outside = await mkdtemp(join(tmpdir(), "ancilla-leaf-outside-"));
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "untouched");
    const { base, runId, view } = await runOnce(cwd);
    await waitFor(async () => (await view()).reportPath !== null, "the report path");
    if (!(await tryLink(victim, join(cwd, ".ancilla", "research", runId, "report.html"), "file"))) {
      return t.skip("this machine cannot create a file link");
    }
    const exported = await send(base, `/api/research/${runId}/export`, { format: "html" });
    assert.equal(exported.status, 409, JSON.stringify(exported.json));
    assert.equal(exported.json.kind, "workspaceWrite");
    assert.match(exported.json.error, /link/i);
    assert.equal(await readFile(victim, "utf8"), "untouched", "nothing was written through the link");
    await unlinkLink(join(cwd, ".ancilla", "research", runId, "report.html"));
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses an export whose file is a folder, as a 409", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-leaf-"));
    const { base, runId, view } = await runOnce(cwd);
    await waitFor(async () => (await view()).reportPath !== null, "the report path");
    await mkdir(join(cwd, ".ancilla", "research", runId, "report.pdf"));
    const exported = await send(base, `/api/research/${runId}/export`, { format: "pdf" });
    assert.equal(exported.status, 409, JSON.stringify(exported.json));
    assert.equal(exported.json.kind, "workspaceWrite");
    assert.match(exported.json.error, /folder/i);
  });

  it("still replaces an export of its own on the next export", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ancilla-leaf-"));
    const { base, runId, view } = await runOnce(cwd);
    await waitFor(async () => (await view()).reportPath !== null, "the report path");
    assert.equal((await send(base, `/api/research/${runId}/export`, { format: "html" })).status, 200);
    assert.equal((await send(base, `/api/research/${runId}/export`, { format: "html" })).status, 200);
  });
});
