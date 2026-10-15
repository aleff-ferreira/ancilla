import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAonia } from "@harjjotsinghh/aonia";
import type { ResearchRunState, ServeTarget } from "@ancilla/daemon";
import type { ResearchEngine } from "../src/research/index.js";
import type { HostHandle } from "../src/server.js";
import { FakeConnection, fakeFactory, get, send, sseEvents, start, waitFor, type FactoryProbe } from "./harness.js";

const RANGE = { first: { id: "r", sequence: 1 }, last: { id: "r", sequence: 1 }, stream: { id: "s", kind: "session" } };

/** A research engine that runs until it is stopped, so a run stays in flight meanwhile. */
const waitingEngine: ResearchEngine = async (input, config, _deps, signal) => {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const state: ResearchRunState = {
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
    aborted: true,
    abortReason: "stopped",
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
  };
  return { status: "cancelled", report: null, state, failure: "cancelled: stopped" };
};

class MspTestError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

/** A `model/list` answer in Muse's shape: the rows, and the catalog's own provider, profile and source. */
function catalog(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    source: "providerCatalog",
    providerId: "meta",
    profileId: "tbh",
    models: ids.map((modelId) => ({ modelId, displayLabel: modelId, providerId: "meta", profileId: "tbh", isActive: false })),
    ...extra,
  };
}

