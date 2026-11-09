/**
 * The server's side of what a call asks of Muse: a thread the call makes starts on the model chosen for the voice, a
 * thread the conversation already had is loaded on its host first (a host that started again holds none, and refuses every
 * command to one) and put on that model once (and left alone when it is on it), and a switch Muse refuses is an error that
 * changes nothing. It runs through the host the voice and the task executive share, against a Muse double that keeps
 * whatever model it was last given and refuses a thread it has not loaded, the way a live host does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaStore } from "@ancilla/daemon";
import type { ExecutiveHost } from "../src/assistant/executive.js";
import { FakeConnection, start } from "./harness.js";

const SPARK = "muse-spark-1.3";
const WONDER = "muse-wonder-1.0";

/** What a Muse 1.4.7 host answers to `model/list`: its built-in list, one row, with the provider and profile on the answer. */
const BUNDLED_CATALOG = {
  models: [{ contextLimit: null, cost: null, description: null, displayLabel: SPARK, isActive: false, isDefault: false, modelId: SPARK, outputLimit: null, profileId: null, providerId: "meta", reasoningEffortVariants: [] }],
  profileId: "tbh",
  providerId: "meta",
  source: "bundledCatalog",
};

async function rig() {
  const connection = new FakeConnection();
  let hostModel = SPARK;
  let made = 0;
  connection.replies.set("model/list", BUNDLED_CATALOG);
  connection.replies.set("session/start", (params: Record<string, unknown>) => {
    hostModel = typeof params["modelId"] === "string" ? params["modelId"] : SPARK;
    return { session: { sessionId: `s${++made}`, modelId: hostModel } };
  });
  connection.replies.set("session/setModel", (params: Record<string, unknown>) => {
    hostModel = (params["model"] as { modelId: string }).modelId;
    return { ok: true };
  });
  const { server } = await start(connection);
  const host = server["assistantHost"]() as ExecutiveHost;
  const store = server["store"] as AncillaStore;
  return { connection, host, store };
}

describe("the Muse host a call thinks in, with a model chosen for the voice", () => {
  it("starts the thread on the model, names it for the call, and remembers it as the pick", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice with Vesper", modelId: WONDER });
    assert.equal(connection.of("session/start")[0]?.params?.["modelId"], WONDER, "Muse is asked to start on it");
    assert.deepEqual({ modelId: store.getSession(sessionId)?.modelId, chosen: store.getSession(sessionId)?.chosenModelId }, { modelId: WONDER, chosen: WONDER });
    assert.equal(store.getSession(sessionId)?.title, "Voice with Vesper");
  });

  it("leaves the model to Muse when none was chosen, as a task does", async () => {
    const { connection, host } = await rig();
    await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    await host.startSession({ cwd: "/work/proj", account: null, title: "Voice", modelId: null });
    for (const call of connection.of("session/start")) assert.equal("modelId" in (call.params ?? {}), false, "no model is named");
  });

  it("puts a thread that began on another model on the chosen one, once", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice", modelId: WONDER });
    await host.setModel?.(sessionId, SPARK);
    assert.equal(connection.of("session/setModel").length, 1);
    // The model is in the catalog, so the selection is the catalog's own row.
    assert.deepEqual(connection.of("session/setModel")[0]?.params?.["model"], { modelId: SPARK, providerId: "meta", profileId: null, displayLabel: SPARK });
    assert.equal(store.getSession(sessionId)?.chosenModelId, SPARK, "the voice's pick is the thread's pick");
    await host.setModel?.(sessionId, SPARK);
    assert.equal(connection.of("session/setModel").length, 1, "a thread that is on it is not asked again");
  });

  it("tries a model the list does not name, for this thread only, as the picker does", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    await host.setModel?.(sessionId, WONDER);
    assert.deepEqual(connection.of("session/setModel")[0]?.params?.["model"], { modelId: WONDER, providerId: "meta", profileId: "tbh" }, "the provider and profile of the list itself");
    assert.deepEqual({ modelId: store.getSession(sessionId)?.modelId, chosen: store.getSession(sessionId)?.chosenModelId }, { modelId: WONDER, chosen: null }, "a trial is no pick");
  });

  it("says so when Muse refuses the switch, and changes nothing", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice", modelId: SPARK });
    connection.replies.set("session/setModel", new Error("That model is not offered."));
    await assert.rejects(() => host.setModel?.(sessionId, WONDER) ?? Promise.resolve(), /not offered/);
    assert.deepEqual({ modelId: store.getSession(sessionId)?.modelId, chosen: store.getSession(sessionId)?.chosenModelId }, { modelId: SPARK, chosen: SPARK });
  });
});

/** An error as the Muse protocol client raises it: the host's words, and the kind that says what sort of refusal it was. */
class MspError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

/** A Muse double that holds only the threads it has loaded, and refuses a command to any other, as a live host does. */
async function loadingRig() {
  const connection = new FakeConnection();
  const loaded = new Set<string>();
  let made = 0;
  const hold = (params: Record<string, unknown>): string => {
    const id = String(params["sessionId"]);
    if (!loaded.has(id)) throw new MspError(`session ${id} is not loaded on this host`, "sessionNotLoaded");
    return id;
  };
  connection.replies.set("model/list", BUNDLED_CATALOG);
  connection.replies.set("session/start", (params: Record<string, unknown>) => {
    const id = `s${++made}`;
    loaded.add(id);
    return { session: { sessionId: id, modelId: typeof params["modelId"] === "string" ? params["modelId"] : SPARK } };
  });
  connection.replies.set("session/resume", (params: Record<string, unknown>) => {
    const id = String(params["sessionId"]);
    loaded.add(id);
    return { session: { sessionId: id, status: "idle", activeTurnId: null, turnCount: 1, modelId: SPARK } };
  });
  connection.replies.set("session/setModel", (params: Record<string, unknown>) => {
    hold(params);
    return { ok: true };
  });
  connection.replies.set("turn/start", (params: Record<string, unknown>) => {
    hold(params);
    return { turnId: "t1", status: "accepted" };
  });
  const { server } = await start(connection);
  const host = server["assistantHost"]() as ExecutiveHost;
  return {
    connection,
    host,
    loaded,
    /** What starting the app again does: the Muse host holds no thread, and the server has forgotten which host had which. */
    restart: () => {
      loaded.clear();
      server["sessionHosts"].clear();
    },
  };
}

const say = { text: "hello", displayText: "Voice: hello", commandId: "voice-1" };

describe("the Muse host a call thinks in, when the thread is one the conversation already had", () => {
  it("is refused every command to a thread its host does not hold, and keeps the kind of the refusal", async () => {
    const { host, restart } = await loadingRig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    restart();
    await assert.rejects(
      () => host.startTurn({ sessionId, ...say }),
      (error: Error & { kind?: string }) => error.kind === "sessionNotLoaded" && /not loaded on this host/.test(error.message),
      "this is what a call going on from this morning's conversation met",
    );
    await assert.rejects(() => host.setModel?.(sessionId, WONDER) ?? Promise.resolve(), /not loaded on this host/);
  });

  it("loads the thread as opening it does, and then the host takes the prompt and the model", async () => {
    const { connection, host, restart } = await loadingRig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    restart();
    assert.equal(await host.openSession?.(sessionId), true);
    assert.deepEqual(connection.of("session/resume").map((c) => c.params), [{ sessionId, excludeItems: true }], "one resume, without the transcript");
    assert.deepEqual(await host.startTurn({ sessionId, ...say }), { turnId: "t1" });
    await host.setModel?.(sessionId, WONDER);
    assert.equal(connection.of("session/setModel").length, 1);
  });

  it("does not load a thread that a host of this server holds already", async () => {
    const { connection, host } = await loadingRig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    assert.equal(await host.openSession?.(sessionId), true);
    assert.equal(connection.of("session/resume").length, 0, "nothing to load");
  });

  it("says the thread cannot be used when Muse no longer has it or another Muse client holds it", async () => {
    const { connection, host, restart } = await loadingRig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    restart();
    connection.replies.set("session/resume", new MspError("No such session.", "sessionNotFound"));
    assert.equal(await host.openSession?.(sessionId), false, "gone");
    connection.replies.set("session/resume", new MspError("Another Muse client has this session open.", "sessionInUse"));
    assert.equal(await host.openSession?.(sessionId), false, "held elsewhere");
    connection.replies.set("session/resume", new MspError("The host stopped.", "internal"));
    await assert.rejects(() => host.openSession?.(sessionId) ?? Promise.resolve(true), /The host stopped\./, "a host that cannot answer is not a thread that cannot be used");
  });

  it("knows no thread this server never recorded", async () => {
    const { connection, host } = await loadingRig();
    assert.equal(await host.openSession?.("not-a-thread"), false);
    assert.equal(connection.of("session/resume").length, 0);
  });
});