/** The default login on one fake host, a named account on another, told apart the way the account routing test does. */
async function twoAccounts(t: { after: (fn: () => Promise<void>) => void }) {
  const defaults = new FakeConnection();
  const work = new FakeConnection();
  const home = await mkdtemp(join(tmpdir(), "ancilla-models-aonia-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
  await aonia.createProfile("work");
  const factory = (target: ServeTarget): HostHandle => {
    // Normalize separators: aonia's profile root uses backslashes on Windows (...\profiles\work\config).
    const account = target.env?.["XDG_CONFIG_HOME"]?.replaceAll("\\", "/").includes("/work/") ? work : defaults;
    return fakeFactory(account)(target);
  };
  const { base } = await start(defaults, { hostFactory: factory, aonia });
  defaults.replies.set("model/list", catalog(["muse-spark-1.3"]));
  work.replies.set("model/list", catalog(["muse-spark-1.3", "muse-wonder-1.0"], { profileId: "work-profile" }));
  return { defaults, work, base };
}

const modelLists = (connection: FakeConnection) => connection.requests.filter((call) => call.method === "model/list");
const ids = (answer: { models: { models: { modelId: string }[] } }) => answer.models.models.map((m) => m.modelId);

describe("GET /api/models by account", () => {
  it("answers from the default login's host, the named account's host, or the thread's own host", async (t) => {
    const { defaults, work, base } = await twoAccounts(t);

    const plain = await get(base, "/api/models");
    assert.deepEqual(ids(plain), ["muse-spark-1.3"]);
    assert.equal(modelLists(defaults).length, 1);
    assert.equal(modelLists(work).length, 0, "the default login never asks a named account's host");

    const named = await get(base, "/api/models?accountId=work");
    assert.deepEqual(ids(named), ["muse-spark-1.3", "muse-wonder-1.0"]);
    assert.equal(modelLists(work).length, 1);
    assert.equal(modelLists(work)[0]?.params?.["sessionId"], undefined);
    assert.equal(modelLists(defaults).length, 1);

    work.replies.set("session/start", { session: { sessionId: "w1" } });
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    const thread = await get(base, "/api/models?sessionId=w1");
    assert.deepEqual(ids(thread), ["muse-spark-1.3", "muse-wonder-1.0"]);
    assert.equal(modelLists(work).at(-1)?.params?.["sessionId"], "w1", "the thread's host flags the thread's active row");
    assert.equal(modelLists(defaults).length, 1);

    // The thread's host decides, whatever account the request names.
    const both = await get(base, "/api/models?sessionId=w1&accountId=nope");
    assert.deepEqual(ids(both), ["muse-spark-1.3", "muse-wonder-1.0"]);
  });

  it("tells the UI where the list came from and which Muse answered", async (t) => {
    const { base } = await twoAccounts(t);
    const answer = await get(base, "/api/models?accountId=work");
    assert.equal(answer.models.source, "providerCatalog");
    assert.equal(answer.models.providerId, "meta");
    assert.equal(answer.models.profileId, "work-profile");
    assert.equal(answer.hostVersion, "1.1.1");
  });

  it("refuses an account it does not know", async (t) => {
    const { defaults, work, base } = await twoAccounts(t);
    const unknown = await send(base, "/api/models?accountId=nope", undefined, "GET");
    assert.equal(unknown.status, 400);
    assert.equal(modelLists(defaults).length + modelLists(work).length, 0);
    // An empty account is the default login, not an unknown one.
    assert.equal((await send(base, "/api/models?accountId=", undefined, "GET")).status, 200);
  });
});

describe("forking a thread", () => {
  it("keeps the source thread's account", async (t) => {
    const { work, base } = await twoAccounts(t);
    work.replies.set("session/start", { session: { sessionId: "w1" } });
    work.replies.set("session/fork", { session: { sessionId: "w2" } });
    const started = await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    assert.equal(started.json.session.accountId, "work");

    const fork = await send(base, "/api/sessions/w1/fork", {});
    assert.equal(fork.status, 200);
    assert.equal(fork.json.session.sessionId, "w2");
    assert.equal(fork.json.session.accountId, "work");
    const listed = (await get(base, "/api/sessions")).sessions.find((s: { sessionId: string }) => s.sessionId === "w2");
    assert.equal(listed?.accountId, "work", "the stored fork names the account, so its models and plan follow it");
  });

  it("leaves a fork of a default-login thread on the default login", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    connection.replies.set("session/fork", { session: { sessionId: "s2" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/proj" });
    const fork = await send(base, "/api/sessions/s1/fork", {});
    assert.equal(fork.json.session.accountId, null);
  });
});

describe("switching a thread's model", () => {
  async function thread(listReply: unknown = {
    ...catalog(["muse-spark-1.3", "muse-wonder-1.0"]),
    models: [
      { modelId: "muse-spark-1.3", providerId: "meta", profileId: "tbh", isActive: true },
      { modelId: "muse-wonder-1.0", providerId: "meta", profileId: "tbh", displayLabel: "Muse Wonder" },
    ],
  }) {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1", modelId: "muse-spark-1.3" } });
    connection.replies.set("model/list", listReply);
    // The host always comes back on the model the session started with.
    connection.replies.set("session/resume", { session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1, modelId: "muse-spark-1.3" } });
    connection.replies.set("view/page", { events: [], nextCursor: null });
    connection.replies.set("approval/listPending", { approvals: [], userInputs: [] });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const sets = () => connection.calls.filter((call) => call.method === "session/setModel");
    const model = (modelId: string) => send(base, "/api/sessions/s1/model", { model: { modelId } });
    const resume = async () => (await send(base, "/api/sessions/s1/resume", {})).json.msp.modelId;
    return { connection, base, sets, model, resume };
  }

  it("sends a listed id as the catalog's own row, and puts it back on resume", async () => {
    const { sets, model, resume } = await thread();
    assert.equal((await model("muse-wonder-1.0")).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: "muse-wonder-1.0", providerId: "meta", profileId: "tbh", displayLabel: "Muse Wonder" });
    assert.equal(await resume(), "muse-wonder-1.0", "a pick the catalog lists is restored when the host comes back on another model");
    assert.equal(sets().length, 2);
  });

  it("sends an unlisted id on the catalog's provider and profile, and keeps it for this thread only", async () => {
    const { connection, sets, model, resume } = await thread();
    assert.equal((await model("muse-wonder-full-x")).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: "muse-wonder-full-x", providerId: "meta", profileId: "tbh" });
    // Muse's own answer to the switch is not a pick to restore either.
    connection.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-wonder-full-x", source: "user", viewCursor: "v:1", sourceRange: RANGE });
    assert.equal(await resume(), "muse-spark-1.3", "the host's model stands: an id the catalog lacks is not put back");
    assert.equal(sets().length, 1);
  });

  it("tries an unlisted id on the active row's provider when the catalog names none", async () => {
    const { sets, model } = await thread({
      models: [
        { modelId: "muse-spark-1.3", providerId: "meta", profileId: null, isActive: true },
        { modelId: "other", providerId: "elsewhere", profileId: "x", isActive: false },
      ],
    });
    assert.equal((await model("muse-wonder-full-x")).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: "muse-wonder-full-x", providerId: "meta", profileId: null });
  });

  it("stores nothing for a switch Muse rejects, and leaves the earlier pick standing", async () => {
    const { connection, sets, model, resume } = await thread();
    assert.equal((await model("muse-wonder-1.0")).status, 200);
    connection.replies.set("session/setModel", new MspTestError("That model is not offered.", "modelNotOffered"));
    const rejected = await model("muse-spark-1.3");
    assert.equal(rejected.status, 409);
    assert.match(rejected.json.error, /not offered/);
    connection.replies.set("session/setModel", { ok: true });
    assert.equal(await resume(), "muse-wonder-1.0", "the rejected id was never the pick");
    assert.deepEqual(sets().map((call) => (call.params?.["model"] as { modelId: string }).modelId), ["muse-wonder-1.0", "muse-spark-1.3", "muse-wonder-1.0"]);
  });

  it("stores a rejected unlisted id nowhere either", async () => {
    const { connection, sets, model, resume } = await thread();
    connection.replies.set("session/setModel", new MspTestError("Unknown model.", "modelNotOffered"));
    assert.equal((await model("typo-model")).status, 409);
    connection.replies.set("session/setModel", { ok: true });
    assert.equal(await resume(), "muse-spark-1.3");
    assert.equal(sets().length, 1, "nothing was put back on resume");
  });

  it("does not take Muse's answer to an unlisted switch for a pick, even when it comes before the reply", async () => {
    const { connection, sets, model, resume } = await thread();
    // Muse may announce the change before it answers the request, so the mark that keeps it from being stored as a
    // pick has to be in place before the request goes out.
    connection.replies.set("session/setModel", () => {
      connection.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-wonder-full-x", source: "user", viewCursor: "v:1", sourceRange: RANGE });
      return { ok: true };
    });
    assert.equal((await model("muse-wonder-full-x")).status, 200);
    assert.equal(await resume(), "muse-spark-1.3", "the typo'd id is not put back on the next resume");
    assert.equal(sets().length, 1);
  });

  it("takes an id as a pick when the catalog lists no models at all, since that says nothing about it", async () => {
    const { sets, model, resume } = await thread(catalog([]));
    assert.equal((await model("muse-wonder-1.0")).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: "muse-wonder-1.0" });
    assert.equal(await resume(), "muse-wonder-1.0");
  });

  it("still sends the bare id when the catalog cannot be read, and treats it as a pick", async () => {
    const { connection, sets, model, resume } = await thread(new MspTestError("catalog unavailable", "internal"));
    assert.equal((await model("muse-wonder-1.0")).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: "muse-wonder-1.0" });
    connection.replies.set("model/list", catalog(["muse-spark-1.3"]));
    assert.equal(await resume(), "muse-wonder-1.0");
  });

  it("still lets another Muse client's change to an id outside the catalog be the pick", async () => {
    const { connection, sets, resume } = await thread();
    connection.notify("session/modelChanged", { sessionId: "s1", modelId: "muse-spark-1.2", source: "user", viewCursor: "v:1", sourceRange: RANGE });
    assert.equal(await resume(), "muse-spark-1.2");
    assert.equal(sets().length, 1);
  });
});

describe("POST /api/hosts/restart", () => {
  it("closes the hosts while Muse is idle, says so, and the next call starts a fresh one", async () => {
    const connection = new FakeConnection();
    connection.replies.set("model/list", catalog(["muse-spark-1.3"]));
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });
    await get(base, "/api/models");
    assert.equal(probe.targets.length, 1);

    let restarted: { status: number; json: any } | null = null;
    const events = await sseEvents(base, "host", async () => {
      restarted = await send(base, "/api/hosts/restart", {});
    });
    assert.equal((restarted as { status: number } | null)?.status, 200);
    assert.deepEqual(events.map((event) => event.state), ["restarted"]);
    assert.match(events[0]?.message, /model list/);
    assert.equal(probe.targets.length, 1, "nothing starts until something asks");

    await get(base, "/api/models");
    assert.equal(probe.targets.length, 2, "the next call starts a new host, which reads the catalog again");
    assert.equal(modelLists(connection).length, 2);
  });

  it("restarts nothing when no host is running", async () => {
    const connection = new FakeConnection();
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });
    const res = await send(base, "/api/hosts/restart", {});
    assert.equal(res.status, 200);
    assert.equal(probe.targets.length, 0);
  });

  it("refuses while a turn is running, and goes ahead once it ends", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { hostFactory: fakeFactory(connection, probe) });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("turn/started", { sessionId: "s1", turnId: "t1" });

    const refused = await send(base, "/api/hosts/restart", {});
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /still open/);
    // The turn is untouched: still running, and no host was closed or started.
    assert.equal((await get(base, "/api/sessions")).sessions[0].live.activeTurnId, "t1");
    assert.equal(probe.targets.length, 1);

    connection.notify("turn/completed", { sessionId: "s1", turnId: "t1", terminal: "completed" });
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
  });

  it("refuses while an approval waits for the user", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const { base } = await start(connection);
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    connection.notify("approval/requested", { sessionId: "s1", approvalId: "a1", turnId: "t1", viewCursor: "v:1", sourceRange: RANGE });
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 409);
  });

  it("refuses while a research run is in flight, and goes ahead once it is stopped", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/start", { session: { sessionId: "s1" } });
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { base } = await start(connection, { researchEngine: waitingEngine, hostFactory: fakeFactory(connection, probe) });
    await send(base, "/api/sessions", { cwd: "/work/proj" });
    const started = await send(base, "/api/research", { commandId: "cmd-1", sessionId: "s1", question: "What is SQLite?" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const runId = started.json.run.runId;
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "running", "the run to start");

    const refused = await send(base, "/api/hosts/restart", {});
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /research run/);
    assert.equal(probe.targets.length, 1, "no host was closed or started");

    assert.equal((await send(base, `/api/research/${runId}/stop`, { writeReport: false })).status, 200);
    await waitFor(async () => (await get(base, `/api/research/${runId}`)).run.status === "cancelled", "the run to stop");
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
  });
});
